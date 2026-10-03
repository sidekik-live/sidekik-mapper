// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
import { z } from 'zod';
import { PhaseSchema } from './lifecycle.js';

export const QTypeSchema = z.enum(['exception', 'limit', 'other', 'stop_and_ask', 'why']);
export type QType = z.infer<typeof QTypeSchema>;

const Outcome = z.enum(['independent_correct', 'prompted_correct', 'corrected_after_intervention', 'not_attempted']);

export const MasterySummarySchema = z.object({
  session_id: z.string(),
  workmap_id: z.string(),
  learner_id: z.string(),
  steps: z.array(z.object({ step_id: z.string(), key: z.string(), title: z.string(), outcome: Outcome })),
  practice_next: z.array(
    z.object({ step_id: z.string().optional(), guardrail_id: z.string().optional(), reason: z.string() }),
  ),
  counts: z.object({
    independent_correct: z.number(),
    prompted_correct: z.number(),
    corrected_after_intervention: z.number(),
    not_attempted: z.number(),
  }),
});
export type MasterySummary = z.infer<typeof MasterySummarySchema>;

export const AgentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ctx'), text: z.string(), context_id: z.string().optional() }),
  z.object({ type: z.literal('ask'), question_id: z.string(), text: z.string(), qtype: QTypeSchema }),
  z.object({ type: z.literal('followup'), open_item_id: z.string(), text: z.string() }),
  z.object({ type: z.literal('teachback'), workmap_id: z.string(), script: z.string() }),
  z.object({ type: z.literal('predict'), step_id: z.string(), prompt: z.string() }),
  z.object({
    type: z.literal('intervene'),
    guardrail_id: z.string(),
    step_id: z.string(),
    text: z.string(),
    field: z.string().optional(),
  }),
  z.object({
    type: z.literal('replay'),
    step_id: z.string(),
    clip_url: z.string(),
    quote: z.string(),
    label: z.string(),
  }),
  z.object({ type: z.literal('summary'), mastery: MasterySummarySchema }),
  z.object({ type: z.literal('offrecord'), on: z.boolean() }),
  z.object({
    type: z.literal('phase'),
    phase: PhaseSchema,
    conversation_token: z.string(),
    agent_id: z.string(),
    dynamic_variables: z.record(z.string()),
  }),
]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
