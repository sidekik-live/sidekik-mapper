import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/services/jobs.js';
import { silentLog } from './helpers.js';

const ctx = { session_id: 's1', org_id: 'o1' };

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

describe('JobRunner', () => {
  it('runs a job and records its outcome', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    const ran: string[] = [];
    const { job, deduped } = jobs.enqueue('build', 's1', ctx, async () => {
      ran.push('build');
    });
    expect(deduped).toBe(false);
    expect(job).toMatchObject({ kind: 'build', key: 's1', session_id: 's1', org_id: 'o1' });
    await jobs.idle();
    expect(ran).toEqual(['build']);
    expect(jobs.get(job.id)).toMatchObject({ status: 'succeeded' });
    expect(jobs.get(job.id)?.finished_at).toBeDefined();
  });

  it('records a failure without blocking the next job for the same key', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    const failed = jobs.enqueue('build', 's1', ctx, async () => {
      throw new Error('sonnet timed out');
    }).job;
    await jobs.idle();
    const next = jobs.enqueue('build', 's1', ctx, async () => {}).job;
    await jobs.idle();
    expect(jobs.get(failed.id)).toMatchObject({ status: 'failed', error: 'sonnet timed out' });
    expect(jobs.get(next.id)).toMatchObject({ status: 'succeeded' });
  });

  it('returns the active job instead of starting a second one of the same kind and key', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    const g = gate();
    let runs = 0;
    const fn = async () => {
      runs++;
      await g.opened;
    };
    const first = jobs.enqueue('build', 's1', ctx, fn);
    await Promise.resolve();
    const second = jobs.enqueue('build', 's1', ctx, fn);
    expect(second).toEqual({ job: first.job, deduped: true });
    g.open();
    await jobs.idle();
    expect(runs).toBe(1);
  });

  it('runs jobs for one key in order and different keys concurrently', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    const g = gate();
    const order: string[] = [];
    jobs.enqueue('build', 's1', ctx, async () => {
      order.push('s1 build start');
      await g.opened;
      order.push('s1 build end');
    });
    jobs.enqueue('publish', 's1', ctx, async () => {
      order.push('s1 publish');
    });
    const other = jobs.enqueue('build', 's2', { session_id: 's2', org_id: 'o1' }, async () => {
      order.push('s2 build');
    }).job;

    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.get(other.id)?.status).toBe('succeeded');
    expect(order).toEqual(['s1 build start', 's2 build']);

    g.open();
    await jobs.idle();
    expect(order).toEqual(['s1 build start', 's2 build', 's1 build end', 's1 publish']);
  });

  it('keeps only the most recent finished jobs', async () => {
    const jobs = new JobRunner({ log: silentLog(), keep: 2 });
    const ids = [];
    for (const key of ['a', 'b', 'c']) {
      ids.push(jobs.enqueue('build', key, ctx, async () => {}).job.id);
      await jobs.idle();
    }
    expect(jobs.get(ids[0]!)).toBeUndefined();
    expect(jobs.get(ids[2]!)).toBeDefined();
  });

  it('refuses new jobs once closed and waits for running ones', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    const g = gate();
    let finished = false;
    jobs.enqueue('build', 's1', ctx, async () => {
      await g.opened;
      finished = true;
    });
    const closing = jobs.close(1000);
    expect(() => jobs.enqueue('build', 's2', ctx, async () => {})).toThrow(/closed/);
    g.open();
    await closing;
    expect(finished).toBe(true);
  });

  it('stops waiting at the close timeout', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    jobs.enqueue('build', 's1', ctx, () => new Promise(() => {}));
    await expect(jobs.close(20)).resolves.toBeUndefined();
  });
});
