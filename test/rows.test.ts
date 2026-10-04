import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleWorkMap } from '../src/build/assemble.js';
import type { WorkMapDraft } from '../src/build/draft-schema.js';
import { gather } from '../src/build/gather.js';
import { renderInput } from '../src/build/prompt.js';
import { SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { workMapRows } from '../src/publish/rows.js';
import { memoryStore } from '../src/store/memory.js';

async function sabineRows() {
  const store = memoryStore(sabineCapture());
  const session = (await store.getSession(SABINE.session))!;
  const { input } = await gather(store, { ...session, expert_id: session.expert_id! }, renderInput);
  const draft = JSON.parse(readFileSync(new URL('../dev/fixtures/sabine-draft.json', import.meta.url), 'utf8')) as WorkMapDraft;
  const { workmap } = assembleWorkMap({ id: 'wm-1', version: 1, input, draft });
  return { workmap, rows: workMapRows({ workmap, orgId: SABINE.org, events: input.events, expert: 'Sabine' }) };
}

describe('workMapRows', () => {
  it('has a step row per step, with the reason flattened', async () => {
    const { workmap, rows } = await sabineRows();
    expect(rows.steps).toHaveLength(6);
    const s2 = workmap.steps[1]!;
    expect(rows.steps[1]).toEqual({
      id: s2.id,
      org_id: SABINE.org,
      work_map_id: 'wm-1',
      key: 'S2',
      ordinal: 2,
      title: 'Code equipment over €5,000 as capex',
      decision: 'Re-coded opex (4711) to capex (0400)',
      reason_quote: 'Das ist eine Maschine über 5.000 Euro, das ist Anlagevermögen.',
      reason_quote_en: "This is a machine over €5,000, that's a fixed asset.",
      reason_turn_id: 'tt-03',
      source_label: 'Sabine · 00:24',
      is_judgment_call: true,
      screen_moment: s2.screen_moment,
      screen_signature: s2.screen_signature,
    });
    expect(rows.steps[5]).toMatchObject({ key: 'S6', reason_quote: null, reason_turn_id: null });
  });

  it('has a guardrail row per guardrail, with the rule as JSON-Logic', async () => {
    const { workmap, rows } = await sabineRows();
    expect(rows.guardrails.map((g) => g.key)).toEqual(['G1', 'G2', 'G4', 'G5']);
    expect(rows.guardrails[0]).toMatchObject({
      id: workmap.guardrails[0]!.id,
      kind: 'threshold',
      rule_jsonlogic: workmap.guardrails[0]!.rule,
      consequence: { require: { cost_center: '0400' } },
      quote_en: 'Anything that is equipment and costs over €5,000 net is capex.',
    });
  });

  it('links every step event and guardrail evidence to her words, with keyframes', async () => {
    const { workmap, rows } = await sabineRows();
    // S1 cites three events, S2–S5 one each; S6 has no reason, so no turn to cite.
    expect(rows.evidence.filter((e) => e.step_id)).toHaveLength(7);
    expect(rows.evidence.filter((e) => e.guardrail_id)).toHaveLength(4);
    expect(rows.evidence.every((e) => e.transcript_turn_id && (e.step_id || e.guardrail_id))).toBe(true);
    expect(rows.evidence.find((e) => e.step_id === workmap.steps[1]!.id)).toEqual({
      org_id: SABINE.org,
      work_map_id: 'wm-1',
      step_id: workmap.steps[1]!.id,
      guardrail_id: null,
      screen_event_id: 'se-04',
      keyframe_id: '00000000-0000-4000-8000-000000000f02',
      clip_id: null,
      transcript_turn_id: 'tt-03',
      t_ms: 22_000,
      quote: 'Das ist eine Maschine über 5.000 Euro, das ist Anlagevermögen.',
      source_label: 'Sabine · 00:24',
    });
    expect(rows.evidence.find((e) => e.guardrail_id === workmap.guardrails[1]!.id)).toMatchObject({
      screen_event_id: 'se-05',
      keyframe_id: '00000000-0000-4000-8000-000000000f03',
      transcript_turn_id: 'tt-05',
      source_label: 'Sabine · 00:36',
    });
  });
});
