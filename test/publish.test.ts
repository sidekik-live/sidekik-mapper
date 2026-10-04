import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider } from '../src/clients/brain.js';
import { stubGateway } from '../src/clients/gateway.js';
import { stubPerception, type ClipRequest, type PerceptionClient } from '../src/clients/perception.js';
import { STREAMS, WorkMapSchema, type WorkMap } from '../src/contracts/index.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { agentRules, compiledGuardrails, consequenceText } from '../src/publish/artifacts.js';
import { createPublishJob } from '../src/publish/publish-job.js';
import { memoryArtifacts } from '../src/store/artifacts.js';
import { memoryStore } from '../src/store/memory.js';
import { fakeBus, lifecycleEvent, silentLog } from './helpers.js';

/** Sabine's map, built and then confirmed (the debrief is covered elsewhere). */
async function confirmedSabine(perception?: PerceptionClient) {
  const store = memoryStore(sabineCapture());
  const bus = fakeBus();
  const build = createBuildJob({ store, bus, gateway: stubGateway(), decider: stubDecider({ D6: D6_HAS_GAPS }), drafter: fixtureDrafter() });
  await build({ ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 }, silentLog());
  const row = store.data.work_maps[0]!;
  row.status = 'confirmed';
  row.json = { ...row.json, status: 'confirmed', confirmed_turn_id: 'db-9' };

  const order: string[] = [];
  const artifacts = memoryArtifacts();
  const put = artifacts.put.bind(artifacts);
  artifacts.put = async (path, body, type) => {
    order.push(`put ${path.split('/').pop()}`);
    return put(path, body, type);
  };
  const publishEvent = bus.publish.bind(bus);
  bus.publish = async (stream, ev) => {
    if (stream === STREAMS.workmapPublished) order.push(`event (row ${store.data.work_maps[0]!.status})`);
    return publishEvent(stream, ev);
  };
  const replaceRows = store.replaceWorkMapRows.bind(store);
  store.replaceWorkMapRows = async (id, rows) => {
    order.push('rows');
    return replaceRows(id, rows);
  };
  const clips: { sessionId: string; items: ClipRequest[] }[] = [];
  const publish = createPublishJob({
    store,
    bus,
    artifacts,
    perception:
      perception ??
      stubPerception((sessionId, items) => {
        order.push('clips');
        clips.push({ sessionId, items });
      }),
  });
  return { store, bus, row, artifacts, clips, order, publish };
}

describe('publish job', () => {
  it('writes the three files, marks the map published, then announces it', async () => {
    const s = await confirmedSabine();
    const outcome = await s.publish(s.row.id, silentLog());

    const dir = `org/${SABINE.org}/${s.row.id}/v1`;
    expect(outcome.paths).toEqual([`${dir}/workmap.json`, `${dir}/AGENT_RULES.md`, `${dir}/guardrails.jsonlogic.json`]);
    expect([...s.artifacts.files.keys()]).toEqual(outcome.paths);
    expect(s.order).toEqual(['rows', 'clips', 'put workmap.json', 'put AGENT_RULES.md', 'put guardrails.jsonlogic.json', 'event (row published)']);

    const stored = WorkMapSchema.parse(JSON.parse(s.artifacts.files.get(`${dir}/workmap.json`)!.body));
    expect(stored).toMatchObject({ id: s.row.id, status: 'published', confirmed_turn_id: 'db-9' });
    expect(s.artifacts.files.get(`${dir}/AGENT_RULES.md`)!.contentType).toBe('text/markdown; charset=utf-8');
    expect(JSON.parse(s.artifacts.files.get(`${dir}/guardrails.jsonlogic.json`)!.body)).toEqual(
      JSON.parse(JSON.stringify(compiledGuardrails(stored))),
    );

    expect(s.store.data.work_maps[0]).toMatchObject({ status: 'published', published_at: expect.any(String) });
    const [event] = s.bus.published.filter((p) => p.stream === STREAMS.workmapPublished);
    expect(event!.ev).toMatchObject({
      type: 'workmap.published',
      producer: 'mapper',
      org_id: SABINE.org,
      session_id: SABINE.session,
      data: { workmap_id: s.row.id, workflow_id: SABINE.workflow, version: 1 },
    });
  });

  it('writes the normalized rows the Work Map page and the clips reference', async () => {
    const s = await confirmedSabine();
    await s.publish(s.row.id, silentLog());
    expect(s.store.data.work_map_steps.map((r) => r.id)).toEqual(s.row.json.steps.map((x) => x.id));
    expect(s.store.data.guardrails.map((r) => r.key)).toEqual(['G1', 'G2', 'G4', 'G5']);
    expect(s.store.data.step_evidence).toHaveLength(11);

    // A republish after a step was removed leaves no stale rows.
    s.store.data.work_maps[0]!.json.steps.pop();
    await s.publish(s.row.id, silentLog());
    expect(s.store.data.work_map_steps).toHaveLength(5);
    expect(s.store.data.step_evidence.every((e) => !e.step_id || s.store.data.work_map_steps.some((st) => st.id === e.step_id))).toBe(true);
  });

  it('requests one clip per step around its screen moment', async () => {
    const s = await confirmedSabine();
    const outcome = await s.publish(s.row.id, silentLog());
    expect(outcome.clips_job_id).toBe('stub-clips');
    expect(s.clips).toHaveLength(1);
    expect(s.clips[0]!.sessionId).toBe(SABINE.session);
    expect(s.clips[0]!.items).toEqual(
      s.row.json.steps.map((step) => ({ step_id: step.id, t_ms: step.screen_moment.t_ms, before_s: 6, after_s: 4 })),
    );
  });

  it('publishes without clips when perception is down', async () => {
    const s = await confirmedSabine({
      requestClips: async () => {
        throw new Error('perception unreachable');
      },
    });
    const outcome = await s.publish(s.row.id, silentLog());
    expect(outcome.clips_job_id).toBeNull();
    expect(s.store.data.work_maps[0]!.status).toBe('published');
  });

  it('indexes every step, guardrail and answer in both languages, and replaces them on republish', async () => {
    const s = await confirmedSabine();
    await s.publish(s.row.id, silentLog());
    const chunks = s.store.data.kb_chunks;
    expect(chunks.map((c) => c.kind)).toEqual([...Array(6).fill('step'), ...Array(4).fill('guardrail'), ...Array(3).fill('answer')]);
    const s2 = chunks.find((c) => c.ref_id === s.row.json.steps[1]!.id)!;
    expect(s2.content).toBe(
      'S2. Code equipment over €5,000 as capex\nRe-coded opex (4711) to capex (0400)\n' +
        'Das ist eine Maschine über 5.000 Euro, das ist Anlagevermögen.\nThis is a machine over €5,000, that\'s a fixed asset.',
    );
    expect(chunks.find((c) => c.ref_id === 'a-02')!.content).toBe(
      'Warum setzen Sie die Rechnung von Kranbau auf Halt?\n' +
        'Seitdem halte ich jede Dezemberrechnung von denen an und prüfe erst auf Duplikate.\n' +
        'Since then I hold every December invoice from them and check for duplicates first.',
    );
    expect(chunks.every((c) => c.work_map_id === s.row.id && c.workflow_id === SABINE.workflow && c.org_id === SABINE.org)).toBe(true);

    await s.publish(s.row.id, silentLog());
    expect(s.store.data.kb_chunks).toHaveLength(13);
    expect(s.bus.published.filter((p) => p.stream === STREAMS.workmapPublished)).toHaveLength(2);
  });

  it('refuses a map that is not confirmed, and one whose rules do not compile', async () => {
    const s = await confirmedSabine();
    s.row.status = 'in_debrief';
    await expect(s.publish(s.row.id, silentLog())).rejects.toThrow(/is in_debrief; only a confirmed map/);
    await expect(s.publish('nope', silentLog())).rejects.toThrow(/not found/);

    s.row.status = 'confirmed';
    s.row.json.guardrails[0]!.rule = { starts_with: [{ var: 'company_code' }, 'CZ'] };
    await expect(s.publish(s.row.id, silentLog())).rejects.toThrow(/guardrails do not compile: G1: rule does not evaluate/);
    expect(s.artifacts.files.size).toBe(0);
    expect(s.store.data.work_maps[0]!.status).toBe('confirmed');
  });
});

describe('AGENT_RULES.md', () => {
  it('has a section per step, the stop rules and the JSON-Logic', async () => {
    const { row } = await confirmedSabine();
    const md = agentRules(row.json as WorkMap, 'Sabine');
    expect(md).toMatch(/^# Supplier invoice coding: agent rules\n/);
    expect(md).toContain('captured from Sabine');
    expect(md).toContain(
      [
        '### S2. Code equipment over €5,000 as capex (judgment call)',
        '',
        '- **When:** MiniERP, invoice, field `cost_center`',
        '- **Do:** Re-coded opex (4711) to capex (0400)',
        '- **Why:** "Das ist eine Maschine über 5.000 Euro, das ist Anlagevermögen." (This is a machine over €5,000, that\'s a fixed asset.), Sabine · 00:24',
        '- **Guardrails:** G1',
      ].join('\n'),
    );
    expect(md).toContain('- **Why:** not stated'); // S6
    expect(md).toContain('## STOP and ask a human when …');
    expect(md).toContain('- **G2:** No asset number, no booking on capex cost center 0400. Then: do not save.');
    const json = /```json\n([\s\S]*?)\n```/.exec(md)![1]!;
    expect(JSON.parse(json).map((g: { key: string }) => g.key)).toEqual(['G1', 'G2', 'G4', 'G5']);
  });

  it('spells out consequences', () => {
    expect(consequenceText({ require: { cost_center: '0400' } })).toBe('set cost_center to 0400');
    expect(consequenceText({ action: 'second_approval', block: true })).toBe('do not save; get a second approval');
    expect(consequenceText({})).toBe('stop and check');
  });
});
