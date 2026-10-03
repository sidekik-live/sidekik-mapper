// TEMPORARY: replace with @sidekik/contracts (see ./README.md). Vendor list per docs v0.2.
import { z } from 'zod';

export const UsageRecordSchema = z.object({
  service: z.string(),
  vendor: z.enum(['elevenlabs', 'typesafe', 'anthropic', 'recall']),
  units: z.number(),
  unit: z.enum(['tokens_in', 'tokens_out', 'minutes', 'hours']),
  cost_usd: z.number(),
  counterfactual_usd: z.number().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
