import type { FastifyBaseLogger } from 'fastify';
import type { JobRunner } from '../services/jobs.js';

/**
 * The debrief driver's `onConfirmed`: queues the same publish job the HTTP route queues, on the
 * same runner, so a UI publish and this one never run twice for a map at once.
 */
export function publishOnConfirm(jobs: JobRunner, publish: (workmapId: string, log: FastifyBaseLogger) => Promise<unknown>) {
  return (workmap: { id: string; org_id: string; session_id: string }, log: FastifyBaseLogger): void => {
    const { job, deduped } = jobs.enqueue(
      'publish',
      workmap.id,
      { org_id: workmap.org_id, workmap_id: workmap.id, session_id: workmap.session_id },
      async (jobLog) => {
        await publish(workmap.id, jobLog);
      },
    );
    log.info({ job_id: job.id, deduped }, 'publish queued after confirmation');
  };
}
