import type { WorkMap } from '../contracts/index.js';
import { sourceLabel } from '../build/assemble.js';
import type { ScreenEventRow, StepEvidenceRow, Store, WorkMapGuardrailRow, WorkMapRows, WorkMapStepRow } from '../store/types.js';

/**
 * The Work Map as the normalized tables hold it (SCHEMA.md 0005): `work_map_steps`, `guardrails`
 * and `step_evidence`. The web Work Map page reads these, and perception's `clips` and tutor's
 * attempts and interventions reference their ids. Step evidence pairs each screen event of a step
 * with the expert's quoted reason; a step without a reason has no turn to cite, so no evidence row.
 */
export function workMapRows(args: { workmap: WorkMap; orgId: string; events: ScreenEventRow[]; expert: string }): WorkMapRows {
  const { workmap, orgId, expert } = args;
  const events = new Map(args.events.map((e) => [e.event_id, e]));
  const base = { org_id: orgId, work_map_id: workmap.id };

  const steps: WorkMapStepRow[] = workmap.steps.map((s) => ({
    ...base,
    id: s.id,
    key: s.key,
    ordinal: s.ordinal,
    title: s.title,
    decision: s.decision,
    reason_quote: s.reason?.quote ?? null,
    reason_quote_en: s.reason?.quote_en ?? null,
    reason_turn_id: s.reason?.turn_id ?? null,
    source_label: s.reason?.source_label ?? null,
    is_judgment_call: s.is_judgment_call,
    screen_moment: s.screen_moment,
    screen_signature: s.screen_signature,
  }));

  const guardrails: WorkMapGuardrailRow[] = workmap.guardrails.map((g) => ({
    ...base,
    id: g.id,
    key: g.key,
    kind: g.kind,
    description: g.description,
    rule_jsonlogic: g.rule,
    consequence: g.consequence,
    quote: g.quote,
    quote_en: g.quote_en ?? null,
  }));

  const evidence: StepEvidenceRow[] = [
    ...workmap.steps.flatMap((s) =>
      s.reason
        ? s.screen_moment.event_ids.map((eventId) => {
            const event = events.get(eventId);
            return {
              ...base,
              step_id: s.id,
              guardrail_id: null,
              screen_event_id: eventId,
              keyframe_id: event?.keyframe_id ?? null,
              clip_id: null,
              transcript_turn_id: s.reason!.turn_id,
              t_ms: event?.t_ms ?? s.screen_moment.t_ms,
              quote: s.reason!.quote,
              source_label: s.reason!.source_label,
            };
          })
        : [],
    ),
    ...workmap.guardrails.flatMap((g) =>
      g.evidence.map((e) => ({
        ...base,
        step_id: null,
        guardrail_id: g.id,
        screen_event_id: e.event_id ?? null,
        keyframe_id: e.keyframe_id ?? null,
        clip_id: e.clip_id ?? null,
        transcript_turn_id: e.turn_id,
        t_ms: e.t_ms,
        quote: g.quote,
        source_label: sourceLabel(expert, e.t_ms),
      })),
    ),
  ];

  return { steps, guardrails, evidence };
}

/** Writes the normalized rows for a Work Map (replacing what was there). */
export async function syncWorkMapRows(
  store: Store,
  args: { workmap: WorkMap; orgId: string; events: ScreenEventRow[]; expert: string },
): Promise<WorkMapRows> {
  const rows = workMapRows(args);
  await store.replaceWorkMapRows(args.workmap.id, rows);
  return rows;
}
