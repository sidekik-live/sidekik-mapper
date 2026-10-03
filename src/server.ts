import { buildApp } from './app.js';
import { createBus } from './contracts/index.js';
import { loadEnv } from './env.js';
import { pendingHandlers } from './handlers.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

let app: Awaited<ReturnType<typeof buildApp>>;
const bus = createBus(env.REDIS_URL, 'mapper', {
  warn: (obj, msg) => app.log.warn(obj, msg),
  error: (obj, msg) => app.log.error(obj, msg),
});

app = await buildApp({
  env,
  bus,
  handlers: pendingHandlers,
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
