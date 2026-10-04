import jsonLogic from 'json-logic-js';
import { JSONLOGIC_VARIABLES, type Guardrail, type InvoiceState, type JsonLogic } from '../contracts/index.js';

const ALLOWED = new Set<string>(JSONLOGIC_VARIABLES);

/** States every rule is test-run against: an empty record and one with every variable set. */
const PROBES: InvoiceState[] = [
  {},
  {
    net_amount: 1000,
    currency: 'EUR',
    category: 'equipment',
    supplier: 'Probe GmbH',
    supplier_known: true,
    invoice_month: 1,
    company_code: 'DE01',
    cost_center: '4711',
    asset_number: 'AN-1',
    approvals_count: 1,
  },
];

/**
 * Problems that make a rule unusable: not a single-operator JSON-Logic object, a variable outside
 * the normalized InvoiceState, or an operator json-logic-js doesn't know. Empty means valid.
 */
export function checkRule(rule: unknown): string[] {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule) || Object.keys(rule).length !== 1) {
    return ['rule is not a JSON-Logic expression (an object with one operator)'];
  }
  const problems: string[] = [];
  const unknownVars = jsonLogic
    .uses_data(rule)
    .map((v: unknown) => String(v).split('.')[0]!)
    .filter((v: string) => !ALLOWED.has(v));
  if (unknownVars.length > 0) problems.push(`rule reads variables outside InvoiceState: ${[...new Set(unknownVars)].join(', ')}`);
  for (const probe of PROBES) {
    try {
      jsonLogic.apply(rule as JsonLogic, probe);
    } catch (err) {
      problems.push(`rule does not evaluate: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  return problems;
}

/** True when the guardrail's rule fires for this record. */
export function triggers(rule: JsonLogic, state: InvoiceState): boolean {
  return jsonLogic.truthy(jsonLogic.apply(rule, state));
}

export type Verdict = {
  triggered: Pick<Guardrail, 'id' | 'key' | 'consequence'>[];
  /** Field values required by any triggered guardrail. */
  require: Record<string, string>;
  block: boolean;
  actions: NonNullable<Guardrail['consequence']['action']>[];
};

/** Evaluates every guardrail against one record and merges their consequences. */
export function evaluate(guardrails: Guardrail[], state: InvoiceState): Verdict {
  const triggered = guardrails.filter((g) => triggers(g.rule, state));
  return {
    triggered: triggered.map(({ id, key, consequence }) => ({ id, key, consequence })),
    require: Object.assign({}, ...triggered.map((g) => g.consequence.require ?? {})) as Record<string, string>,
    block: triggered.some((g) => g.consequence.block === true),
    actions: [...new Set(triggered.flatMap((g) => (g.consequence.action ? [g.consequence.action] : [])))],
  };
}
