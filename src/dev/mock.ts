// `pnpm dev:mock`: the mapper against real Redis with no teammates' services and no Supabase.
// The store is in memory, seeded with Sabine's capture session (dev/fixtures/capture_sabine.json).
// With ANTHROPIC_API_KEY set, drafts, answer patches and the teach-back come from Claude; without
// it, the draft is dev/fixtures/sabine-draft.json, answers change nothing and the teach-back is a template.
// Build with `pnpm dev:replay dev/fixtures/capture_sabine.jsonl`, then run the debrief with
// `pnpm dev:replay dev/fixtures/debrief_sabine.jsonl`.
// Brain is a stand-in (below); the gateway phase calls are logged instead of sent.
// A perception stub is added with the ticket that first calls it.
import { buildApp } from '../app.js';
import { claudeDrafter } from '../build/drafter.js';
import { D6_HAS_GAPS, stubDecider, type Decider } from '../clients/brain.js';
import { stubGateway } from '../clients/gateway.js';
import { createBus } from '../contracts/index.js';
import { loadEnv } from '../env.js';
import { plainYes } from '../debrief/driver.js';
import { claudeAnswerPatcher, noopPatcher } from '../debrief/patch.js';
import { claudeTeachbackWriter, templateTeachback } from '../debrief/teachback.js';
import { createHandlers } from '../handlers.js';
import { memoryStore } from '../store/memory.js';
import { fixtureDrafter, sabineCapture } from './fixtures.js';

const DEV_SECRET = 'dev-mock-secret-not-for-production-0000000000';
const useClaude = Boolean(process.env.ANTHROPIC_API_KEY);
const env = loadEnv({
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'unused-in-mock',
  SK_INTERNAL_TOKEN: DEV_SECRET,
  ANTHROPIC_API_KEY: 'unused-in-mock',
  BRAIN_URL: 'http://localhost:8082',
  GATEWAY_INTERNAL_URL: 'http://localhost:8080',
  PERCEPTION_URL: 'http://localhost:8081',
  LOG_LEVEL: 'debug',
  ...process.env,
});

/**
 * Brain stand-in: D6 finds gaps (every open item stays), D12 says the expert isn't done, and D8
 * confirms a plain yes ("Ja, passt.") and finds anything else unclear.
 */
const stubBrain = stubDecider({ D6: D6_HAS_GAPS, D12: { expert_signals_done: { answer: false, confidence: 0.9, p_true: 0.1 } } });
const devDecider: Decider = {
  decide: (sessionId, decisions) =>
    Promise.all(
      decisions.map(async (d) => {
        if (d.id !== 'D8') return (await stubBrain.decide(sessionId, [d]))[0]!;
        const yes = plainYes((d.state as { reply: string }).reply);
        const answer = { answer: yes ? 'confirmed' : 'unclear', confidence: 0.9 };
        return (await stubDecider({ D8: { teachback_reply: answer } }).decide(sessionId, [d]))[0]!;
      }),
    ),
};

let app: Awaited<ReturnType<typeof buildApp>>;
const bus = createBus(env.REDIS_URL, 'mapper', {
  warn: (obj, msg) => app.log.warn(obj, msg),
  error: (obj, msg) => app.log.error(obj, msg),
});

app = await buildApp({
  env,
  bus,
  handlers: createHandlers({
    store: memoryStore(sabineCapture()),
    drafter: useClaude ? claudeDrafter({ apiKey: env.ANTHROPIC_API_KEY, model: env.BUILDER_MODEL }) : fixtureDrafter(),
    bus,
    decider: devDecider,
    gateway: stubGateway((sessionId, body) => app.log.info({ session_id: sessionId, ...body }, 'stub gateway: phase')),
    patcher: useClaude ? claudeAnswerPatcher({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }) : noopPatcher,
    teachback: useClaude
      ? claudeTeachbackWriter({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL })
      : { write: async (workmap) => templateTeachback(workmap) },
  }),
  healthChecks: {
    redis: async () => {
      await bus.redis.ping();
    },
  },
  logger: { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } },
});
bus.redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis error'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });
app.log.info(
  { drafter: useClaude ? env.BUILDER_MODEL : 'fixture (dev/fixtures/sabine-draft.json)' },
  `mock ready; internal token: ${DEV_SECRET}`,
);
