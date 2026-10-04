import type { Step, WorkMap } from '../contracts/index.js';

/** Steps the experts do on the same screen: same app, record kind and field (DESIGN §7). */
export type StepPair = { signature: string; a: Step; b: Step };
export type Alignment = { pairs: StepPair[]; onlyA: Step[]; onlyB: Step[] };

export const signatureOf = (s: Step) =>
  [s.screen_signature.app, s.screen_signature.record_kind, s.screen_signature.field ?? ''].join(' / ').toLowerCase();

/**
 * Pairs the two maps' steps by screen signature, in order: the first A step on a screen pairs with
 * the first B step on it, and so on. Steps left over are the ones only one expert does.
 */
export function alignSteps(a: WorkMap, b: WorkMap): Alignment {
  const pending = new Map<string, Step[]>();
  for (const s of [...b.steps].sort((x, y) => x.ordinal - y.ordinal)) {
    const key = signatureOf(s);
    pending.set(key, [...(pending.get(key) ?? []), s]);
  }
  const pairs: StepPair[] = [];
  const onlyA: Step[] = [];
  for (const s of [...a.steps].sort((x, y) => x.ordinal - y.ordinal)) {
    const key = signatureOf(s);
    const match = pending.get(key)?.shift();
    if (match) pairs.push({ signature: key, a: s, b: match });
    else onlyA.push(s);
  }
  const onlyB = [...pending.values()].flat().sort((x, y) => x.ordinal - y.ordinal);
  return { pairs, onlyA, onlyB };
}
