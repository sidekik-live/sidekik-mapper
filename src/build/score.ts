import type { FastifyBaseLogger } from 'fastify';
import type { Decider } from '../clients/brain.js';
import type { DecisionResult } from '../contracts/index.js';
import type { OpenItemRow, TranscriptTurnRow } from '../store/types.js';

/** The debrief asks at least three follow-ups (DESIGN §5), so never score below three items. */
export const MIN_OPEN_ITEMS = 3;
/** The expert's words around an item's anchor: a little before (context), more after (the explanation). */
const BEFORE_MS = 10_000;
const AFTER_MS = 20_000;
/** brain's act bands (sidekik-brain DESIGN §5): Score ≥0.80; Noul ≥0.85 or ≤0.15. */
const SCORE_CONFIDENT = 0.8;
const NOUL_FALSE = 0.15;

/**
 * DESIGN §4: score open items with D6 and drop the trivial ones. D6 rates an explanation
 * ("specificity ≤ 1 or refers_to_unknown_entity → open item", ARCHITECTURE Appendix A), so it runs
 * on what the expert already said around each item's anchor. An item is trivial only when that
 * explanation is fully specific (4) and names everything it refers to; items without an anchored
 * explanation, or that brain is unsure about, stay. If brain is unreachable every item stays: an
 * extra question costs less than a gap.
 */
export async function scoreOpenItems(
  decider: Decider,
  sessionId: string,
  items: OpenItemRow[],
  turns: TranscriptTurnRow[],
  log: FastifyBaseLogger,
): Promise<{ kept: OpenItemRow[]; dropped: OpenItemRow[] }> {
  if (items.length <= MIN_OPEN_ITEMS) return { kept: items, dropped: [] };

  const explanations = items.map((o) => explanationFor(o, turns));
  const scored = items.flatMap((_o, i) => (explanations[i] ? [i] : []));
  if (scored.length === 0) return { kept: items, dropped: [] };

  let results: DecisionResult[];
  try {
    results = await decider.decide(
      sessionId,
      scored.map((i) => ({ id: 'D6', state: { explanation: explanations[i], open_item: items[i]!.text } })),
    );
  } catch (err) {
    log.warn({ err }, 'D6 scoring failed; keeping every open item');
    return { kept: items, dropped: [] };
  }
  const trivial = new Set(scored.filter((_i, k) => isFullyExplained(results[k]!)));

  // Items arrive most important first; drop trivial ones from the back, so if the minimum stops
  // the dropping, the more important of the trivial items are the ones kept.
  let room = items.length - MIN_OPEN_ITEMS;
  const drop = new Set<number>();
  for (let i = items.length - 1; i >= 0 && room > 0; i--) {
    if (trivial.has(i)) {
      drop.add(i);
      room--;
    }
  }
  return { kept: items.filter((_, i) => !drop.has(i)), dropped: items.filter((_, i) => drop.has(i)) };
}

/** The expert's turns near the item's anchor, joined; undefined when there are none. */
function explanationFor(item: OpenItemRow, turns: TranscriptTurnRow[]): string | undefined {
  const at = item.anchor_t_ms;
  if (at === null) return undefined;
  const near = turns.filter((t) => t.t_ms >= at - BEFORE_MS && t.t_ms <= at + AFTER_MS);
  return near.length > 0 ? near.map((t) => t.text_redacted).join(' ') : undefined;
}

/** Specificity 4 and no unknown entity, both confidently; anything less keeps the item. */
function isFullyExplained(r: DecisionResult): boolean {
  const specificity = r.answers?.specificity ?? { answer: r.answer, confidence: r.confidence };
  const unknown = r.answers?.refers_to_unknown_entity;
  if (!unknown) return false;
  const noUnknownEntity =
    unknown.p_true !== undefined
      ? unknown.p_true <= NOUL_FALSE
      : unknown.answer === false && unknown.confidence >= 1 - NOUL_FALSE;
  return Number(specificity.answer) >= 4 && specificity.confidence >= SCORE_CONFIDENT && noUnknownEntity;
}
