import { pino, type Logger } from 'pino';
import { VERSION } from './version.js';

/**
 * The one pino logger the service, the bus and the jobs share. Every line names the service and
 * version (Railway shows all services in one stream); pretty-printed on a terminal outside production.
 */
export function createServiceLogger(level: string): Logger {
  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;
  return pino({
    level,
    base: { service: 'sidekik-mapper', version: VERSION, pid: process.pid },
    ...(pretty && { transport: { target: 'pino-pretty' } }),
  });
}
