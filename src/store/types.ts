import type { ScreenEventType, ScreenState, WorkMap, WorkMapStatus } from '../contracts/index.js';

// Rows as SCHEMA.md defines them; only the columns the mapper reads or writes.

export type SessionRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  kind: 'capture' | 'tutor';
  mode: 'browser' | 'meeting' | 'replay';
  expert_id: string | null;
  language: string;
};

export type WorkflowRow = { id: string; org_id: string; name: string };
export type ExpertRow = { id: string; org_id: string; display_name: string };

/** perception's `screen_events` (column names differ from the bus `ScreenEvent`). */
export type ScreenEventRow = {
  event_id: string;
  session_id: string;
  t_ms: number;
  type: ScreenEventType;
  entity_kind: string | null;
  entity_id: string | null;
  field: string | null;
  before_val: string | null;
  after_val: string | null;
  state: ScreenState | null;
  confidence: number | null;
  source: 'vision' | 'dom';
  keyframe_id: string | null;
};

/** voice's `transcript_turns`; text is already redacted. */
export type TranscriptTurnRow = {
  session_id: string;
  turn_id: string;
  role: 'user' | 'agent';
  text_redacted: string;
  lang: string | null;
  t_ms: number;
  off_record: boolean;
};

export type OffRecordSpanRow = { session_id: string; start_t_ms: number; end_t_ms: number | null };

/** brain's `questions`. */
export type QuestionRow = {
  id: string;
  session_id: string;
  phase: 'capture' | 'debrief';
  qtype: 'exception' | 'limit' | 'other' | 'stop_and_ask' | 'why';
  text: string;
  anchor_event_ids: string[];
  status: 'candidate' | 'asked' | 'answered' | 'expired';
  created_t_ms: number;
  asked_t_ms: number | null;
};

/** brain's `answers`. */
export type AnswerRow = {
  id: string;
  session_id: string;
  question_id: string;
  turn_ids: string[];
  content_class: string;
  quote: string;
  quote_en: string | null;
  has_condition: boolean;
  extracted_rule: string | null;
};

export type OpenItemRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  work_map_id: string | null;
  session_id: string | null;
  text: string;
  anchor_t_ms: number | null;
  origin: 'live' | 'builder' | 'learner_gap';
  status: 'open' | 'asked' | 'resolved';
  /** 1 low .. 3 high */
  importance: number;
};

export type WorkMapRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  expert_id: string;
  session_id: string | null;
  version: number;
  status: WorkMapStatus;
  language: string;
  json: WorkMap;
};

export type ExpertMemoryRow = { expert_id: string; workflow_id: string; summary: string };

/** Everything the build job reads about one capture session. */
export type SessionCapture = {
  screenEvents: ScreenEventRow[];
  turns: TranscriptTurnRow[];
  offRecordSpans: OffRecordSpanRow[];
  questions: QuestionRow[];
  answers: AnswerRow[];
};

/** Thrown by `insertWorkMap` when another draft took the same (workflow_id, version). */
export class VersionConflictError extends Error {
  constructor(workflowId: string, version: number) {
    super(`work map version ${version} already exists for workflow ${workflowId}`);
    this.name = 'VersionConflictError';
  }
}

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
  getWorkflow(id: string): Promise<WorkflowRow | null>;
  getExpert(id: string): Promise<ExpertRow | null>;
  loadCapture(sessionId: string): Promise<SessionCapture>;
  /** Unresolved open items from this expert's earlier sessions on the workflow. */
  listCarriedOverOpenItems(workflowId: string, expertId: string, excludeSessionId: string): Promise<OpenItemRow[]>;
  findWorkMapBySession(sessionId: string): Promise<WorkMapRow | null>;
  /** Highest version for the workflow, or 0 when it has none. */
  latestWorkMapVersion(workflowId: string): Promise<number>;
  /** Inserts the Work Map, then its open items. Throws VersionConflictError on a duplicate version. */
  insertWorkMap(row: WorkMapRow, openItems: OpenItemRow[]): Promise<void>;
  updateWorkMap(id: string, patch: Pick<WorkMapRow, 'status' | 'json'>): Promise<void>;
  /** The Work Map's open items, most important first. */
  listOpenItems(workMapId: string): Promise<OpenItemRow[]>;
  /** Replaces every open item of the Work Map with `rows`. */
  replaceOpenItems(workMapId: string, rows: OpenItemRow[]): Promise<void>;
  getExpertMemory(expertId: string, workflowId: string): Promise<ExpertMemoryRow | null>;
}
