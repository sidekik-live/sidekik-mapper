// TEMPORARY: replace with @sidekik/contracts (see ./README.md). Mirrors sidekik-platform
// src/contracts/decisions.ts (types only; DECISION_SPECS stays in the platform package).
import { z } from 'zod';

export const DecisionIdSchema = z.enum(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12']);
export type DecisionId = z.infer<typeof DecisionIdSchema>;

export type DecisionRequest = { session_id: string; decisions: { id: DecisionId; state: unknown }[] };

/** One question's answer inside a decision (D6, D1, D5 and D7 ask more than one question). */
export const QuestionAnswerSchema = z.object({
  /** boolean for noul, option for choice, most likely level (1-based) for score. */
  answer: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.number()).optional(),
  /** Noul only: probability of true. */
  p_true: z.number().min(0).max(1).optional(),
  /** Score only: probability-weighted level (1-based), may fall between levels. */
  score: z.number().optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const DecisionResultSchema = z.object({
  id: DecisionIdSchema,
  /** Answer to the decision's first question (spec order), e.g. D6 → specificity. */
  answer: z.union([z.string(), z.number(), z.boolean()]),
  probabilities: z.record(z.number()).optional(),
  confidence: z.number().min(0).max(1),
  provider: z.enum(['jev', 'openrouter-jev', 'llm']),
  escalated: z.boolean(),
  latency_ms: z.number().nonnegative(),
  /** Every question's answer, keyed by question name. */
  answers: z.record(QuestionAnswerSchema).optional(),
});
export type DecisionResult = z.infer<typeof DecisionResultSchema>;

/** Response body of brain `POST /internal/decide`. */
export const DecisionResponseSchema = z.object({ results: z.array(DecisionResultSchema) });
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
