import { randomUUID } from 'node:crypto';
import type { WorkMap } from '../contracts/index.js';
import type { AnswerRow, KbChunkRow, QuestionRow } from '../store/types.js';

/**
 * DESIGN §6 step 3: one chunk per step, per guardrail and per expert answer. Each holds the
 * original-language text and the English, so German and English queries both match; Postgres
 * generates the `tsv` column, so there is no embedding call.
 */
export function kbChunks(args: {
  workmap: WorkMap;
  orgId: string;
  answers: AnswerRow[];
  questions: QuestionRow[];
  newId?: () => string;
}): KbChunkRow[] {
  const { workmap } = args;
  const newId = args.newId ?? randomUUID;
  const base = { org_id: args.orgId, workflow_id: workmap.workflow_id, work_map_id: workmap.id };
  const text = (...parts: (string | null | undefined)[]) => parts.filter((p): p is string => Boolean(p?.trim())).join('\n');
  const questions = new Map(args.questions.map((q) => [q.id, q]));

  return [
    ...workmap.steps.map((s) => ({
      ...base,
      id: newId(),
      kind: 'step' as const,
      ref_id: s.id,
      content: text(`${s.key}. ${s.title}`, s.decision, s.reason?.quote, s.reason?.quote_en),
    })),
    ...workmap.guardrails.map((g) => ({
      ...base,
      id: newId(),
      kind: 'guardrail' as const,
      ref_id: g.id,
      content: text(`${g.key}. ${g.description}`, g.quote, g.quote_en),
    })),
    ...args.answers.map((a) => ({
      ...base,
      id: newId(),
      kind: 'answer' as const,
      ref_id: a.id,
      content: text(questions.get(a.question_id)?.text, a.quote, a.quote_en),
    })),
  ];
}
