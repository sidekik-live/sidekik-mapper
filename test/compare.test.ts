import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider } from '../src/clients/brain.js';
import { stubGateway } from '../src/clients/gateway.js';
import { alignSteps } from '../src/compare/align.js';
import { claudeComparator, compareWorkMaps, structuralComparator, type Difference } from '../src/compare/compare.js';
import type { WorkMap } from '../src/contracts/index.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { memoryStore } from '../src/store/memory.js';
import type { WorkMapRow } from '../src/store/types.js';
import { buildTestApp, fakeBus, lifecycleEvent, SECRETS, silentLog } from './helpers.js';

const JURGEN = { expert: '00000000-0000-4000-8000-00000000e002', session: '00000000-0000-4000-8000-00000000d009' };

/**
 * Sabine's confirmed map, and Jürgen's: the same work, except he codes equipment to 0410, never
 * presses save as a separate step, and checks an approver list she doesn't.
 */
async function twoExperts() {
  const store = memoryStore(sabineCapture());
  await createBuildJob({ store, bus: fakeBus(), gateway: stubGateway(), decider: stubDecider({ D6: D6_HAS_GAPS }), drafter: fixtureDrafter() })(
    { ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 },
    silentLog(),
  );
  const sabine = store.data.work_maps[0]!;
  sabine.status = 'confirmed';

  const json: WorkMap = structuredClone(sabine.json);
  json.id = randomUUID();
  json.expert_id = JURGEN.expert;
  json.version = 2;
  const g1 = json.guardrails.find((g) => g.key === 'G1')!;
  g1.consequence = { require: { cost_center: '0410' } };
  g1.description = 'Equipment over €5,000 net is capex on cost center 0410.';
  json.steps.pop(); // no separate save step
  json.steps.push({
    ...json.steps[0]!,
    id: randomUUID(),
    key: 'S6',
    ordinal: 6,
    title: 'Check the approver list',
    guardrail_ids: [],
    screen_signature: { app: 'MiniERP', record_kind: 'approvers' },
  });
  const jurgen: WorkMapRow = { ...sabine, id: json.id, expert_id: JURGEN.expert, session_id: JURGEN.session, version: 2, status: 'published', json };
  store.data.work_maps.push(jurgen);
  return { store, sabine, jurgen };
}

describe('alignSteps', () => {
  it('pairs steps on the same screen and lists the ones only one expert does', async () => {
    const { sabine, jurgen } = await twoExperts();
    const { pairs, onlyA, onlyB } = alignSteps(sabine.json, jurgen.json);
    expect(pairs.map((p) => [p.a.key, p.b.key])).toEqual([
      ['S1', 'S1'],
      ['S2', 'S2'],
      ['S3', 'S3'],
      ['S4', 'S4'],
      ['S5', 'S5'],
    ]);
    expect(onlyA.map((s) => s.title)).toEqual(['Save the coded invoice']);
    expect(onlyB.map((s) => s.title)).toEqual(['Check the approver list']);
  });
});

describe('structuralComparator', () => {
  it('finds steps only one expert does and the rule they disagree on', async () => {
    const { sabine, jurgen } = await twoExperts();
    const diffs = await structuralComparator.differences(
      { a: sabine.json, b: jurgen.json, alignment: alignSteps(sabine.json, jurgen.json), experts: { a: 'Sabine', b: 'Jürgen' } },
      silentLog(),
      async () => {},
    );
    expect(diffs.map((d) => [d.kind, d.step_key_a ?? d.guardrail_key_a, d.step_key_b ?? d.guardrail_key_b])).toEqual([
      ['step_only_in_a', 'S6', null],
      ['step_only_in_b', null, 'S6'],
      ['guardrail', 'G1', 'G1'],
    ]);
    expect(diffs[2]!.question_for_a).toBe(
      'Jürgen\'s rule is "Equipment over €5,000 net is capex on cost center 0410." Yours is "Equipment over €5,000 net is always capex on cost center 0400." Which is right, and why?',
    );
  });
});

describe('compareWorkMaps', () => {
  it("asks each expert about every difference in their next debrief, once", async () => {
    const { store, sabine, jurgen } = await twoExperts();
    const out = await compareWorkMaps({ store, comparator: structuralComparator }, { a: sabine, b: jurgen }, silentLog());
    expect(out).toMatchObject({ open_items_created: 6 });

    const forSabine = store.data.open_items.filter((o) => o.work_map_id === sabine.id && o.text.includes('Jürgen'));
    expect(forSabine).toHaveLength(3);
    expect(forSabine.every((o) => o.session_id === SABINE.session && o.importance === 3 && o.status === 'open')).toBe(true);
    expect(forSabine.find((o) => o.text.startsWith('Jürgen doesn\'t do "Save'))!.anchor_t_ms).toBe(42_000);

    // Jürgen's next session on the workflow carries them over.
    const carried = await store.listCarriedOverOpenItems(SABINE.workflow, JURGEN.expert, 'next-session');
    expect(carried.filter((o) => o.text.includes('Sabine'))).toHaveLength(3);

    expect((await compareWorkMaps({ store, comparator: structuralComparator }, { a: sabine, b: jurgen }, silentLog())).open_items_created).toBe(0);
  });

  it('asks Claude for differences in substance, with the aligned steps', async () => {
    const { store, sabine, jurgen } = await twoExperts();
    const diff: Difference = {
      kind: 'decision',
      step_key_a: 'S2',
      step_key_b: 'S2',
      guardrail_key_a: 'G1',
      guardrail_key_b: 'G1',
      summary: 'Sabine codes equipment over €5,000 to 0400, Jürgen to 0410.',
      question_for_a: 'Jürgen codes equipment over €5,000 to 0410; you code it to 0400. Why?',
      question_for_b: 'Sabine codes equipment over €5,000 to 0400; you code it to 0410. Why?',
    };
    const requests: { messages: { content: string }[] }[] = [];
    const client = {
      beta: {
        messages: {
          create: async (body: { messages: { content: string }[] }) => {
            requests.push(body);
            return {
              model: 'claude-sonnet-5-5',
              stop_reason: 'end_turn',
              stop_details: null,
              content: [{ type: 'text', text: JSON.stringify({ differences: [diff] }) }],
              usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            };
          },
        },
      },
    } as unknown as Anthropic;
    const out = await compareWorkMaps({ store, comparator: claudeComparator({ model: 'claude-sonnet-5-5', client }) }, { a: sabine, b: jurgen }, silentLog());
    expect(out.differences).toEqual([diff]);
    expect(requests[0]!.messages[0]!.content).toContain('"screen":"minierp / invoice / cost_center"');
    expect(store.data.open_items.find((o) => o.text === diff.question_for_b)).toMatchObject({ work_map_id: jurgen.id, anchor_t_ms: 22_000 });
  });
});

describe('POST /internal/workflows/:id/compare', () => {
  it('compares two confirmed maps of the workflow', async () => {
    const { store, sabine, jurgen } = await twoExperts();
    const app = await buildTestApp({ store, comparator: structuralComparator });
    const post = (body: object, workflow = SABINE.workflow, token: string | null = SECRETS.internal) =>
      app.inject({ method: 'POST', url: `/internal/workflows/${workflow}/compare`, payload: body, headers: token ? { 'x-internal-token': token } : {} });

    const ok = await post({ workmap_a: sabine.id, workmap_b: jurgen.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ open_items_created: 6, differences: expect.any(Array) });
    expect((await post({ workmap_a: sabine.id, workmap_b: sabine.id })).statusCode).toBe(400);
    expect((await post({ workmap_a: sabine.id, workmap_b: jurgen.id }, 'other-workflow')).statusCode).toBe(404);
    expect((await post({ workmap_a: sabine.id, workmap_b: jurgen.id }, SABINE.workflow, null)).statusCode).toBe(401);
    sabine.status = 'in_debrief';
    expect((await post({ workmap_a: sabine.id, workmap_b: jurgen.id })).statusCode).toBe(409);
    await app.close();
  });
});
