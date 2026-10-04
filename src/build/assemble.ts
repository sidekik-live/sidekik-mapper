import { randomUUID } from 'node:crypto';
import type { Evidence, Guardrail, JsonLogic, OpenItem, Step, WorkMap } from '../contracts/index.js';
import type { OpenItemRow } from '../store/types.js';
import type { GuardrailDraft, WorkMapDraft } from './draft-schema.js';
import type { BuildInput } from './gather.js';
import { mmss } from './prompt.js';

const IMPORTANCE = { high: 3, medium: 2, low: 1 } as const;

/** The model's consequence (lists and nulls, for structured output) as the contract's shape. */
export function toConsequence(c: GuardrailDraft['consequence']): Guardrail['consequence'] {
  return {
    ...(c.require.length > 0 && { require: Object.fromEntries(c.require.map((r) => [r.field, r.value])) }),
    ...(c.block && { block: true }),
    ...(c.action && { action: c.action }),
  };
}

/** "Sabine · 03:12": who said it and when, for the UI next to a quote. */
export const sourceLabel = (expert: string, t_ms: number | undefined) =>
  t_ms === undefined ? expert : `${expert} · ${mmss(t_ms)}`;

export type Assembled = {
  workmap: WorkMap;
  /** Rows for `open_items`, in the Work Map's order, carrying importance (not part of the contract type). */
  openItems: OpenItemRow[];
  /** References the draft made that the input doesn't contain; validation acts on these. */
  warnings: string[];
};

/**
 * Turns the model's draft into a contract WorkMap: assigns UUIDs, resolves guardrail keys, and
 * takes timestamps, keyframes and source labels from the input rows rather than the model.
 */
export function assembleWorkMap(args: {
  id: string;
  version: number;
  input: BuildInput;
  draft: WorkMapDraft;
  newId?: () => string;
}): Assembled {
  const { input, draft } = args;
  const newId = args.newId ?? randomUUID;
  const warnings: string[] = [];
  const events = new Map(input.events.map((e) => [e.event_id, e]));
  const turns = new Map(input.turns.map((t) => [t.turn_id, t]));
  const expert = input.session.expert_name;

  const eventTime = (id: string | null | undefined) => (id ? events.get(id)?.t_ms : undefined);
  const turnTime = (id: string | null | undefined) => (id ? turns.get(id)?.t_ms : undefined);
  const knownTurn = (id: string, where: string) => {
    if (!turns.has(id)) warnings.push(`${where}: unknown turn_id ${id}`);
  };

  const guardrailIds = new Map(draft.guardrails.map((g) => [g.key, newId()]));

  const steps: Step[] = draft.steps.map((s, i) => {
    const where = `step ${s.key}`;
    const times = s.screen_moment.event_ids.flatMap((id) => {
      const t = eventTime(id);
      if (t === undefined) warnings.push(`${where}: unknown event_id ${id}`);
      return t === undefined ? [] : [t];
    });
    if (times.length === 0) warnings.push(`${where}: no screen event`);
    if (s.reason) knownTurn(s.reason.turn_id, where);
    const reasonTime = s.reason ? turnTime(s.reason.turn_id) : undefined;

    return {
      id: newId(),
      key: s.key,
      ordinal: i + 1,
      title: s.title,
      screen_moment: {
        t_ms: times.length > 0 ? Math.min(...times) : 0,
        label: s.screen_moment.label,
        event_ids: s.screen_moment.event_ids,
        ...(s.screen_moment.entity && { entity: s.screen_moment.entity }),
        ...(s.screen_moment.field && { field: s.screen_moment.field }),
      },
      decision: s.decision,
      reason: s.reason && {
        quote: s.reason.quote,
        quote_en: s.reason.quote_en,
        turn_id: s.reason.turn_id,
        source_label: sourceLabel(expert, reasonTime),
      },
      guardrail_ids: s.guardrail_keys.flatMap((key) => {
        const id = guardrailIds.get(key);
        if (!id) warnings.push(`${where}: unknown guardrail ${key}`);
        return id ? [id] : [];
      }),
      is_judgment_call: s.is_judgment_call,
      screen_signature: {
        app: s.screen_signature.app,
        record_kind: s.screen_signature.record_kind,
        ...(s.screen_signature.field && { field: s.screen_signature.field }),
      },
    };
  });

  const guardrails: Guardrail[] = draft.guardrails.map((g) => {
    const where = `guardrail ${g.key}`;
    const evidence: Evidence[] = g.evidence.map((e) => {
      knownTurn(e.turn_id, where);
      const event = e.event_id ? events.get(e.event_id) : undefined;
      if (e.event_id && !event) warnings.push(`${where}: unknown event_id ${e.event_id}`);
      return {
        ...(e.event_id && { event_id: e.event_id }),
        ...(event?.keyframe_id && { keyframe_id: event.keyframe_id }),
        turn_id: e.turn_id,
        t_ms: event?.t_ms ?? turnTime(e.turn_id) ?? 0,
      };
    });
    return {
      id: guardrailIds.get(g.key)!,
      key: g.key,
      kind: g.kind,
      description: g.description,
      // parseDraft already checked that rule_json is a JSON object.
      rule: JSON.parse(g.rule_json) as JsonLogic,
      consequence: toConsequence(g.consequence),
      quote: g.quote,
      quote_en: g.quote_en,
      evidence,
    };
  });

  const carried = new Map(input.carriedOver.map((o) => [o.id, o]));
  const openItemRows: OpenItemRow[] = draft.open_items.map((o) => {
    const anchor = eventTime(o.anchor_event_id) ?? turnTime(o.anchor_turn_id);
    const origin =
      o.source === 'unasked_question'
        ? 'live'
        : o.source === 'carried_over'
          ? (carried.get(o.source_ref ?? '')?.origin ?? 'builder')
          : 'builder';
    return {
      id: newId(),
      org_id: input.session.org_id,
      workflow_id: input.session.workflow_id,
      work_map_id: args.id,
      session_id: input.session.id,
      text: o.text,
      anchor_t_ms: anchor ?? null,
      origin,
      status: 'open',
      importance: IMPORTANCE[o.importance],
    };
  });
  // Most important first; the sort is stable, so the model's order breaks ties.
  openItemRows.sort((a, b) => b.importance - a.importance);

  const openItems: OpenItem[] = openItemRows.map((o) => ({
    id: o.id,
    text: o.text,
    ...(o.anchor_t_ms !== null && { anchor_t_ms: o.anchor_t_ms }),
    origin: o.origin,
    status: o.status,
  }));

  return {
    workmap: {
      id: args.id,
      workflow_id: input.session.workflow_id,
      expert_id: input.session.expert_id,
      version: args.version,
      status: 'draft',
      title: draft.title,
      language: input.session.language,
      steps,
      guardrails,
      open_items: openItems,
    },
    openItems: openItemRows,
    warnings,
  };
}
