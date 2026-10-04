import type { SupabaseClient } from '@supabase/supabase-js';
import {
  VersionConflictError,
  type AnswerRow,
  type ExpertMemoryRow,
  type ExpertRow,
  type KbHit,
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

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

function unwrap<T>({ data, error }: Result<T>, what: string): T {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

const SCREEN_EVENT_COLUMNS =
  'event_id, session_id, t_ms, type, entity_kind, entity_id, field, before_val, after_val, state, confidence, source, keyframe_id';
const OPEN_ITEM_COLUMNS = 'id, org_id, workflow_id, work_map_id, session_id, text, anchor_t_ms, origin, status, importance';
const WORK_MAP_COLUMNS = 'id, org_id, workflow_id, expert_id, session_id, version, status, language, json';

/** Service-role store: reads any table, writes only work_maps and open_items (ARCHITECTURE §6). */
export function supabaseStore(db: SupabaseClient): Store {
  return {
    async getSession(id) {
      const res = await db
        .from('sessions')
        .select('id, org_id, workflow_id, kind, mode, expert_id, language')
        .eq('id', id)
        .maybeSingle();
      return unwrap<SessionRow | null>(res, 'load session');
    },

    async getWorkflow(id) {
      const res = await db.from('workflows').select('id, org_id, name').eq('id', id).maybeSingle();
      return unwrap<WorkflowRow | null>(res, 'load workflow');
    },

    async getExpert(id) {
      const res = await db.from('experts').select('id, org_id, display_name').eq('id', id).maybeSingle();
      return unwrap<ExpertRow | null>(res, 'load expert');
    },

    async loadCapture(sessionId) {
      const [events, turns, spans, questions, answers] = await Promise.all([
        db.from('screen_events').select(SCREEN_EVENT_COLUMNS).eq('session_id', sessionId).order('t_ms'),
        db
          .from('transcript_turns')
          .select('session_id, turn_id, role, text_redacted, lang, t_ms, off_record')
          .eq('session_id', sessionId)
          .order('t_ms'),
        db.from('off_record_spans').select('session_id, start_t_ms, end_t_ms').eq('session_id', sessionId),
        db
          .from('questions')
          .select('id, session_id, phase, qtype, text, anchor_event_ids, status, created_t_ms, asked_t_ms')
          .eq('session_id', sessionId)
          .order('created_t_ms'),
        db
          .from('answers')
          .select('id, session_id, question_id, turn_ids, content_class, quote, quote_en, has_condition, extracted_rule')
          .eq('session_id', sessionId),
      ]);
      return {
        screenEvents: unwrap<ScreenEventRow[]>(events, 'load screen events'),
        turns: unwrap<TranscriptTurnRow[]>(turns, 'load transcript turns'),
        offRecordSpans: unwrap<OffRecordSpanRow[]>(spans, 'load off-record spans'),
        questions: unwrap<QuestionRow[]>(questions, 'load questions'),
        answers: unwrap<AnswerRow[]>(answers, 'load answers'),
      };
    },

    async listCarriedOverOpenItems(workflowId, expertId, excludeSessionId) {
      const sessions = unwrap<{ id: string }[]>(
        await db
          .from('sessions')
          .select('id')
          .eq('workflow_id', workflowId)
          .eq('expert_id', expertId)
          .eq('kind', 'capture')
          .neq('id', excludeSessionId),
        'load earlier sessions',
      );
      if (sessions.length === 0) return [];
      const res = await db
        .from('open_items')
        .select(OPEN_ITEM_COLUMNS)
        .eq('workflow_id', workflowId)
        .in('session_id', sessions.map((s) => s.id))
        .in('status', ['open', 'asked'])
        .order('importance', { ascending: false });
      return unwrap<OpenItemRow[]>(res, 'load carried-over open items');
    },

    async getWorkMap(id) {
      const res = await db.from('work_maps').select(WORK_MAP_COLUMNS).eq('id', id).maybeSingle();
      return unwrap<WorkMapRow | null>(res, 'load work map');
    },

    async findWorkMapBySession(sessionId) {
      const res = await db
        .from('work_maps')
        .select(WORK_MAP_COLUMNS)
        .eq('session_id', sessionId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      return unwrap<WorkMapRow | null>(res, 'load work map');
    },

    async latestWorkMapVersion(workflowId) {
      const res = await db
        .from('work_maps')
        .select('version')
        .eq('workflow_id', workflowId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      return unwrap<{ version: number } | null>(res, 'load latest version')?.version ?? 0;
    },

    async insertWorkMap(row, openItems) {
      const { error } = await db.from('work_maps').insert(row);
      if (error?.code === '23505') throw new VersionConflictError(row.workflow_id, row.version);
      if (error) throw new Error(`insert work map: ${error.message}`);
      if (openItems.length > 0) unwrap(await db.from('open_items').insert(openItems), 'insert open items');
    },

    async updateWorkMap(id, patch) {
      unwrap(await db.from('work_maps').update(patch).eq('id', id), 'update work map');
    },

    async listOpenItems(workMapId) {
      const res = await db
        .from('open_items')
        .select(OPEN_ITEM_COLUMNS)
        .eq('work_map_id', workMapId)
        .order('importance', { ascending: false });
      return unwrap<OpenItemRow[]>(res, 'load open items');
    },

    async updateOpenItemStatus(id, status) {
      unwrap(await db.from('open_items').update({ status }).eq('id', id), 'update open item');
    },

    async replaceOpenItems(workMapId, rows) {
      // Not atomic: a failure between the two leaves the map with no open items, and the
      // build retry (task_done redelivery) rewrites them from the Work Map JSON.
      unwrap(await db.from('open_items').delete().eq('work_map_id', workMapId), 'delete open items');
      if (rows.length > 0) unwrap(await db.from('open_items').insert(rows), 'insert open items');
    },

    async getExpertMemory(expertId, workflowId) {
      const res = await db
        .from('expert_memory')
        .select('expert_id, workflow_id, summary')
        .eq('expert_id', expertId)
        .eq('workflow_id', workflowId)
        .maybeSingle();
      return unwrap<ExpertMemoryRow | null>(res, 'load expert memory');
    },

    async replaceWorkMapRows(workMapId, rows) {
      // Not atomic. Evidence goes first (it references steps and guardrails); removed steps and
      // guardrails are deleted before the upsert so a reused key can't hit unique (work_map_id, key).
      unwrap(await db.from('step_evidence').delete().eq('work_map_id', workMapId), 'delete step evidence');
      for (const [table, keep] of [
        ['guardrails', rows.guardrails.map((g) => g.id)],
        ['work_map_steps', rows.steps.map((s) => s.id)],
      ] as const) {
        let removed = db.from(table).delete().eq('work_map_id', workMapId);
        if (keep.length > 0) removed = removed.not('id', 'in', `(${keep.join(',')})`);
        unwrap(await removed, `delete removed ${table}`);
      }
      // Upserts only send the columns below, so voice's work_map_steps.el_procedure_id survives.
      if (rows.steps.length > 0) unwrap(await db.from('work_map_steps').upsert(rows.steps), 'upsert work map steps');
      if (rows.guardrails.length > 0) unwrap(await db.from('guardrails').upsert(rows.guardrails), 'upsert guardrails');
      if (rows.evidence.length > 0) unwrap(await db.from('step_evidence').insert(rows.evidence), 'insert step evidence');
    },

    async replaceKbChunks(workMapId, rows) {
      // Not atomic: a failure between the two leaves the map unsearchable until publish runs again.
      unwrap(await db.from('kb_chunks').delete().eq('work_map_id', workMapId), 'delete kb chunks');
      if (rows.length > 0) unwrap(await db.from('kb_chunks').insert(rows), 'insert kb chunks');
    },

    async searchKb(orgId, workflowId, query, limit) {
      const res = await db.rpc('search_kb', { p_org: orgId, p_workflow: workflowId, p_query: query, p_limit: limit });
      return unwrap<KbHit[] | null>(res, 'search kb') ?? [];
    },
  };
}
