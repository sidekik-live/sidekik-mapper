import { buildApp } from './app.js';
import { claudeDrafter } from './build/drafter.js';
import { httpDecider } from './clients/brain.js';
import { httpGateway } from './clients/gateway.js';
import { httpPerception } from './clients/perception.js';
import { claudeComparator } from './compare/compare.js';
import { createBus } from './contracts/index.js';
import { loadEnv } from './env.js';
import { claudeAnswerPatcher, claudeCorrectionPatcher } from './debrief/patch.js';
import { claudeTeachbackWriter } from './debrief/teachback.js';
import { createHandlers } from './handlers.js';
import { createPublishJob } from './publish/publish-job.js';
import { supabaseArtifacts } from './store/artifacts.js';
import { supabaseStore } from './store/supabase.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);
const store = supabaseStore(supabase);
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

let app: Awaited<ReturnType<typeof buildApp>>;
const bus = createBus(env.REDIS_URL, 'mapper', {
  warn: (obj, msg) => app.log.warn(obj, msg),
  error: (obj, msg) => app.log.error(obj, msg),
});

app = await buildApp({
  env,
  bus,
  handlers: createHandlers({
    store,
    drafter: claudeDrafter({ apiKey: env.ANTHROPIC_API_KEY, model: env.BUILDER_MODEL }),
    bus,
    decider: httpDecider(env.BRAIN_URL, env.SK_INTERNAL_TOKEN),
    gateway: httpGateway(env.GATEWAY_INTERNAL_URL, env.SK_INTERNAL_TOKEN),
    patcher: claudeAnswerPatcher({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }),
    corrector: claudeCorrectionPatcher({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }),
    teachback: claudeTeachbackWriter({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }),
  }),
  store,
  comparator: claudeComparator({ apiKey: env.ANTHROPIC_API_KEY, model: env.PATCH_MODEL }),
  publish: createPublishJob({
    store,
    bus,
    perception: httpPerception(env.PERCEPTION_URL, env.SK_INTERNAL_TOKEN),
    artifacts: supabaseArtifacts(supabase),
  }),
  healthChecks: {
    supabase: supabaseHealth(supabase),
    redis: async () => {
      await bus.redis.ping();
    },
  },
  logger: {
    level: env.LOG_LEVEL,
    ...(pretty && { transport: { target: 'pino-pretty' } }),
  },
});
// ioredis reconnects on its own; log instead of crashing on an unhandled 'error' event.
bus.redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis error'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  // Railway's private network is IPv6; `::` also accepts IPv4.
  await app.listen({ host: '::', port: env.PORT });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
