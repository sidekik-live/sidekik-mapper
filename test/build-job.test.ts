import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import type { Drafter } from '../src/build/drafter.js';
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

function setup(drafter: Drafter = meteredDrafter()) {
  const store = memoryStore(sabineCapture());
  const bus = fakeBus();
  return { store, bus, build: createBuildJob({ store, drafter, bus }) };
}

describe('build job', () => {
  it("saves Sabine's draft Work Map and its open items", async () => {
    const { store, build } = setup();
    const outcome = await build(taskDone(), silentLog());
    expect(outcome.status).toBe('drafted');

    const [row] = store.data.work_maps;
    expect(row).toMatchObject({
      org_id: SABINE.org,
      workflow_id: SABINE.workflow,
      expert_id: SABINE.expert,
      session_id: SABINE.session,
      version: 1,
      status: 'draft',
      language: 'de',
    });
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
    expect(again).toMatchObject({ status: 'skipped' });
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
    expect((await build(taskDone(), silentLog())).status).toBe('drafted');
    expect(store.data.work_maps).toHaveLength(1);
  });
});
