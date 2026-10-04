import type { FastifyBaseLogger } from 'fastify';
import { newId } from '../contracts/index.js';

export type JobKind = 'build' | 'publish';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** Log fields every line of a job carries (ARCHITECTURE §10). */
export type JobContext = { session_id?: string; org_id: string; workmap_id?: string };

export type Job = JobContext & {
  id: string;
  kind: JobKind;
  key: string;
  status: JobStatus;
  error?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
};

export type JobFn = (log: FastifyBaseLogger) => Promise<void>;

export type JobRunnerOptions = {
  log: FastifyBaseLogger;
  /** Finished jobs kept for status lookups; the oldest are dropped first. */
  keep?: number;
};

/**
 * In-process job queue. Jobs with the same key (a session or a Work Map) run one at a time, in
 * arrival order; different keys run concurrently. Enqueuing a kind+key that is already queued or
 * running returns that job instead of starting another, so a redelivered `task_done` builds once.
 * Jobs live in memory: a restart loses queued and running jobs.
 */
export class JobRunner {
  private readonly log: FastifyBaseLogger;
  private readonly keep: number;
  private readonly jobs = new Map<string, Job>();
  private readonly active = new Map<string, Job>();
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(opts: JobRunnerOptions) {
    this.log = opts.log;
    this.keep = opts.keep ?? 500;
  }

  enqueue(kind: JobKind, key: string, ctx: JobContext, fn: JobFn): { job: Job; deduped: boolean } {
    if (this.closed) throw new Error('job runner is closed');
    const activeKey = `${kind}:${key}`;
    const existing = this.active.get(activeKey);
    if (existing) return { job: existing, deduped: true };

    const job: Job = { ...ctx, id: newId(), kind, key, status: 'queued', created_at: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.active.set(activeKey, job);
    this.trim();

    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.run(job, fn)).finally(() => {
      this.active.delete(activeKey);
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    this.tails.set(key, next);
    return { job, deduped: false };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Resolves once nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values());
  }

  /** Stops accepting jobs and waits up to `timeoutMs` for the ones already queued. */
  async close(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([this.idle(), timeout]).finally(() => clearTimeout(timer));
    if (result === 'timeout') {
      this.log.warn({ unfinished: [...this.active.values()].map((j) => j.id) }, 'jobs still running at shutdown');
    }
  }

  private async run(job: Job, fn: JobFn): Promise<void> {
    const { session_id, org_id, workmap_id } = job;
    const log = this.log.child({ job_id: job.id, job_kind: job.kind, session_id, org_id, workmap_id });
    const started = Date.now();
    job.status = 'running';
    job.started_at = new Date(started).toISOString();
    log.info('job started');
    try {
      await fn(log);
      job.status = 'succeeded';
      log.info({ latency_ms: Date.now() - started }, 'job succeeded');
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      log.error({ err, latency_ms: Date.now() - started }, 'job failed');
    } finally {
      job.finished_at = new Date().toISOString();
    }
  }

  private trim(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.keep) return;
      if (job.status === 'succeeded' || job.status === 'failed') this.jobs.delete(id);
    }
  }
}
