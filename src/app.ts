import Fastify, { LogController, type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { requireSharedSecret } from './auth.js';
import type { Bus } from './contracts/index.js';
import type { Env } from './env.js';
import { HttpError } from './errors.js';
import { genReqId, registerRequestLogging } from './logging.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import { internalRoutes, type InternalRoutesOptions } from './routes/internal.js';
import { startConsumers, type Handlers } from './services/consumers.js';
import { JobRunner } from './services/jobs.js';
import { VERSION } from './version.js';

export type AppDeps = {
  env: Env;
  /** Closed by the app on shutdown. */
  bus: Bus;
  handlers: Handlers;
  store: InternalRoutesOptions['store'];
  publish: InternalRoutesOptions['publish'];
  healthChecks: Record<string, HealthCheck>;
  /** Defaults to a runner logging through the app's logger. */
  jobs?: JobRunner;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(deps: AppDeps) {
  const { env } = deps;

  const logger = deps.logger ?? { level: env.LOG_LEVEL };
  const app = Fastify({
    // Every line names the service and version; Railway shows all services in one stream.
    logger:
      typeof logger === 'object' ? { ...logger, base: { service: 'sidekik-mapper', version: VERSION, pid: process.pid } } : logger,
    // registerRequestLogging writes one line per request instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'req_id' }),
    genReqId,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Request validation failed',
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: err.code ?? 'error', message: err.message });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` }),
  );

  registerRequestLogging(app);
  app.decorate('requireInternal', requireSharedSecret('x-internal-token', env.SK_INTERNAL_TOKEN));

  const jobs = deps.jobs ?? new JobRunner({ log: app.log.child({ component: 'jobs' }) });

  // Bus consumers start once the app is ready. On close: stop consuming, let running jobs finish
  // (they may still publish), then close the bus.
  let stopConsumers: (() => void) | undefined;
  app.addHook('onReady', async () => {
    stopConsumers = startConsumers({
      bus: deps.bus,
      jobs,
      handlers: deps.handlers,
      log: app.log.child({ component: 'consumers' }),
    });
  });
  app.addHook('onClose', async () => {
    stopConsumers?.();
    await jobs.close();
    await deps.bus.close();
  });

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });
  await app.register(internalRoutes, { store: deps.store, jobs, publish: deps.publish });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
