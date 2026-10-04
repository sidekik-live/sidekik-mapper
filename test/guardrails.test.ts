import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Guardrail } from '../src/contracts/index.js';
import { DEMO_CASES, runDemoCases } from '../src/guardrails/demo-cases.js';
import { checkRule, evaluate, triggers } from '../src/guardrails/rules.js';

/** ARCHITECTURE Appendix B, verbatim: the guardrails tutor tests against too. */
const CANONICAL: Guardrail[] = [
  {
    key: 'G1',
    kind: 'threshold',
    rule: { and: [{ '>': [{ var: 'net_amount' }, 5000] }, { '==': [{ var: 'category' }, 'equipment'] }, { '!=': [{ var: 'cost_center' }, '0400'] }] },
    consequence: { require: { cost_center: '0400' } },
  },
  { key: 'G2', kind: 'condition', rule: { and: [{ '==': [{ var: 'cost_center' }, '0400'] }, { '!': { var: 'asset_number' } }] }, consequence: { block: true } },
  { key: 'G3', kind: 'stop_and_ask', rule: { '==': [{ var: 'supplier_known' }, false] }, consequence: { action: 'ask_controller' } },
  {
    key: 'G4',
    kind: 'hold',
    rule: { and: [{ in: [{ var: 'supplier' }, ['Kranbau GmbH']] }, { '==': [{ var: 'invoice_month' }, 12] }] },
    consequence: { action: 'hold' },
  },
  {
    key: 'G5',
    kind: 'second_approval',
    rule: { and: [{ in: ['CZ', { var: 'company_code' }] }, { '<': [{ var: 'approvals_count' }, 2] }] },
    consequence: { action: 'second_approval' },
  },
].map((g) => ({ ...g, id: `id-${g.key}`, description: g.key, quote: '', evidence: [] }) as Guardrail);

const byKey = (key: string) => CANONICAL.find((g) => g.key === key)!;

describe('demo guardrails G1–G5 (DESIGN §6)', () => {
  it.each(DEMO_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const [result] = runDemoCases(CANONICAL, [c]);
    expect(result).toMatchObject({ pass: true });
  });

  it('flags the €7,200 opex invoice on G1 alone, and lets the corrected booking through', () => {
    const c = DEMO_CASES[0]!.state;
    expect(evaluate(CANONICAL, c).triggered.map((t) => t.key)).toEqual(['G1']);
    expect(evaluate(CANONICAL, { ...c, cost_center: '0400', asset_number: 'AN-7' }).triggered).toEqual([]);
  });

  it('G1 is a strict threshold: exactly €5,000 is not capex', () => {
    expect(triggers(byKey('G1').rule, { net_amount: 5000, category: 'equipment', cost_center: '4711' })).toBe(false);
    expect(triggers(byKey('G1').rule, { net_amount: 5000.01, category: 'equipment', cost_center: '4711' })).toBe(true);
  });

  it('G4 holds only Kranbau in December, G5 only CZ company codes below two approvals', () => {
    expect(triggers(byKey('G4').rule, { supplier: 'Kranbau GmbH', invoice_month: 11 })).toBe(false);
    expect(triggers(byKey('G5').rule, { company_code: 'CZ01', approvals_count: 2 })).toBe(false);
    expect(triggers(byKey('G5').rule, { company_code: 'DE01', approvals_count: 1 })).toBe(false);
  });

  it('reports which case a Work Map misses', () => {
    const results = runDemoCases(CANONICAL.filter((g) => g.key !== 'G3'));
    expect(results.filter((r) => !r.pass).map((r) => [r.rule, r.problem])).toEqual([
      ['G3', 'nothing triggered'],
      ['G1+G3', 'expected action ask_controller'],
    ]);
  });

  it("Sabine's recorded draft covers every case except the unknown supplier (G3 is an open item)", () => {
    const draft = JSON.parse(readFileSync(new URL('../dev/fixtures/sabine-draft.json', import.meta.url), 'utf8')) as {
      guardrails: { key: string; rule_json: string; consequence: { require: { field: string; value: string }[]; block: boolean; action: string | null } }[];
    };
    const guardrails = draft.guardrails.map(
      (g) =>
        ({
          id: g.key,
          key: g.key,
          rule: JSON.parse(g.rule_json),
          consequence: {
            ...(g.consequence.require.length > 0 && { require: Object.fromEntries(g.consequence.require.map((r) => [r.field, r.value])) }),
            ...(g.consequence.block && { block: true }),
            ...(g.consequence.action && { action: g.consequence.action }),
          },
        }) as Guardrail,
    );
    expect(runDemoCases(guardrails).filter((r) => !r.pass).map((r) => r.rule)).toEqual(['G3', 'G1+G3']);
  });
});

describe('checkRule', () => {
  it('accepts the canonical rules', () => {
    for (const g of CANONICAL) expect(checkRule(g.rule)).toEqual([]);
  });

  it('rejects variables outside InvoiceState', () => {
    expect(checkRule({ '==': [{ var: 'payment_status' }, 'on_hold'] })).toEqual([
      'rule reads variables outside InvoiceState: payment_status',
    ]);
  });

  it('rejects unknown operators and non-expressions', () => {
    expect(checkRule({ starts_with: [{ var: 'company_code' }, 'CZ'] })[0]).toMatch(/does not evaluate: Unrecognized operation starts_with/);
    expect(checkRule(['cost_center'])).toEqual(['rule is not a JSON-Logic expression (an object with one operator)']);
    expect(checkRule({ and: [], or: [] })).toHaveLength(1);
  });
});
