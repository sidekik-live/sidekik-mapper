// `pnpm dev:mock`: the mapper against real Redis with no teammates' services and no Supabase.
// The store is in memory, seeded with Sabine's capture session (dev/fixtures/capture_sabine.json).
// With ANTHROPIC_API_KEY set, drafts, answer patches and the teach-back come from Claude; without
// it, the draft is dev/fixtures/sabine-draft.json, answers and corrections change nothing and the
// teach-back is a template.
// Build with `pnpm dev:replay dev/fixtures/capture_sabine.jsonl`, then run the debrief with
// `pnpm dev:replay dev/fixtures/debrief_sabine.jsonl` (or debrief_sabine_correction.jsonl), and
// publish with `curl -X POST localhost:8083/internal/workmaps/<id>/publish -H 'x-internal-token: …'`
// (the id is in the "work map confirmed" log line). Published files land in dev/out/.
// Brain is a stand-in (below); the gateway phase calls are logged instead of sent.
// A perception stub is added with the ticket that first calls it.
import { buildApp } from '../app.js';
import { claudeDrafter } from '../build/drafter.js';
import { D6_HAS_GAPS, stubDecider, type Decider } from '../clients/brain.js';
import { stubGateway } from '../clients/gateway.js';
import { stubPerception } from '../clients/perception.js';
import { claudeComparator, structuralComparator } from '../compare/compare.js';
import { createBus } from '../contracts/index.js';
import { loadEnv } from '../env.js';
import { createServiceLogger } from '../logger.js';
import { redisHealth } from '../redis-health.js';
import { CaptureBuffer } from '../services/capture-buffer.js';
import { JobRunner } from '../services/jobs.js';
import { plainYes } from '../debrief/driver.js';
import { claudeAnswerPatcher, claudeCorrectionPatcher, noopCorrector, noopPatcher } from '../debrief/patch.js';
import { claudeTeachbackWriter, templateTeachback } from '../debrief/teachback.js';
import { createHandlers } from '../handlers.js';
import { publishOnConfirm } from '../publish/on-confirm.js';
import { createPublishJob } from '../publish/publish-job.js';
import { fileArtifacts } from '../store/artifacts.js';
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
 * confirms a plain yes ("Ja, passt."), reads a no or a "but" as a correction, and finds anything
 * else unclear.
 */
const stubBrain = stubDecider({ D6: D6_HAS_GAPS, D12: { expert_signals_done: { answer: false, confidence: 0.9, p_true: 0.1 } } });
const devDecider: Decider = {
  decide: (sessionId, decisions) =>
    Promise.all(
      decisions.map(async (d) => {
        if (d.id !== 'D8') return (await stubBrain.decide(sessionId, [d]))[0]!;
        const reply = (d.state as { reply: string }).reply;
        const corrected = /\b(nein|aber|falsch|nicht|no|not|but|wrong)\b/i.test(reply);
        const answer = { answer: plainYes(reply) ? 'confirmed' : corrected ? 'corrected' : 'unclear', confidence: 0.9 };
        return (await stubDecider({ D8: { teachback_reply: answer } }).decide(sessionId, [d]))[0]!;
      }),
    ),
};

const store = memoryStore(sabineCapture());
const OUT = new URL('../../dev/out/', import.meta.url).pathname;

const log = createServiceLogger(env.LOG_LEVEL);
const bus = createBus(env.REDIS_URL, 'mapper', { logger: log.child({ component: 'bus' }) });
const redis = redisHealth(env.REDIS_URL, log);

const capture = new CaptureBuffer();
const jobs = new JobRunner({ log: log.child({ component: 'jobs' }) });
const publish = createPublishJob({
  store,
  bus,
  capture,
  perception: stubPerception((sessionId, items) =>
    log.info({ session_id: sessionId, clips: items.length }, 'stub perception: clips requested'),
  ),
  artifacts: fileArtifacts(OUT),
});

const app = await buildApp({
  env,
  bus,
  handlers: createHandlers({
    capture,
    onConfirmed: publishOnConfirm(jobs, publish),
    store,
    drafter: useClaude ? claudeDrafter({ apiKey: env.ANTHROPIC_API_KEY, model: env.BUILDER_MODEL }) : fixtureDrafter(),
    bus,
    decider: devDecider,
    gateway: stubGateway((sessionId, body) => log.info({ session_id: sessionId, ...body }, 'stub gateway: phase')),
    patcher: useClaude ? claudeAnswerPatcher({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }) : noopPatcher,
    corrector: useClaude ? claudeCorrectionPatcher({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }) : noopCorrector,
    teachback: useClaude
      ? claudeTeachbackWriter({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL })
      : { write: async (workmap) => templateTeachback(workmap) },
  }),
  store,
  comparator: useClaude ? claudeComparator({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }) : structuralComparator,
  publish,
  jobs,
  healthChecks: {
    redis: redis.check,
  },
  loggerInstance: log,
});
app.addHook('onClose', redis.close);

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
