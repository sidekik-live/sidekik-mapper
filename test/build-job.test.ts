import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import type { Drafter } from '../src/build/drafter.js';
import { D6_FULLY_SPECIFIC, stubDecider } from '../src/clients/brain.js';
import { stubGateway, type GatewayClient, type PhaseRequest } from '../src/clients/gateway.js';
import { UpstreamError } from '../src/clients/internal-http.js';
import { STREAMS, WorkMapSchema, type UsageRecord } from '../src/contracts/index.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { memoryStore } from '../src/store/memory.js';
import { fakeBus, lifecycleEvent, silentLog } from './helpers.js';

const taskDone = (sessionId = SABINE.session) =>
  ({ ...lifecycleEvent({ event: 'task_done', phase: 'building' }, sessionId), t_ms: 145_000 });

/** The fixture draft, reporting usage the way the Claude drafter does. */
const meteredDrafter = (model = 'claude-sonnet-5-5'): Drafter => {
  const inner = fixtureDrafter();
  return {
    async draft(input, log, onUsage) {
      await onUsage({ model, input_tokens: 20_000, output_tokens: 4_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
      return inner.draft(input, log, onUsage);
    },
  };
};

function setup(drafter: Drafter = meteredDrafter(), decider = stubDecider()) {
  const store = memoryStore(sabineCapture());
  const bus = fakeBus();
  const phases: { sessionId: string; body: PhaseRequest }[] = [];
  const gateway: GatewayClient & { fail?: Error } = {
    async setPhase(sessionId, body) {
      if (gateway.fail) throw gateway.fail;
      return stubGateway((id, b) => phases.push({ sessionId: id, body: b })).setPhase(sessionId, body);
    },
  };
  return { store, bus, phases, gateway, build: createBuildJob({ store, drafter, bus, decider, gateway }) };
}

describe('build job', () => {
  it("saves Sabine's Work Map in debrief with its open items", async () => {
    const { store, build } = setup();
    const outcome = await build(taskDone(), silentLog());
    expect(outcome.status).toBe('handed_over');

    const [row] = store.data.work_maps;
    expect(row).toMatchObject({
      org_id: SABINE.org,
      workflow_id: SABINE.workflow,
      expert_id: SABINE.expert,
      session_id: SABINE.session,
      version: 1,
      status: 'in_debrief',
      language: 'de',
    });
    expect(row!.json.status).toBe('in_debrief');
    expect(WorkMapSchema.parse(row!.json)).toEqual(row!.json);
    expect(row!.json.steps).toHaveLength(6);
    expect(row!.json.steps.filter((s) => s.is_judgment_call)).toHaveLength(3);
    expect(row!.json.guardrails.map((g) => g.key)).toEqual(['G1', 'G2', 'G4', 'G5']);

    const fresh = store.data.open_items.filter((o) => o.work_map_id === row!.id);
    expect(fresh.map((o) => o.importance)).toEqual([3, 2, 2, 1]);
    expect(fresh.map((o) => o.id)).toEqual(row!.json.open_items.map((o) => o.id));
  });

  it('publishes the Claude usage for the cost ledger', async () => {
    const { bus, build } = setup();
    await build(taskDone(), silentLog());
    const usage = bus.published.filter((p) => p.stream === STREAMS.usage);
    expect(usage.map((p) => p.ev.data)).toEqual<UsageRecord[]>([
      { service: 'mapper', vendor: 'anthropic', unit: 'tokens_in', units: 20_000, cost_usd: 0.04 },
      { service: 'mapper', vendor: 'anthropic', unit: 'tokens_out', units: 4_000, cost_usd: 0.04 },
    ]);
    expect(usage[0]!.ev).toMatchObject({ type: 'usage', producer: 'mapper', session_id: SABINE.session, t_ms: 145_000 });
  });

  it('drafts once per session, even if task_done arrives again', async () => {
    const { store, build } = setup();
    await build(taskDone(), silentLog());
    const again = await build(taskDone(), silentLog());
    expect(again).toMatchObject({ status: 'skipped', reason: expect.stringContaining('already in_debrief') });
    expect(store.data.work_maps).toHaveLength(1);
  });

  it('takes the next version of the workflow', async () => {
    const { store, build } = setup();
    const earlier = { ...store.data.sessions[1]! };
    store.data.work_maps.push({
      id: 'wm-earlier',
      org_id: SABINE.org,
      workflow_id: SABINE.workflow,
      expert_id: SABINE.expert,
      session_id: earlier.id,
      version: 3,
      status: 'published',
      language: 'de',
      json: {} as never,
    });
    await build(taskDone(), silentLog());
    expect(store.data.work_maps.find((m) => m.session_id === SABINE.session)!.version).toBe(4);
  });

  it('skips replay sessions and fails clearly on a session it cannot find', async () => {
    const { store, build } = setup();
    store.data.sessions[0]!.mode = 'replay';
    expect(await build(taskDone(), silentLog())).toMatchObject({ status: 'skipped' });
    await expect(build(taskDone('00000000-0000-4000-8000-0000000000ff'), silentLog())).rejects.toThrow(/not found/);
  });

  it('refuses to draft from a session with nothing on record', async () => {
    const { store, build } = setup();
    store.data.transcript_turns = [];
    await expect(build(taskDone(), silentLog())).rejects.toThrow(/nothing to draft from/);
    expect(store.data.work_maps).toHaveLength(0);
  });

  it('still saves the draft when publishing usage fails', async () => {
    const { store, bus, build } = setup();
    bus.publish = async () => {
      throw new Error('redis down');
    };
    expect((await build(taskDone(), silentLog())).status).toBe('handed_over');
    expect(store.data.work_maps).toHaveLength(1);
  });

  it('starts the debrief with the top open items and the prior summary', async () => {
    const { store, phases, build } = setup();
    store.data.expert_memory.push({ expert_id: SABINE.expert, workflow_id: SABINE.workflow, summary: 'Codes invoices for DE01 and CZ01.', open_item_ids: [] });
    await build(taskDone(), silentLog());
    expect(phases).toHaveLength(1);
    expect(phases[0]!.sessionId).toBe(SABINE.session);
    const body = phases[0]!.body as Extract<PhaseRequest, { phase: 'debrief' }>;
    expect(body.phase).toBe('debrief');
    expect(body.dynamic_variables.prior_summary).toBe('Codes invoices for DE01 and CZ01.');
    expect(body.dynamic_variables.open_items!.split('\n')).toEqual([
      "1. Before booking an invoice from a supplier you don't know, do you always ask the controller first, and how do you tell the supplier is unknown?",
      "2. What do you do when the asset number hasn't been assigned yet?",
      '3. From what amount does a DE01 invoice need a second approval?',
      '4. Who is the controller you ask about unknown suppliers?',
    ]);
  });

  it('reports the G1–G5 demo cases for the validated map', async () => {
    const { build } = setup();
    const outcome = await build(taskDone(), silentLog());
    if (outcome.status !== 'handed_over') throw new Error('expected a handover');
    expect(outcome.issues).toEqual([]);
    expect(outcome.demo.filter((d) => !d.pass).map((d) => d.rule)).toEqual(['G3', 'G1+G3']);
  });

  it('drops open items whose explanation D6 finds complete, keeping at least three', async () => {
    const { store, build } = setup(meteredDrafter(), stubDecider({ D6: D6_FULLY_SPECIFIC }));
    await build(taskDone(), silentLog());
    const row = store.data.work_maps[0]!;
    expect(row.json.open_items.map((o) => o.text)).toHaveLength(3);
    expect(row.json.open_items.map((o) => o.text)).not.toContain('Who is the controller you ask about unknown suppliers?');
    expect(store.data.open_items.filter((o) => o.work_map_id === row.id)).toHaveLength(3);
  });

  it('keeps every open item when brain is unreachable', async () => {
    const { store, build } = setup(meteredDrafter(), {
      decide: async () => {
        throw new UpstreamError('/internal/decide', null, '/internal/decide unreachable');
      },
    });
    expect((await build(taskDone(), silentLog())).status).toBe('handed_over');
    expect(store.data.work_maps[0]!.json.open_items).toHaveLength(4);
  });

  it('goes back to draft when the gateway fails, and resumes without drafting again', async () => {
    let drafts = 0;
    const counting: Drafter = {
      async draft(input, log, onUsage) {
        drafts++;
        return meteredDrafter().draft(input, log, onUsage);
      },
    };
    const { store, gateway, phases, build } = setup(counting);
    gateway.fail = new UpstreamError('/internal/sessions/x/phase', 503, 'gateway returned 503');
    await expect(build(taskDone(), silentLog())).rejects.toThrow('503');
    expect(store.data.work_maps[0]).toMatchObject({ status: 'draft' });
    expect(store.data.work_maps[0]!.json.status).toBe('draft');

    gateway.fail = undefined;
    expect((await build(taskDone(), silentLog())).status).toBe('handed_over');
    expect(drafts).toBe(1);
    expect(phases).toHaveLength(1);
    expect(store.data.work_maps).toHaveLength(1);
    expect(store.data.work_maps[0]!.status).toBe('in_debrief');
    expect(store.data.open_items.filter((o) => o.work_map_id === store.data.work_maps[0]!.id)).toHaveLength(4);
  });
});
