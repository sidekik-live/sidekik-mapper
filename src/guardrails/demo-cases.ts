import type { Guardrail, InvoiceState } from '../contracts/index.js';
import { evaluate, type Verdict } from './rules.js';

type Expectation = {
  require?: Record<string, string>;
  block?: true;
  action?: 'ask_controller' | 'hold' | 'second_approval';
  /** Nothing may trigger (a routine invoice). */
  none?: true;
};

export type DemoCase = { name: string; rule: string; state: InvoiceState; expect: Expectation };

const base: InvoiceState = {
  supplier: 'Präzisionswerk Ulm',
  supplier_known: true,
  net_amount: 1500,
  currency: 'EUR',
  invoice_month: 9,
  company_code: 'DE01',
  category: 'parts',
  cost_center: '4711',
  approvals_count: 1,
};

/**
 * DESIGN §6 required demo tests (ARCHITECTURE Appendix B), plus a routine control invoice and the
 * Checkpoint 3 tutor case. These are the contract with tutor: keep them green.
 */
export const DEMO_CASES: DemoCase[] = [
  {
    name: 'G1: €7,200 equipment on opex 4711',
    rule: 'G1',
    state: { ...base, net_amount: 7200, category: 'equipment', cost_center: '4711' },
    expect: { require: { cost_center: '0400' } },
  },
  {
    name: 'G2: capex 0400 without an asset number',
    rule: 'G2',
    state: { ...base, net_amount: 7200, category: 'equipment', cost_center: '0400' },
    expect: { block: true },
  },
  {
    name: 'G3: unknown supplier',
    rule: 'G3',
    state: { ...base, supplier: 'Antriebstechnik Nord', supplier_known: false },
    expect: { action: 'ask_controller' },
  },
  {
    name: 'G4: Kranbau GmbH in December',
    rule: 'G4',
    state: { ...base, supplier: 'Kranbau GmbH', category: 'services', net_amount: 2150, invoice_month: 12 },
    expect: { action: 'hold' },
  },
  {
    name: 'G5: Czech subsidiary with one approval',
    rule: 'G5',
    state: { ...base, supplier: 'Strojírna Brno s.r.o.', company_code: 'CZ01', net_amount: 3400 },
    expect: { action: 'second_approval' },
  },
  {
    name: 'routine: office supplies on 4711',
    rule: 'none',
    state: { ...base, supplier: 'Bürobedarf Weber', category: 'office', net_amount: 240 },
    expect: { none: true },
  },
  {
    name: 'Checkpoint 3: €7,200 spindle motor, unknown supplier, on 4711',
    rule: 'G1+G3',
    state: { ...base, supplier: 'Antriebstechnik Nord', supplier_known: false, net_amount: 7200, category: 'equipment' },
    expect: { require: { cost_center: '0400' }, action: 'ask_controller' },
  },
];

export type DemoResult = { name: string; rule: string; pass: boolean; triggered: string[]; problem?: string };

/** Runs every demo case against a Work Map's guardrails. */
export function runDemoCases(guardrails: Guardrail[], cases = DEMO_CASES): DemoResult[] {
  return cases.map((c) => {
    const verdict = evaluate(guardrails, c.state);
    const problem = unmet(c.expect, verdict);
    return {
      name: c.name,
      rule: c.rule,
      pass: problem === undefined,
      triggered: verdict.triggered.map((t) => t.key),
      ...(problem && { problem }),
    };
  });
}

function unmet(expect: Expectation, v: Verdict): string | undefined {
  if (expect.none) return v.triggered.length === 0 ? undefined : `expected nothing, got ${v.triggered.map((t) => t.key).join(', ')}`;
  if (v.triggered.length === 0) return 'nothing triggered';
  for (const [field, value] of Object.entries(expect.require ?? {})) {
    if (v.require[field] !== value) return `expected ${field} ${value} to be required`;
  }
  if (expect.block && !v.block) return 'expected the save to be blocked';
  if (expect.action && !v.actions.includes(expect.action)) return `expected action ${expect.action}`;
  return undefined;
}
