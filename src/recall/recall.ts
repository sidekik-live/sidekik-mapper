import type { FastifyBaseLogger } from 'fastify';
import { mmss } from '../build/prompt.js';
import type { InvoiceState, ScreenEventType } from '../contracts/index.js';
import type { ScreenEventRow, SessionRow, Store } from '../store/types.js';
import { overlap, words } from './words.js';

export type RecallScope = 'session' | 'workflow';
/** One entry of `RecallContextResponseSchema` (sidekik-platform api.ts). */
export type Snippet = {
  text: string;
  /** Session time of a screen event or turn; absent for published knowledge. */
  t_ms?: number;
  source: 'kb:step' | 'kb:guardrail' | 'kb:answer' | 'screen' | 'transcript';
};

/** DESIGN §2: at most 5 snippets; the last 20 screen events are searched. */
export const MAX_SNIPPETS = 5;
const RECENT_EVENTS = 20;
/** When nothing matches, the newest events still tell the agent what is on screen now. */
const FALLBACK_EVENTS = 2;
/** The gateway gives this call 1 s; search_kb gets most of it, the rest is already loaded. */
const KB_TIMEOUT_MS = 600;

const CHANGE_EVENTS = new Set<ScreenEventType>(['app_opened', 'record_opened', 'field_changed', 'button_clicked', 'navigation', 'dialog']);

/** The record's key facts, so "the Kranbau invoice" finds the moment it was opened. */
function recordText(r: InvoiceState | undefined): string {
  if (!r) return '';
  const facts = [
    r.supplier,
    r.net_amount !== undefined ? `${r.net_amount} ${r.currency ?? ''}`.trim() : undefined,
    r.category,
    r.company_code,
    r.cost_center && `cost center ${r.cost_center}`,
    r.invoice_month !== undefined ? `month ${r.invoice_month}` : undefined,
  ].filter(Boolean);
  return facts.length > 0 ? ` (${facts.join(', ')})` : '';
}

/** "03:12 field_changed invoice 4471 cost_center: 4711 → 0400"; record_opened adds the record's facts. */
function eventText(e: ScreenEventRow): string {
  const entity = e.entity_kind ? ` ${e.entity_kind}${e.entity_id ? ` ${e.entity_id}` : ''}` : '';
  const change = e.before_val != null || e.after_val != null ? `: ${e.before_val || '(empty)'} → ${e.after_val || '(empty)'}` : '';
  const record = e.type === 'record_opened' ? recordText(e.state?.record) : '';
  return `${mmss(e.t_ms)} ${e.type}${entity}${e.field ? ` ${e.field}` : ''}${change}${record}`;
}

type Scored = Snippet & { score: number };

/**
 * `recall_context` for the interviewer agent (DESIGN §2). `workflow` searches the workflow's
 * published knowledge with `search_kb()` (full-text, trigram fallback); `session` searches this
 * session's on-record expert turns. Both add the session's last 20 screen events that match.
 * Nothing from an off-record span is ever returned. If `search_kb()` is slow or down, the
 * session's own snippets still come back.
 */
export async function recallContext(
  deps: { store: Store },
  args: { session: SessionRow; query: string; scope: RecallScope },
  log: FastifyBaseLogger,
): Promise<{ snippets: Snippet[] }> {
  const { session, query, scope } = args;
  const q = words(query);

  const [capture, kb] = await Promise.all([
    deps.store.loadCapture(session.id),
    scope === 'workflow' ? searchKb(deps.store, session, query, log) : Promise.resolve([]),
  ]);
  const offRecord = (t: number) => capture.offRecordSpans.some((s) => t >= s.start_t_ms && t <= (s.end_t_ms ?? Infinity));

  const recent = capture.screenEvents
    .filter((e) => CHANGE_EVENTS.has(e.type) && !offRecord(e.t_ms))
    .slice(-RECENT_EVENTS)
    .reverse(); // newest first
  const events: Scored[] = recent.map((e) => ({ text: eventText(e), t_ms: e.t_ms, source: 'screen', score: overlap(q, eventText(e)) }));
  const turns: Scored[] =
    scope === 'session'
      ? capture.turns
          .filter((t) => t.role === 'user' && !t.off_record && !offRecord(t.t_ms))
          .map((t) => ({ text: t.text_redacted, t_ms: t.t_ms, source: 'transcript', score: overlap(q, t.text_redacted) }))
      : [];

  const matches = [...kb, ...turns, ...events]
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (b.t_ms ?? Infinity) - (a.t_ms ?? Infinity)); // ties: knowledge, then newest
  const picked = matches.slice(0, MAX_SNIPPETS);
  if (picked.length === 0) picked.push(...events.slice(0, FALLBACK_EVENTS));

  log.info({ scope, query_words: q.length, kb: kb.length, matches: matches.length, returned: picked.length }, 'recall_context');
  return { snippets: picked.map(({ text, t_ms, source }) => ({ text, ...(t_ms !== undefined && { t_ms }), source })) };
}

/** search_kb() hits, scaled so the best one scores 1 (ts_rank and trigram similarity differ in range). */
async function searchKb(store: Store, session: SessionRow, query: string, log: FastifyBaseLogger): Promise<Scored[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const hits = await Promise.race([
      store.searchKb(session.org_id, session.workflow_id, query, MAX_SNIPPETS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`search_kb timed out after ${KB_TIMEOUT_MS} ms`)), KB_TIMEOUT_MS);
      }),
    ]);
    const best = Math.max(...hits.map((h) => h.score), Number.EPSILON);
    return hits.map((h) => ({ text: h.content, source: `kb:${h.kind}`, score: Math.max(h.score / best, Number.EPSILON) }));
  } catch (err) {
    log.warn({ err }, 'search_kb failed; answering from the session only');
    return [];
  } finally {
    clearTimeout(timer);
  }
}
