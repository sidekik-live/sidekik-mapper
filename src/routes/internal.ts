import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, notFound } from '../errors.js';
import { compareWorkMaps, type Comparator } from '../compare/compare.js';
import type { Bus } from '../contracts/index.js';
import { agentExport, EXPORTABLE } from '../publish/export.js';
import { PUBLISHABLE } from '../publish/publish-job.js';
import { recallContext } from '../recall/recall.js';
import { claudeUsageRecords, publishUsage } from '../services/usage.js';
import type { JobFn, JobRunner } from '../services/jobs.js';
import type { Store } from '../store/types.js';

export type InternalRoutesOptions = {
  store: Store;
  jobs: JobRunner;
  /** The publish job body for one Work Map. */
  publish: (workmapId: string, log: Parameters<JobFn>[0]) => Promise<unknown>;
  comparator: Comparator;
  /** For the comparison's usage records. */
  bus: Bus;
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

  // DESIGN §7 (stretch): two experts, one task. Synchronous: one Claude call, a few seconds.
  app.post(
    '/internal/workflows/:id/compare',
    {
      onRequest: app.requireInternal,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        body: z.object({ workmap_a: z.string().min(1), workmap_b: z.string().min(1) }),
      },
    },
    async (request) => {
      const { workmap_a, workmap_b } = request.body;
      if (workmap_a === workmap_b) throw new HttpError(400, 'bad_request', 'Compare two different Work Maps');
      const [a, b] = await Promise.all([opts.store.getWorkMap(workmap_a), opts.store.getWorkMap(workmap_b)]);
      if (!a || !b || a.workflow_id !== request.params.id || b.workflow_id !== request.params.id || a.org_id !== b.org_id) {
        throw notFound('Both Work Maps must exist and belong to this workflow');
      }
      request.log = request.log.child({ org_id: a.org_id, session_id: a.session_id, workflow_id: a.workflow_id });
      for (const row of [a, b]) {
        if (!(EXPORTABLE as readonly string[]).includes(row.status)) {
          throw new HttpError(409, 'not_confirmed', `Work Map ${row.id} is ${row.status}; compare confirmed maps`);
        }
      }
      const usageCtx = { org_id: a.org_id, session_id: a.session_id ?? a.id, t_ms: 0 };
      return compareWorkMaps({ store: opts.store, comparator: opts.comparator }, { a, b }, request.log, (usage) =>
        publishUsage(opts.bus, usageCtx, claudeUsageRecords(usage).records).catch((err) =>
          request.log.warn({ err }, 'usage publish failed'),
        ),
      );
    },
  );
};
