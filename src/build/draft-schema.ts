// What Sonnet returns (structured output). Uses zod/v4 because the SDK's output-format helper
// needs it; the rest of the service is on zod v3. Structured outputs reject recursive schemas,
// so JSON-Logic comes back as a string and is parsed in code. IDs, timestamps and source labels
// are filled in by code (assemble.ts), never by the model.
import { z } from 'zod/v4';

const StepDraft = z.object({
  key: z.string().describe('S1, S2, … in workflow order'),
  title: z.string().describe('Short imperative, e.g. "Code the invoice to a cost center"'),
  screen_moment: z.object({
    label: z.string().describe('What happens on screen at this step, in English'),
    event_ids: z.array(z.string()).describe('event_id values from <screen_events> that show this step'),
    entity: z.string().nullable().describe('Record shown, e.g. "invoice #4471"'),
    field: z.string().nullable(),
  }),
  decision: z.string().describe('What the expert decided or did, e.g. "Re-coded opex (4711) to capex (0400)"'),
  reason: z
    .object({
      quote: z.string().describe("The expert's words, verbatim from the cited turn, original language"),
      quote_en: z.string().describe('English translation of the quote'),
      turn_id: z.string().describe('turn_id from <expert_turns> containing the quote'),
    })
    .nullable()
    .describe('null when the expert never said why'),
  guardrail_keys: z.array(z.string()).describe('Keys of guardrails that apply at this step'),
  is_judgment_call: z.boolean().describe('True when the right action depends on a condition, not routine'),
  screen_signature: z.object({
    app: z.string(),
    record_kind: z.string(),
    field: z.string().nullable(),
  }),
});

const GuardrailDraft = z.object({
  key: z.string().describe('G1, G2, …'),
  kind: z.enum(['threshold', 'condition', 'stop_and_ask', 'second_approval', 'hold']),
  description: z.string().describe('The rule in one plain English sentence'),
  rule_json: z.string().describe('JSON-Logic object as a JSON string; true means the guardrail is triggered'),
  consequence: z.object({
    require: z
      .array(z.object({ field: z.string(), value: z.string() }))
      .describe('Field values the record must have when triggered; empty if none'),
    block: z.boolean().describe('True if saving must be blocked when triggered'),
    action: z.enum(['ask_controller', 'hold', 'second_approval']).nullable(),
  }),
  quote: z.string().describe("The expert's words stating the rule, verbatim, original language"),
  quote_en: z.string(),
  evidence: z
    .array(
      z.object({
        event_id: z.string().nullable().describe('event_id from <screen_events>'),
        turn_id: z.string().describe('turn_id from <expert_turns>'),
      }),
    )
    .describe('At least one entry with both an event_id and a turn_id'),
});

const OpenItemDraft = z.object({
  text: z.string().describe('A question for the expert, in English, specific enough to answer in one or two sentences'),
  importance: z.enum(['high', 'medium', 'low']),
  anchor_event_id: z.string().nullable(),
  anchor_turn_id: z.string().nullable(),
  source: z.enum(['builder', 'unasked_question', 'carried_over']),
  source_ref: z.string().nullable().describe('question_id or open_item_id when source is not builder'),
});

export const WorkMapDraftSchema = z.object({
  title: z.string().describe('Name of the workflow as the expert does it'),
  steps: z.array(StepDraft),
  guardrails: z.array(GuardrailDraft),
  open_items: z.array(OpenItemDraft).describe('3–8 items, most important first'),
});

export type WorkMapDraft = z.infer<typeof WorkMapDraftSchema>;
export type StepDraft = z.infer<typeof StepDraft>;
export type GuardrailDraft = z.infer<typeof GuardrailDraft>;
export type OpenItemDraft = z.infer<typeof OpenItemDraft>;
