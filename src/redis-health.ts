import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { HealthCheck } from './routes/health.js';

/**
 * A small Redis client of its own for /healthz: the platform bus doesn't expose its connections.
 * It fails fast (one try, no offline queue), so a down Redis shows as a failed check.
 */
export function redisHealth(url: string, log: Logger): { check: HealthCheck; close: () => Promise<void> } {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  // ioredis reconnects on its own; log instead of an unhandled 'error' event.
  redis.on('error', (err) => log.warn({ err: err.message }, 'redis health client error'));
  return {
    check: async () => {
      if (redis.status === 'wait') await redis.connect();
      await redis.ping();
    },
    close: async () => {
      redis.disconnect();
    },
  };
}
