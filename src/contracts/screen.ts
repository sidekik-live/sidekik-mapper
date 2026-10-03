// TEMPORARY: replace with @sidekik/contracts (see ./README.md). DomEvent is here only for the bus schema map.
import { z } from 'zod';

export const InvoiceStateSchema = z.object({
  invoice_id: z.string().optional(),
  supplier: z.string().optional(),
  supplier_known: z.boolean().optional(),
  net_amount: z.number().optional(),
  currency: z.string().optional(),
  invoice_date: z.string().optional(),
  invoice_month: z.number().optional(),
  company_code: z.string().optional(),
  category: z.string().optional(),
  cost_center: z.string().optional(),
  asset_number: z.string().optional(),
  approvals_count: z.number().optional(),
});
export type InvoiceState = z.infer<typeof InvoiceStateSchema>;

export const DomEventSchema = z.object({
  kind: z.enum(['field_focus', 'field_change', 'save_attempt', 'record_open']),
  record: z.object({ kind: z.string(), id: z.string() }).optional(),
  field: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  state: InvoiceStateSchema.optional(),
});
export type DomEvent = z.infer<typeof DomEventSchema>;
