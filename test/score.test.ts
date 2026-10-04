import { describe, expect, it } from 'vitest';
import { scoreOpenItems } from '../src/build/score.js';
import { D6_FULLY_SPECIFIC, D6_HAS_GAPS, type Decider } from '../src/clients/brain.js';
import type { DecisionResult, QuestionAnswer } from '../src/contracts/index.js';
import type { OpenItemRow, TranscriptTurnRow } from '../src/store/types.js';
import { silentLog } from './helpers.js';

const item = (text: string, importance: number, anchor_t_ms: number | null): OpenItemRow => ({
  id: text,
  org_id: 'o',
  workflow_id: 'w',
  work_map_id: 'wm',
  session_id: 's',
  text,
  anchor_t_ms,
  origin: 'builder',
  status: 'open',
  importance,
});

const turn = (turn_id: string, t_ms: number, text: string): TranscriptTurnRow => ({
  session_id: 's',
  turn_id,
  role: 'user',
  text_redacted: text,
  lang: 'de',
  t_ms,
  off_record: false,
});

const turns = [
  turn('t1', 10_000, 'Das geht auf 0400.'),
  turn('t2', 22_000, 'Weil es Anlagevermögen ist.'),
  turn('t3', 100_000, 'Frag den Controller.'),
];

// a, b, c anchored near the first two turns; d near t3; e has no anchor.
const items = [item('a', 3, 12_000), item('b', 3, 15_000), item('c', 2, 20_000), item('d', 2, 100_000), item('e', 1, null)];

/** Answers D6 per call with the given per-question answers, recording each request. */
function decider(perItem: Record<string, QuestionAnswer>[]) {
  const calls: { id: string; state: unknown }[][] = [];
  const d: Decider = {
    async decide(_sid, decisions) {
      calls.push(decisions);
      return decisions.map(
        (dec, i): DecisionResult => ({
          id: dec.id,
          answer: perItem[i]!.specificity!.answer,
          confidence: perItem[i]!.specificity!.confidence,
          provider: 'jev',
          escalated: false,
          latency_ms: 5,
          answers: perItem[i],
        }),
      );
    },
  };
  return { d, calls };
}

describe('scoreOpenItems', () => {
  it("rates the expert's words around each anchored item, never unanchored ones", async () => {
    const { d, calls } = decider([D6_HAS_GAPS, D6_HAS_GAPS, D6_HAS_GAPS, D6_HAS_GAPS]);
    await scoreOpenItems(d, 's', items, turns, silentLog());
    expect(calls[0]!.map((c) => c.id)).toEqual(['D6', 'D6', 'D6', 'D6']);
    expect(calls[0]!.map((c) => c.state)).toEqual([
      { explanation: 'Das geht auf 0400. Weil es Anlagevermögen ist.', open_item: 'a' },
      { explanation: 'Das geht auf 0400. Weil es Anlagevermögen ist.', open_item: 'b' },
      { explanation: 'Das geht auf 0400. Weil es Anlagevermögen ist.', open_item: 'c' },
      { explanation: 'Frag den Controller.', open_item: 'd' },
    ]);
  });

  it('drops only items whose explanation is fully specific and names everything', async () => {
    const unknownEntity = { ...D6_FULLY_SPECIFIC, refers_to_unknown_entity: { answer: true, confidence: 0.9, p_true: 0.9 } };
    const { d } = decider([D6_HAS_GAPS, D6_FULLY_SPECIFIC, D6_FULLY_SPECIFIC, unknownEntity]);
    const { kept, dropped } = await scoreOpenItems(d, 's', items, turns, silentLog());
    expect(dropped.map((o) => o.text)).toEqual(['b', 'c']);
    expect(kept.map((o) => o.text)).toEqual(['a', 'd', 'e']);
  });

  it('keeps items brain is unsure about, or answers without per-question answers', async () => {
    const unsure = { ...D6_FULLY_SPECIFIC, specificity: { answer: 4, confidence: 0.7 } };
    const maybeEntity = { ...D6_FULLY_SPECIFIC, refers_to_unknown_entity: { answer: false, confidence: 0.6, p_true: 0.4 } };
    const { d } = decider([unsure, maybeEntity, D6_FULLY_SPECIFIC, D6_HAS_GAPS]);
    const legacy: Decider = {
      async decide(sid, decisions) {
        return (await d.decide(sid, decisions)).map(({ answers: _a, ...r }) => r);
      },
    };
    expect((await scoreOpenItems(d, 's', items, turns, silentLog())).dropped.map((o) => o.text)).toEqual(['c']);
    expect((await scoreOpenItems(legacy, 's', items, turns, silentLog())).dropped).toEqual([]);
  });

  it('never goes below three items, dropping the least important trivial ones first', async () => {
    const { d } = decider([D6_FULLY_SPECIFIC, D6_FULLY_SPECIFIC, D6_FULLY_SPECIFIC, D6_FULLY_SPECIFIC]);
    const { kept } = await scoreOpenItems(d, 's', items, turns, silentLog());
    expect(kept.map((o) => o.text)).toEqual(['a', 'b', 'e']);
  });

  it('does not call brain for three items or fewer, or when nothing is anchored', async () => {
    const { d, calls } = decider([]);
    expect((await scoreOpenItems(d, 's', items.slice(0, 3), turns, silentLog())).kept).toHaveLength(3);
    const unanchored = items.map((o) => ({ ...o, anchor_t_ms: null }));
    expect((await scoreOpenItems(d, 's', unanchored, turns, silentLog())).kept).toHaveLength(5);
    expect(calls).toHaveLength(0);
  });

  it('keeps every item when brain fails', async () => {
    const failing: Decider = {
      decide: async () => {
        throw new Error('timed out');
      },
    };
    expect((await scoreOpenItems(failing, 's', items, turns, silentLog())).kept).toHaveLength(5);
  });
});
