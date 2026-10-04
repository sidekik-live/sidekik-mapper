import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/services/jobs.js';
import { memoryStore } from '../src/store/memory.js';
import type { WorkMapRow } from '../src/store/types.js';
import { buildTestApp, SECRETS, silentLog } from './helpers.js';

const row = (status: WorkMapRow['status']): WorkMapRow => ({
  id: 'wm-1',
  org_id: 'org-1',
  workflow_id: 'wf-1',
  expert_id: 'ex-1',
  session_id: 's-1',
  version: 1,
  status,
  language: 'de',
  json: {} as never,
});

async function app(status: WorkMapRow['status'] = 'confirmed') {
  const published: string[] = [];
  let release = () => {};
  const jobs = new JobRunner({ log: silentLog() });
  const a = await buildTestApp({
    store: memoryStore({ work_maps: [row(status)] }),
    jobs,
    publish: async (id) => {
      published.push(id);
      await new Promise<void>((r) => (release = r));
    },
  });
  const post = (id = 'wm-1', token: string | null = SECRETS.internal) =>
    a.inject({ method: 'POST', url: `/internal/workmaps/${id}/publish`, headers: token ? { 'x-internal-token': token } : {} });
  return { a, jobs, published, post, release: () => release() };
}

describe('POST /internal/workmaps/:id/publish', () => {
  it('queues the publish job and answers 202 with its id', async () => {
    const t = await app();
    const res = await t.post();
    expect(res.statusCode).toBe(202);
    const { job_id } = res.json() as { job_id: string };
    expect(t.jobs.get(job_id)).toMatchObject({ kind: 'publish', key: 'wm-1', workmap_id: 'wm-1', org_id: 'org-1', session_id: 's-1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.published).toEqual(['wm-1']);

    // A second request while it runs gets the same job.
    expect((await t.post()).json()).toEqual({ job_id });
    t.release();
    await t.jobs.idle();
    expect(t.jobs.get(job_id)!.status).toBe('succeeded');
    await t.a.close();
  });

  it('needs the internal token', async () => {
    const t = await app();
    expect((await t.post('wm-1', null)).statusCode).toBe(401);
    expect((await t.post('wm-1', 'wrong')).statusCode).toBe(401);
    await t.a.close();
  });

  it('answers 404 for an unknown map and 409 for one not yet confirmed', async () => {
    const t = await app('in_debrief');
    expect((await t.post('nope')).statusCode).toBe(404);
    const res = await t.post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_confirmed', message: expect.stringContaining('in_debrief') });
    expect(t.published).toEqual([]);
    await t.a.close();
  });
});
