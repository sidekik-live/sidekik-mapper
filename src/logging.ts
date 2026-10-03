import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const REQUEST_ID = /^[\w.:-]{8,128}$/;

/** Accepts the caller's `x-request-id` (the gateway forwards its own) if it looks sane, otherwise makes one. */
export function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const given = req.headers['x-request-id'];
  return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
}

/** Replaces Fastify's default request logging with one line per request, without the query string. */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const line = {
      method: request.method,
      route: request.routeOptions.url ?? null,
      path: request.url.split('?')[0],
      status,
      latency_ms: Math.round(reply.elapsedTime),
    };
    if (status >= 500) request.log.error(line, 'request failed');
    else request.log.info(line, 'request completed');
  });
}
