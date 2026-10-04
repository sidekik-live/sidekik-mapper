import type { ScreenEventType } from '../contracts/index.js';
import { mergeCapture, type CaptureBuffer } from '../services/capture-buffer.js';
import type {
  AnswerRow,
  OffRecordSpanRow,
  OpenItemRow,
  QuestionRow,
  ScreenEventRow,
  SessionRow,
  Store,
  TranscriptTurnRow,
} from '../store/types.js';

/** Event types that change or move through the record; reads, typing and idle carry no decision. */
const CHANGE_EVENTS = new Set<ScreenEventType>([
  'app_opened',
  'record_opened',
  'field_changed',
  'button_clicked',
  'navigation',
  'dialog',
]);

/** DESIGN §4: about 30–60k input tokens. */
export const INPUT_TOKEN_BUDGET = 60_000;
const LOW_CONFIDENCE = 0.6;

export type AskedQuestion = { question: QuestionRow; answer: AnswerRow | null };

export type BuildInput = {
  session: {
    id: string;
    org_id: string;
    workflow_id: string;
    expert_id: string;
    language: string;
    workflow_name: string;
    expert_name: string;
  };
  events: ScreenEventRow[];
  /** The expert's on-record turns. */
  turns: TranscriptTurnRow[];
  asked: AskedQuestion[];
  /** Candidate and expired questions brain never asked. */
  unasked: QuestionRow[];
  carriedOver: OpenItemRow[];
};

export type GatherStats = {
  events_total: number;
  events_kept: number;
  turns_kept: number;
  off_record_dropped: number;
  trimmed_for_budget: number;
  estimated_tokens: number;
};

/** Loads everything the draft needs for a capture session (DESIGN §4 step 1). */
export async function gather(
  store: Store,
  session: SessionRow & { expert_id: string },
  render: (input: BuildInput) => string,
  /** Screen events and turns from the bus, for what the database doesn't have yet. */
  buffer?: CaptureBuffer,
): Promise<{ input: BuildInput; stats: GatherStats }> {
  const [stored, workflow, expert, carriedOver] = await Promise.all([
    store.loadCapture(session.id),
    store.getWorkflow(session.workflow_id),
    store.getExpert(session.expert_id),
    store.listCarriedOverOpenItems(session.workflow_id, session.expert_id, session.id),
  ]);

  const capture = buffer ? mergeCapture(stored, buffer.get(session.id)) : stored;
  const offRecord = isOffRecord(capture.offRecordSpans);
  const changeEvents = capture.screenEvents.filter((e) => CHANGE_EVENTS.has(e.type));
  const events = changeEvents.filter((e) => !offRecord(e.t_ms));
  const turns = capture.turns.filter((t) => t.role === 'user' && !t.off_record && !offRecord(t.t_ms));
  const offRecordDropped =
    changeEvents.length - events.length + capture.turns.filter((t) => t.role === 'user').length - turns.length;

  const answers = new Map(capture.answers.map((a) => [a.question_id, a]));
  const asked = capture.questions
    .filter((q) => q.status === 'asked' || q.status === 'answered')
    .map((question) => ({ question, answer: answers.get(question.id) ?? null }));
  const unasked = capture.questions.filter((q) => q.status === 'candidate' || q.status === 'expired');

  const input: BuildInput = {
    session: {
      id: session.id,
      org_id: session.org_id,
      workflow_id: session.workflow_id,
      expert_id: session.expert_id,
      language: session.language,
      workflow_name: workflow?.name ?? 'Unnamed workflow',
      expert_name: expert?.display_name ?? 'the expert',
    },
    events,
    turns,
    asked,
    unasked,
    carriedOver,
  };
  const trimmed = trimToBudget(input, render);
  return {
    input: trimmed.input,
    stats: {
      events_total: capture.screenEvents.length,
      events_kept: trimmed.input.events.length,
      turns_kept: turns.length,
      off_record_dropped: offRecordDropped,
      trimmed_for_budget: input.events.length - trimmed.input.events.length,
      estimated_tokens: trimmed.tokens,
    },
  };
}

function isOffRecord(spans: OffRecordSpanRow[]) {
  return (t: number) => spans.some((s) => t >= s.start_t_ms && t <= (s.end_t_ms ?? Infinity));
}

/** Rough count for mixed German/English JSON lines; errs high so the budget holds. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

/**
 * Drops screen events until the rendered input fits the budget: low-confidence ones first, then
 * every other navigation/click/dialog event, then every other remaining event until it fits.
 * Turns are never dropped (they are the evidence), nor are events a question was anchored to.
 */
function trimToBudget(input: BuildInput, render: (input: BuildInput) => string) {
  const anchored = new Set(input.asked.flatMap((a) => a.question.anchor_event_ids));
  const tokens = (events: ScreenEventRow[]) => estimateTokens(render({ ...input, events }));
  const keepIf = (events: ScreenEventRow[], keep: (e: ScreenEventRow, i: number) => boolean) =>
    events.filter((e, i) => anchored.has(e.event_id) || keep(e, i));
  let events = input.events;

  if (tokens(events) > INPUT_TOKEN_BUDGET) events = keepIf(events, (e) => (e.confidence ?? 1) >= LOW_CONFIDENCE);
  if (tokens(events) > INPUT_TOKEN_BUDGET) {
    events = keepIf(events, (e, i) => e.type === 'field_changed' || e.type === 'record_opened' || i % 2 === 0);
  }
  while (tokens(events) > INPUT_TOKEN_BUDGET) {
    const before = events.length;
    events = keepIf(events, (_e, i) => i % 2 === 0);
    if (events.length === before) break; // only anchored events left
  }
  return { input: { ...input, events }, tokens: tokens(events) };
}
