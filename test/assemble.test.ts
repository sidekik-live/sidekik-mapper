import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleWorkMap } from '../src/build/assemble.js';
import type { WorkMapDraft } from '../src/build/draft-schema.js';
import { gather } from '../src/build/gather.js';
import { renderInput } from '../src/build/prompt.js';
import { WorkMapSchema } from '../src/contracts/index.js';
import { SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { memoryStore } from '../src/store/memory.js';

/** The platform's WorkMapSchema requires a UUID id. */
const WM = '00000000-0000-4000-8000-0000000000aa';

const sabineDraft = (): WorkMapDraft =>
  JSON.parse(readFileSync(new URL('../dev/fixtures/sabine-draft.json', import.meta.url), 'utf8')) as WorkMapDraft;

async function sabineInput() {
  const store = memoryStore(sabineCapture());
  const session = (await store.getSession(SABINE.session))!;
  return (await gather(store, { ...session, expert_id: session.expert_id! }, renderInput)).input;
}

let n = 0;
const seqId = () => `id-${++n}`;

describe('assembleWorkMap', () => {
  it('produces a contract-valid draft Work Map with no warnings', async () => {
    const { workmap, warnings } = assembleWorkMap({ id: WM, version: 1, input: await sabineInput(), draft: sabineDraft() });
    expect(warnings).toEqual([]);
    expect(WorkMapSchema.parse(workmap)).toEqual(workmap);
    expect(workmap).toMatchObject({ id: WM, version: 1, status: 'draft', language: 'de', expert_id: SABINE.expert });
    expect(workmap.steps.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('resolves guardrail keys to the guardrails’ ids', async () => {
    const { workmap } = assembleWorkMap({ id: WM, version: 1, input: await sabineInput(), draft: sabineDraft() });
    const g1 = workmap.guardrails.find((g) => g.key === 'G1')!;
    expect(workmap.steps.find((s) => s.key === 'S2')!.guardrail_ids).toEqual([g1.id]);
    expect(g1.rule).toEqual({
      and: [{ '>': [{ var: 'net_amount' }, 5000] }, { '==': [{ var: 'category' }, 'equipment'] }, { '!=': [{ var: 'cost_center' }, '0400'] }],
    });
    expect(g1.consequence).toEqual({ require: { cost_center: '0400' } });
    expect(workmap.guardrails.find((g) => g.key === 'G2')!.consequence).toEqual({ block: true });
  });

  it('takes times, keyframes and source labels from the session, not the model', async () => {
    const { workmap } = assembleWorkMap({ id: WM, version: 1, input: await sabineInput(), draft: sabineDraft() });
    const s2 = workmap.steps.find((s) => s.key === 'S2')!;
    expect(s2.screen_moment.t_ms).toBe(22_000);
    expect(s2.reason).toMatchObject({ turn_id: 'tt-03', source_label: 'Sabine · 00:24' });
    expect(workmap.steps.find((s) => s.key === 'S1')!.screen_moment.t_ms).toBe(5_000); // earliest of three events
    expect(workmap.guardrails.find((g) => g.key === 'G1')!.evidence).toEqual([
      { event_id: 'se-04', keyframe_id: '00000000-0000-4000-8000-000000000f02', turn_id: 'tt-04', t_ms: 22_000 },
    ]);
  });

  it('orders open items by importance and maps their origin', async () => {
    const { workmap, openItems } = assembleWorkMap({ id: WM, version: 1, input: await sabineInput(), draft: sabineDraft() });
    expect(openItems.map((o) => [o.importance, o.origin, o.anchor_t_ms])).toEqual([
      [3, 'builder', 120_000],
      [2, 'live', 36_000], // unasked brain question, anchored to se-05
      [2, 'live', null], // carried over: keeps the earlier item's origin
      [1, 'live', 120_000],
    ]);
    expect(openItems.every((o) => o.work_map_id === WM && o.status === 'open' && o.session_id === SABINE.session)).toBe(true);
    expect(workmap.open_items.map((o) => o.id)).toEqual(openItems.map((o) => o.id));
    expect(workmap.open_items[2]).not.toHaveProperty('anchor_t_ms');
  });

  it('reports references the input does not contain', async () => {
    const draft = sabineDraft();
    draft.steps[1]!.screen_moment.event_ids = ['se-99'];
    draft.steps[1]!.guardrail_keys = ['G1', 'G9'];
    draft.steps[2]!.reason!.turn_id = 'tt-11'; // off the record, so not in the input
    draft.guardrails[0]!.evidence = [{ event_id: 'se-14', turn_id: 'tt-04' }];
    const { workmap, warnings } = assembleWorkMap({ id: WM, version: 1, input: await sabineInput(), draft, newId: seqId });
    expect(warnings).toEqual([
      'step S2: unknown event_id se-99',
      'step S2: no screen event',
      'step S2: unknown guardrail G9',
      'step S3: unknown turn_id tt-11',
      'guardrail G1: unknown event_id se-14',
    ]);
    expect(workmap.steps[1]!.guardrail_ids).toHaveLength(1);
  });
});
