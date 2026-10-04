import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider } from '../src/clients/brain.js';
import { stubGateway } from '../src/clients/gateway.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { agentRules, compiledGuardrails } from '../src/publish/artifacts.js';
import { exportFilename } from '../src/publish/export.js';
import { memoryStore } from '../src/store/memory.js';
import { buildTestApp, fakeBus, lifecycleEvent, SECRETS, silentLog } from './helpers.js';

async function sabineApp(status: 'in_debrief' | 'confirmed' | 'published') {
  const store = memoryStore(sabineCapture());
  await createBuildJob({ store, bus: fakeBus(), gateway: stubGateway(), decider: stubDecider({ D6: D6_HAS_GAPS }), drafter: fixtureDrafter() })(
    { ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 },
    silentLog(),
  );
  const row = store.data.work_maps[0]!;
  row.status = status;
  const app = await buildTestApp({ store });
  const get = (id = row.id, query = '', token: string | null = SECRETS.internal) =>
    app.inject({ method: 'GET', url: `/internal/workmaps/${id}/export${query}`, headers: token ? { 'x-internal-token': token } : {} });
  return { app, row, get };
}

describe('GET /internal/workmaps/:id/export', () => {
  it('downloads a zip with AGENT_RULES.md and guardrails.jsonlogic.json, as publish writes them', async () => {
    const { app, row, get } = await sabineApp('confirmed');
    const res = await get(row.id, '?format=agent');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="supplier-invoice-coding-v1-agent-rules.zip"');

    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(files)).toEqual(['AGENT_RULES.md', 'guardrails.jsonlogic.json']);
    expect(strFromU8(files['AGENT_RULES.md']!)).toBe(agentRules(row.json, 'Sabine'));
    expect(JSON.parse(strFromU8(files['guardrails.jsonlogic.json']!))).toEqual(JSON.parse(JSON.stringify(compiledGuardrails(row.json))));
    expect((await get(row.id)).statusCode).toBe(200); // format defaults to agent
    await app.close();
  });

  it('exports a published map too, but not one still in the debrief', async () => {
    const published = await sabineApp('published');
    expect((await published.get()).statusCode).toBe(200);
    await published.app.close();

    const debrief = await sabineApp('in_debrief');
    const res = await debrief.get();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_confirmed' });
    await debrief.app.close();
  });

  it('needs the token, knows only the agent format, and 404s an unknown map', async () => {
    const { app, get } = await sabineApp('confirmed');
    expect((await get(undefined, '', null)).statusCode).toBe(401);
    expect((await get(undefined, '?format=pdf')).statusCode).toBe(400);
    expect((await get('nope')).statusCode).toBe(404);
    await app.close();
  });
});

describe('exportFilename', () => {
  it('slugs the title, accents and all', () => {
    expect(exportFilename({ title: 'Supplier invoice coding', version: 2 })).toBe('supplier-invoice-coding-v2-agent-rules.zip');
    expect(exportFilename({ title: 'Rechnungsprüfung: Größe & Kosten!', version: 1 })).toBe('rechnungsprufung-grosse-kosten-v1-agent-rules.zip');
    expect(exportFilename({ title: '—', version: 1 })).toBe('work-map-v1-agent-rules.zip');
  });
});
