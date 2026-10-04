import { makeEvent, priceUsd, STREAMS, type Bus, type UsageRecord } from '../contracts/index.js';

/** Token counts from one Claude response. */
export type ClaudeUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

// USD per million tokens for the models server-side refusal fallback can route to that the
// platform's PRICE_TABLE doesn't list yet. PRICE_TABLE wins for any model it has.
const FALLBACK_PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

/** USD per input and output token: PRICE_TABLE first, then the fallback-model rates above. */
function perToken(model: string): { input: number; output: number } | undefined {
  const input = priceUsd('anthropic', model, 'tokens_in', 1);
  const output = priceUsd('anthropic', model, 'tokens_out', 1);
  if (input !== undefined && output !== undefined) return { input, output };
  const fallback = FALLBACK_PRICES[model];
  return fallback && { input: fallback.input / 1e6, output: fallback.output / 1e6 };
}

/**
 * Cache writes bill at 1.25x input and cache reads at 0.1x (PRICE_TABLE has no cache rates).
 * Unknown models cost 0, and `priced: false` says so.
 */
export function claudeUsageRecords(u: ClaudeUsage): { records: UsageRecord[]; priced: boolean } {
  const price = perToken(u.model);
  const inputCost = price
    ? price.input * (u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens)
    : 0;
  const outputCost = price ? price.output * u.output_tokens : 0;
  const base = { service: 'mapper', vendor: 'anthropic' } as const;
  return {
    priced: price !== undefined,
    records: [
      {
        ...base,
        unit: 'tokens_in',
        units: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
        cost_usd: round(inputCost),
      },
      { ...base, unit: 'tokens_out', units: u.output_tokens, cost_usd: round(outputCost) },
    ],
  };
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** Publishes usage records for the cost ledger (gateway consumes `sk:usage`). */
export async function publishUsage(
  bus: Bus,
  ctx: { org_id: string; session_id: string; t_ms: number },
  records: UsageRecord[],
): Promise<void> {
  for (const data of records) {
    await bus.publish(STREAMS.usage, makeEvent({ type: 'usage', producer: 'mapper', ...ctx, data }));
  }
}
