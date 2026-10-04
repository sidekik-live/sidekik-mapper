import { overlap, words } from '../recall/words.js';
import {
  VersionConflictError,
  type AnswerRow,
  type ExpertMemoryRow,
  type ExpertRow,
  type KbChunkRow,
  type StepEvidenceRow,
  type WorkMapGuardrailRow,
  type WorkMapStepRow,
  type OffRecordSpanRow,
  type OpenItemRow,
  type QuestionRow,
  type ScreenEventRow,
  type SessionRow,
  type Store,
  type TranscriptTurnRow,
  type WorkflowRow,
  type WorkMapRow,
} from './types.js';

export type MemoryData = {
  sessions: SessionRow[];
  workflows: WorkflowRow[];
  experts: ExpertRow[];
  screen_events: ScreenEventRow[];
  transcript_turns: TranscriptTurnRow[];
  off_record_spans: OffRecordSpanRow[];
  questions: QuestionRow[];
  answers: AnswerRow[];
  open_items: OpenItemRow[];
  work_maps: WorkMapRow[];
  expert_memory: (ExpertMemoryRow & { org_id?: string; updated_at?: string })[];
  kb_chunks: KbChunkRow[];
  work_map_steps: WorkMapStepRow[];
  guardrails: WorkMapGuardrailRow[];
  step_evidence: StepEvidenceRow[];
};

/** In-memory store for tests and `pnpm dev:mock`; `data` is exposed so callers can inspect writes. */
export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = {
    sessions: [],
    workflows: [],
    experts: [],
    screen_events: [],
    transcript_turns: [],
    off_record_spans: [],
    questions: [],
    answers: [],
    open_items: [],
    work_maps: [],
    expert_memory: [],
    kb_chunks: [],
    work_map_steps: [],
    guardrails: [],
    step_evidence: [],
    ...structuredClone(seed),
  };
  const bySession = <T extends { session_id: string | null }>(rows: T[], sessionId: string) =>
    rows.filter((r) => r.session_id === sessionId);
  const byTime = <T extends { t_ms: number }>(rows: T[]) => [...rows].sort((a, b) => a.t_ms - b.t_ms);

  return {
    data,
    async getSession(id) {
      return data.sessions.find((s) => s.id === id) ?? null;
    },
    async getWorkflow(id) {
      return data.workflows.find((w) => w.id === id) ?? null;
    },
    async getExpert(id) {
      return data.experts.find((e) => e.id === id) ?? null;
    },
    async loadCapture(sessionId) {
      return {
        screenEvents: byTime(bySession(data.screen_events, sessionId)),
        turns: byTime(bySession(data.transcript_turns, sessionId)),
        offRecordSpans: bySession(data.off_record_spans, sessionId),
        questions: bySession(data.questions, sessionId).sort((a, b) => a.created_t_ms - b.created_t_ms),
        answers: bySession(data.answers, sessionId),
      };
    },
    async listCarriedOverOpenItems(workflowId, expertId, excludeSessionId) {
      const earlier = new Set(
        data.sessions
          .filter(
            (s) => s.workflow_id === workflowId && s.expert_id === expertId && s.kind === 'capture' && s.id !== excludeSessionId,
          )
          .map((s) => s.id),
      );
      return data.open_items
        .filter((o) => o.workflow_id === workflowId && o.session_id && earlier.has(o.session_id) && o.status !== 'resolved')
        .sort((a, b) => b.importance - a.importance);
    },
    async getWorkMap(id) {
      return data.work_maps.find((m) => m.id === id) ?? null;
    },
    async findWorkMapBySession(sessionId) {
      const maps = data.work_maps.filter((m) => m.session_id === sessionId).sort((a, b) => b.version - a.version);
      return maps[0] ?? null;
    },
    async latestWorkMapVersion(workflowId) {
      return Math.max(0, ...data.work_maps.filter((m) => m.workflow_id === workflowId).map((m) => m.version));
    },
    async insertWorkMap(row, openItems) {
      if (data.work_maps.some((m) => m.workflow_id === row.workflow_id && m.version === row.version)) {
        throw new VersionConflictError(row.workflow_id, row.version);
      }
      data.work_maps.push(structuredClone(row));
      data.open_items.push(...structuredClone(openItems));
    },
    async updateWorkMap(id, patch) {
      const row = data.work_maps.find((m) => m.id === id);
      if (!row) throw new Error(`work map ${id} not found`);
      Object.assign(row, structuredClone(patch));
    },
    async listOpenItems(workMapId) {
      return structuredClone(data.open_items.filter((o) => o.work_map_id === workMapId)).sort((a, b) => b.importance - a.importance);
    },
    async updateOpenItemStatus(id, status) {
      const row = data.open_items.find((o) => o.id === id);
      if (row) row.status = status;
    },
    async replaceOpenItems(workMapId, rows) {
      data.open_items = [...data.open_items.filter((o) => o.work_map_id !== workMapId), ...structuredClone(rows)];
    },
    async getExpertMemory(expertId, workflowId) {
      return data.expert_memory.find((m) => m.expert_id === expertId && m.workflow_id === workflowId) ?? null;
    },
    async upsertExpertMemory(row) {
      const others = data.expert_memory.filter((m) => !(m.expert_id === row.expert_id && m.workflow_id === row.workflow_id));
      data.expert_memory = [...others, { ...structuredClone(row), updated_at: new Date().toISOString() }];
    },
    // Word overlap stands in for Postgres full-text search here.
    async searchKb(orgId, workflowId, query, limit) {
      const q = words(query);
      return data.kb_chunks
        .filter((c) => c.org_id === orgId && c.workflow_id === workflowId)
        .map((c) => ({ id: c.id, kind: c.kind, ref_id: c.ref_id, content: c.content, score: overlap(q, c.content) }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    async replaceWorkMapRows(workMapId, rows) {
      const other = <T extends { work_map_id: string }>(xs: T[]) => xs.filter((x) => x.work_map_id !== workMapId);
      data.work_map_steps = [...other(data.work_map_steps), ...structuredClone(rows.steps)];
      data.guardrails = [...other(data.guardrails), ...structuredClone(rows.guardrails)];
      data.step_evidence = [...other(data.step_evidence), ...structuredClone(rows.evidence)];
    },
    async replaceKbChunks(workMapId, rows) {
      data.kb_chunks = [...data.kb_chunks.filter((c) => c.work_map_id !== workMapId), ...structuredClone(rows)];
    },
  };
}
