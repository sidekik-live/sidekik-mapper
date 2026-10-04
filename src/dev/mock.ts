// `pnpm dev:mock`: the mapper against real Redis with no teammates' services and no Supabase.
// The store is in memory, seeded with Sabine's capture session (dev/fixtures/capture_sabine.json).
// Drafts come from Claude when ANTHROPIC_API_KEY is set, otherwise from dev/fixtures/sabine-draft.json.
// Trigger a build with `pnpm dev:replay dev/fixtures/capture_sabine.jsonl`.
// Brain answers D6 with a fixed score; the gateway phase call is logged instead of sent.
// A perception stub is added with the ticket that first calls it.
import { buildApp } from '../app.js';
import { claudeDrafter } from '../build/drafter.js';
import { stubDecider } from '../clients/brain.js';
import { stubGateway } from '../clients/gateway.js';
import { createBus } from '../contracts/index.js';
import { loadEnv } from '../env.js';
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
    decider: stubDecider(),
    gateway: stubGateway((sessionId, body) => app.log.info({ session_id: sessionId, ...body }, 'stub gateway: phase')),
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
