import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, notFound } from '../errors.js';
import { agentExport, EXPORTABLE } from '../publish/export.js';
import { PUBLISHABLE } from '../publish/publish-job.js';
import { recallContext } from '../recall/recall.js';
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

  // ElevenLabs webhook tool, through the gateway's /v1/tools/recall_context (1 s budget).
  app.post(
    '/internal/tools/recall_context',
    {
      onRequest: app.requireInternal,
      schema: {
        body: z
          .object({
            session_id: z.string().min(1),
            query: z.string().trim().min(1),
            scope: z.enum(['session', 'workflow']).default('session'),
          })
          .passthrough(),
      },
    },
    async (request) => {
      const { session_id, query, scope } = request.body;
      const session = await opts.store.getSession(session_id);
      if (!session) throw notFound('Session not found');
      request.log = request.log.child({ session_id: session.id, org_id: session.org_id });
      return recallContext({ store: opts.store }, { session, query, scope }, request.log);
    },
  );

  // Gateway proxies `GET /v1/workmaps/:id/export` here and relays the body and headers (5 s budget).
  app.get(
    '/internal/workmaps/:id/export',
    {
      onRequest: app.requireInternal,
      schema: { params: z.object({ id: z.string().min(1) }), querystring: z.object({ format: z.enum(['agent']).default('agent') }) },
    },
    async (request, reply) => {
      const row = await opts.store.getWorkMap(request.params.id);
      if (!row) throw notFound('Work Map not found');
      request.log = request.log.child({ workmap_id: row.id, org_id: row.org_id, session_id: row.session_id });
      if (!(EXPORTABLE as readonly string[]).includes(row.status)) {
        throw new HttpError(409, 'not_confirmed', `Work Map is ${row.status}; it can be exported once the expert confirms it`);
      }
      const expert = await opts.store.getExpert(row.expert_id);
      const { filename, zip } = agentExport(row.json, expert?.display_name ?? 'the expert');
      request.log.info({ filename, bytes: zip.byteLength }, 'agent rules exported');
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(Buffer.from(zip));
    },
  );
};
