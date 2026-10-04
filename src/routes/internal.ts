import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, notFound } from '../errors.js';
import { PUBLISHABLE } from '../publish/publish-job.js';
import type { JobFn, JobRunner } from '../services/jobs.js';
import type { Store } from '../store/types.js';

export type InternalRoutesOptions = {
  store: Store;
  jobs: JobRunner;
  /** The publish job body for one Work Map. */
  publish: (workmapId: string, log: Parameters<JobFn>[0]) => Promise<unknown>;
};

/** Service-to-service routes; every one needs `X-Internal-Token`. */
export const internalRoutes: FastifyPluginAsync<InternalRoutesOptions> = async (base, opts) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  // Gateway proxies `POST /v1/workmaps/:id/publish` here (1 s budget): queue the job, answer 202.
  app.post(
    '/internal/workmaps/:id/publish',
    { onRequest: app.requireInternal, schema: { params: z.object({ id: z.string().min(1) }) } },
    async (request, reply) => {
      const row = await opts.store.getWorkMap(request.params.id);
      if (!row) throw notFound('Work Map not found');
      request.log = request.log.child({ workmap_id: row.id, org_id: row.org_id, session_id: row.session_id });
      if (!(PUBLISHABLE as readonly string[]).includes(row.status)) {
        throw new HttpError(409, 'not_confirmed', `Work Map is ${row.status}; it can be published once the expert confirms it`);
      }
      const { job, deduped } = opts.jobs.enqueue(
        'publish',
        row.id,
        { org_id: row.org_id, workmap_id: row.id, ...(row.session_id && { session_id: row.session_id }) },
        async (log) => {
          await opts.publish(row.id, log);
        },
      );
      request.log.info({ job_id: job.id, deduped }, deduped ? 'publish already running' : 'publish queued');
      return reply.code(202).send({ job_id: job.id });
    },
  );
};
