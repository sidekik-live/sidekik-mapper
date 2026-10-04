import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider } from '../src/clients/brain.js';
import { stubGateway } from '../src/clients/gateway.js';
import { stubPerception } from '../src/clients/perception.js';
import { noopCorrector, noopPatcher } from '../src/debrief/patch.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { createHandlers } from '../src/handlers.js';
import { memorySummary, SUMMARY_MAX, updateExpertMemory } from '../src/memory/expert-memory.js';
import { createPublishJob } from '../src/publish/publish-job.js';
import { memoryArtifacts } from '../src/store/artifacts.js';
import { memoryStore } from '../src/store/memory.js';
import { fakeBus, lifecycleEvent, silentLog } from './helpers.js';

const EARLIER_ITEM = '00000000-0000-4000-8000-0000000001a1';

async function builtSabine() {
  const store = memoryStore(sabineCapture());
  const bus = fakeBus();
  await createBuildJob({ store, bus, gateway: stubGateway(), decider: stubDecider({ D6: D6_HAS_GAPS }), drafter: fixtureDrafter() })(
    { ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 },
    silentLog(),
  );
  return { store, bus, row: store.data.work_maps[0]! };
}

describe('memorySummary', () => {
  it("lists the steps with the expert's reasons for judgment calls, the rules, and what is open", async () => {
    const { row } = await builtSabine();
    const summary = memorySummary({ ...row.json, status: 'published' }, 'Sabine', 5);
    expect(summary).toBe(
      'Supplier invoice coding, as Sabine does it (Work Map v1, published).' +
        ' Steps: 1. Open the invoice and check the supplier.' +
        ' 2. Code equipment over €5,000 as capex (judgment call; why: "Das ist eine Maschine über 5.000 Euro, das ist Anlagevermögen.").' +
        ' 3. Add the asset number to capex invoices.' +
        ' 4. Hold December invoices from Kranbau (judgment call; why: "Seitdem halte ich jede Dezemberrechnung von denen an und prüfe erst auf Duplikate.").' +
        ' 5. Request a second approval for CZ01 (judgment call; why: "Ja, bei CZ01 brauchen wir immer eine zweite Freigabe, egal wie hoch der Betrag ist.").' +
        ' 6. Save the coded invoice.' +
        ' Rules: G1: Equipment over €5,000 net is always capex on cost center 0400.' +
        ' G2: No asset number, no booking on capex cost center 0400.' +
        ' G4: Hold every December invoice from Kranbau GmbH and check for duplicates.' +
        ' G5: Invoices for the Czech subsidiary always need a second approval.' +
        ' Still open: 5 questions for Sabine.',
    );
  });

  it('stays within 1,500 characters, dropping items from the end but keeping what is open', async () => {
    const { row } = await builtSabine();
    const many = { ...row.json, steps: Array.from({ length: 60 }, (_, i) => ({ ...row.json.steps[1]!, title: `Step number ${i + 1}` })) };
    const summary = memorySummary(many, 'Sabine', 1);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(summary).toMatch(/… Still open: 1 question for Sabine\.$/);
    expect(memorySummary({ ...row.json, guardrails: [] }, 'Sabine', 0)).not.toContain('Still open');
  });
});

describe('updateExpertMemory', () => {
  it("keeps the expert's unresolved items across sessions, and only theirs", async () => {
    const { store, row } = await builtSabine();
    const memory = await updateExpertMemory(
      store,
      { orgId: SABINE.org, expertId: SABINE.expert, workflowId: SABINE.workflow, workmap: row.json },
      silentLog(),
    );
    const sessionItems = store.data.open_items.filter((o) => o.work_map_id === row.id).map((o) => o.id);
    expect(new Set(memory.open_item_ids)).toEqual(new Set([EARLIER_ITEM, ...sessionItems])); // not the resolved one, not Jürgen's
    expect(store.data.expert_memory).toEqual([
      { ...memory, org_id: SABINE.org, updated_at: expect.any(String) },
    ]);
  });

  it('keeps the previous summary when there is no map, refreshing only the open items', async () => {
    const store = memoryStore({
      ...sabineCapture(),
      expert_memory: [{ expert_id: SABINE.expert, workflow_id: SABINE.workflow, summary: 'Earlier summary.', open_item_ids: [] }],
    });
    const memory = await updateExpertMemory(
      store,
      { orgId: SABINE.org, expertId: SABINE.expert, workflowId: SABINE.workflow, workmap: null },
      silentLog(),
    );
    expect(memory).toEqual({ expert_id: SABINE.expert, workflow_id: SABINE.workflow, summary: 'Earlier summary.', open_item_ids: [EARLIER_ITEM] });
  });
});

describe('when the memory is written', () => {
  it('at publish, from the published map', async () => {
    const { store, bus, row } = await builtSabine();
    row.status = 'confirmed';
    await createPublishJob({ store, bus, perception: stubPerception(), artifacts: memoryArtifacts() })(row.id, silentLog());
    expect(store.data.expert_memory[0]!.summary).toMatch(/^Supplier invoice coding, as Sabine does it \(Work Map v1, published\)\./);
  });

  it("when a capture session ends, from that session's map whatever its status", async () => {
    const { store, bus } = await builtSabine();
    const handlers = createHandlers({
      store,
      bus,
      drafter: fixtureDrafter(),
      decider: stubDecider(),
      gateway: stubGateway(),
      patcher: noopPatcher,
      corrector: noopCorrector,
      teachback: { write: async () => 'SCRIPT' },
    });
    await handlers.ended(lifecycleEvent({ event: 'ended', phase: 'debrief' }, SABINE.session), silentLog());
    expect(store.data.expert_memory[0]!.summary).toMatch(/\(Work Map v1, in debrief\)\./);
  });
});
