import type { FastifyPluginAsync } from 'fastify';

/** Resolves if the dependency is reachable; rejects otherwise. */
export type HealthCheck = () => Promise<void>;

export type HealthOptions = {
  version: string;
  checks: Record<string, HealthCheck>;
  timeoutMs?: number;
};

export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const timeoutMs = opts.timeoutMs ?? 1000;

  app.get('/healthz', async (request, reply) => {
    const entries = await Promise.all(
      Object.entries(opts.checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), timeoutMs);
          return [name, true] as const;
        } catch (err) {
          request.log.warn({ err, dep: name }, 'health check failed');
          return [name, false] as const;
        }
      }),
    );
    const deps = Object.fromEntries(entries);
    const ok = entries.every(([, up]) => up);
    return reply.code(ok ? 200 : 503).send({ ok, version: opts.version, deps });
  });
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A dependency that answers GET <url> with a 2xx. */
export function httpHealth(url: string): HealthCheck {
  return async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  };
}
