// TEMPORARY: replace with @sidekik/contracts (see ./README.md). ARCHITECTURE Appendix B.
import { z } from 'zod';

/** A JSON-Logic expression; only the normalized InvoiceState variables may appear in `var`. */
export const JsonLogicSchema = z.record(z.unknown());
export type JsonLogic = z.infer<typeof JsonLogicSchema>;

/** The only variables a guardrail rule may read. */
export const JSONLOGIC_VARIABLES = [
  'net_amount',
  'currency',
  'category',
  'supplier',
  'supplier_known',
  'invoice_month',
  'company_code',
  'cost_center',
  'asset_number',
  'approvals_count',
] as const;

export const EvidenceSchema = z.object({
  event_id: z.string().optional(),
  keyframe_id: z.string().optional(),
  clip_id: z.string().optional(),
  turn_id: z.string(),
  t_ms: z.number(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const StepSchema = z.object({
  id: z.string(),
  key: z.string(),
  ordinal: z.number(),
  title: z.string(),
  screen_moment: z.object({
    t_ms: z.number(),
    label: z.string(),
    event_ids: z.array(z.string()),
    entity: z.string().optional(),
    field: z.string().optional(),
  }),
  decision: z.string(),
  reason: z
    .object({ quote: z.string(), quote_en: z.string().optional(), turn_id: z.string(), source_label: z.string() })
    .nullable(),
  guardrail_ids: z.array(z.string()),
  is_judgment_call: z.boolean(),
  screen_signature: z.object({ app: z.string(), record_kind: z.string(), field: z.string().optional() }),
});
export type Step = z.infer<typeof StepSchema>;

export const GuardrailKindSchema = z.enum(['threshold', 'condition', 'stop_and_ask', 'second_approval', 'hold']);
export const GuardrailActionSchema = z.enum(['ask_controller', 'hold', 'second_approval']);

export const GuardrailSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: GuardrailKindSchema,
  description: z.string(),
  rule: JsonLogicSchema,
  consequence: z.object({
    require: z.record(z.string()).optional(),
    block: z.boolean().optional(),
    action: GuardrailActionSchema.optional(),
  }),
  quote: z.string(),
  quote_en: z.string().optional(),
  evidence: z.array(EvidenceSchema),
});
export type Guardrail = z.infer<typeof GuardrailSchema>;

export const OpenItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  anchor_t_ms: z.number().optional(),
  origin: z.enum(['live', 'builder', 'learner_gap']),
  status: z.enum(['open', 'asked', 'resolved']),
});
export type OpenItem = z.infer<typeof OpenItemSchema>;

export const WorkMapStatusSchema = z.enum(['draft', 'in_debrief', 'confirmed', 'published', 'retired']);
export type WorkMapStatus = z.infer<typeof WorkMapStatusSchema>;

export const WorkMapSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  expert_id: z.string(),
  version: z.number(),
  status: WorkMapStatusSchema,
  title: z.string(),
  language: z.string(),
  steps: z.array(StepSchema),
  guardrails: z.array(GuardrailSchema),
  open_items: z.array(OpenItemSchema),
  confirmed_turn_id: z.string().optional(),
});
export type WorkMap = z.infer<typeof WorkMapSchema>;

export const WorkMapPublishedSchema = z.object({ workmap_id: z.string(), workflow_id: z.string(), version: z.number() });
export type WorkMapPublished = z.infer<typeof WorkMapPublishedSchema>;
