import { randomUUID } from 'node:crypto';
import type { Evidence, Guardrail, Step, WorkMap } from '../contracts/index.js';
import { runDemoCases, type DemoResult } from '../guardrails/demo-cases.js';
import { checkRule } from '../guardrails/rules.js';
import type { OpenItemRow, TranscriptTurnRow } from '../store/types.js';
import { sourceLabel } from './assemble.js';
import type { BuildInput } from './gather.js';

export type Validated = {
  workmap: WorkMap;
  /** The Work Map's open items, including the ones validation added, most important first. */
  openItems: OpenItemRow[];
  /** What validation changed or dropped, one line each. */
  issues: string[];
  /** DESIGN §6 demo cases against the surviving guardrails; reported, not enforced. */
  demo: DemoResult[];
};

/** Case-, whitespace- and punctuation-insensitive, so "5.000 Euro," matches "5000 euro". */
const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * DESIGN §4 step 3, in code: every evidence ID must exist in the session, every quote must be the
 * expert's words in the cited turn, every rule must parse and read only InvoiceState variables,
 * and every step and guardrail must keep at least one screen event and one turn. What can't be
 * repaired becomes an open item for the debrief instead of a claim in the map.
 */
export function validateWorkMap(args: {
  workmap: WorkMap;
  openItems: OpenItemRow[];
  input: BuildInput;
  newId?: () => string;
}): Validated {
  const { workmap, input } = args;
  const newId = args.newId ?? randomUUID;
  const issues: string[] = [];
  const added: OpenItemRow[] = [];
  const events = new Map(input.events.map((e) => [e.event_id, e]));
  const turns = new Map(input.turns.map((t) => [t.turn_id, t]));
  const expert = input.session.expert_name;

  const quoteIn = (quote: string, turn: TranscriptTurnRow | undefined) =>
    turn !== undefined && normalize(quote) !== '' && normalize(turn.text_redacted).includes(normalize(quote));
  const turnWithQuote = (quote: string) => input.turns.find((t) => quoteIn(quote, t));
  const openItem = (text: string, importance: number, anchor_t_ms: number | undefined) =>
    added.push({
      id: newId(),
      org_id: input.session.org_id,
      workflow_id: input.session.workflow_id,
      work_map_id: workmap.id,
      session_id: input.session.id,
      text,
      anchor_t_ms: anchor_t_ms ?? null,
      origin: 'builder',
      status: 'open',
      importance,
    });

  const guardrails: Guardrail[] = [];
  for (const g of workmap.guardrails) {
    const where = `guardrail ${g.key}`;
    const anchor = g.evidence[0]?.t_ms;
    const ruleProblems = checkRule(g.rule);
    if (ruleProblems.length > 0) {
      issues.push(`${where} dropped: ${ruleProblems.join('; ')}`);
      openItem(`Confirm the rule "${g.description}": when exactly does it apply?`, 3, anchor);
      continue;
    }

    let evidence: Evidence[] = g.evidence.flatMap((e) => {
      if (!turns.has(e.turn_id)) {
        issues.push(`${where}: dropped evidence citing unknown turn ${e.turn_id}`);
        return [];
      }
      if (e.event_id && !events.has(e.event_id)) {
        issues.push(`${where}: dropped unknown event ${e.event_id} from evidence`);
        const { event_id: _e, keyframe_id: _k, ...rest } = e;
        return [rest];
      }
      return [e];
    });

    let { quote, quote_en } = g;
    if (!evidence.some((e) => quoteIn(quote, turns.get(e.turn_id)))) {
      const other = turnWithQuote(quote);
      if (other) {
        evidence = [...evidence, { turn_id: other.turn_id, t_ms: other.t_ms }];
        issues.push(`${where}: quote is from turn ${other.turn_id}; added it as evidence`);
      } else if (evidence[0]) {
        quote = turns.get(evidence[0].turn_id)!.text_redacted;
        quote_en = undefined;
        issues.push(`${where}: quote not found verbatim; replaced with turn ${evidence[0].turn_id}`);
      }
    }

    if (evidence.length === 0 || !evidence.some((e) => e.event_id)) {
      issues.push(`${where} dropped: needs a screen event and the expert's words as evidence`);
      openItem(`Confirm the rule "${g.description}" and show where it applies on screen.`, 3, anchor);
      continue;
    }
    const { quote_en: _old, ...rest } = g;
    guardrails.push({ ...rest, quote, ...(quote_en !== undefined && { quote_en }), evidence });
  }

  const kept = new Set(guardrails.map((g) => g.id));
  const steps: Step[] = [];
  for (const s of workmap.steps) {
    const where = `step ${s.key}`;
    const eventIds = s.screen_moment.event_ids.filter((id) => events.has(id));
    if (eventIds.length < s.screen_moment.event_ids.length) issues.push(`${where}: dropped unknown screen events`);
    if (eventIds.length === 0) {
      issues.push(`${where} dropped: no screen event shows it`);
      openItem(`Show me where you "${s.title}" on screen, and why.`, 2, s.reason ? turns.get(s.reason.turn_id)?.t_ms : undefined);
      continue;
    }

    let reason = s.reason;
    if (reason && !quoteIn(reason.quote, turns.get(reason.turn_id))) {
      const other = turnWithQuote(reason.quote);
      const cited = turns.get(reason.turn_id);
      if (other) {
        reason = { ...reason, turn_id: other.turn_id, source_label: sourceLabel(expert, other.t_ms) };
        issues.push(`${where}: reason quote is from turn ${other.turn_id}; re-cited`);
      } else if (cited) {
        const { quote_en: _q, ...rest } = reason;
        reason = { ...rest, quote: cited.text_redacted };
        issues.push(`${where}: reason quote not found verbatim; replaced with turn ${cited.turn_id}`);
      } else {
        reason = null;
        issues.push(`${where}: reason cites unknown turn ${s.reason!.turn_id}; removed`);
      }
    }

    steps.push({
      ...s,
      ordinal: steps.length + 1,
      screen_moment: { ...s.screen_moment, event_ids: eventIds, t_ms: Math.min(...eventIds.map((id) => events.get(id)!.t_ms)) },
      reason,
      guardrail_ids: s.guardrail_ids.filter((id) => kept.has(id)),
    });
  }

  const openItems = [...args.openItems, ...added].sort((a, b) => b.importance - a.importance);
  return {
    workmap: {
      ...workmap,
      steps,
      guardrails,
      open_items: openItems.map((o) => ({
        id: o.id,
        text: o.text,
        ...(o.anchor_t_ms !== null && { anchor_t_ms: o.anchor_t_ms }),
        origin: o.origin,
        status: o.status,
      })),
    },
    openItems,
    issues,
    demo: runDemoCases(guardrails),
  };
}
