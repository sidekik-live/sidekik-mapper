import { describe, expect, it } from 'vitest';
import { claudeUsageRecords } from '../src/services/usage.js';

describe('claudeUsageRecords', () => {
  it('prices Sonnet 5.5 input, cache writes, cache reads and output', () => {
    const { records, priced } = claudeUsageRecords({
      model: 'claude-sonnet-5-5',
      input_tokens: 10_000,
      cache_creation_input_tokens: 4_000,
      cache_read_input_tokens: 20_000,
      output_tokens: 3_000,
    });
    expect(priced).toBe(true);
    // $2/M: 10k + 1.25 × 4k + 0.1 × 20k = 17k token-equivalents → $0.034; output $10/M × 3k → $0.03
    expect(records).toEqual([
      { service: 'mapper', vendor: 'anthropic', unit: 'tokens_in', units: 34_000, cost_usd: 0.034 },
      { service: 'mapper', vendor: 'anthropic', unit: 'tokens_out', units: 3_000, cost_usd: 0.03 },
    ]);
  });

  it('records an unknown model at $0 and says so', () => {
    const { records, priced } = claudeUsageRecords({
      model: 'claude-unknown',
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(priced).toBe(false);
    expect(records.map((r) => r.cost_usd)).toEqual([0, 0]);
  });

  it("takes rates from the platform's PRICE_TABLE, and fallback models from its own table", () => {
    const haiku = claudeUsageRecords({ model: 'claude-haiku-4-5', input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(haiku.records.map((r) => r.cost_usd)).toEqual([1, 5]);
    const opus = claudeUsageRecords({ model: 'claude-opus-4-8', input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(opus).toMatchObject({ priced: true, records: [{ cost_usd: 5 }, { cost_usd: 0 }] });
  });
});
