import Anthropic from '@anthropic-ai/sdk';
import type { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { FastifyBaseLogger } from 'fastify';
import type { ClaudeUsage } from './usage.js';

/** Claude declined the request (after server-side fallback); retrying the same input won't help. */
export class ClaudeRefusedError extends Error {
  constructor(what: string, category: string | null) {
    super(`Claude declined the ${what} request (${category ?? 'no category'})`);
    this.name = 'ClaudeRefusedError';
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

export type StructuredRequest<T> = {
  /** What is being produced, for logs and errors, e.g. "Work Map draft". */
  what: string;
  model: string;
  system: string;
  input: string;
  format: ReturnType<typeof betaZodOutputFormat>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** Parses and checks the response text beyond the schema. */
  parse: (text: string) => Parsed<T>;
};

/**
 * Explicit timeout: these calls run in background jobs, and an explicit value also opts out of the
 * SDK's "use streaming" guard for large max_tokens. Server errors and 429s retry once in the SDK.
 */
export function claudeClient(apiKey?: string, timeoutMs = 5 * 60_000): Anthropic {
  return new Anthropic({ ...(apiKey && { apiKey }), maxRetries: 1, timeout: timeoutMs });
}

const MAX_ATTEMPTS = 2; // one retry when the output fails validation

/**
 * One structured-output request to Claude, retried once with the problem stated when the output
 * is cut off or fails `parse`. `onUsage` sees every response, failed attempts included, so their
 * cost is still recorded. Refusals are not retried.
 */
export async function callStructured<T>(
  client: Anthropic,
  req: StructuredRequest<T>,
  log: FastifyBaseLogger,
  onUsage: (usage: ClaudeUsage) => Promise<void>,
): Promise<{ value: T; attempts: number }> {
  let problem: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const response = await client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      // Thinking runs adaptively by default on Sonnet 5.5; effort bounds how much.
      output_config: { effort: req.effort, format: req.format },
      // Server-side refusal fallback (Claude API): re-runs a declined request on the model
      // Anthropic recommends for that refusal category.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: req.system,
      messages: [{ role: 'user', content: problem ? `${req.input}\n\n${retryNote(req.what, problem)}` : req.input }],
    });
    const usage = response.usage;
    await onUsage({
      model: response.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    });
    log.info(
      {
        what: req.what,
        attempt,
        model: response.model,
        stop_reason: response.stop_reason,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        latency_ms: Date.now() - started,
      },
      'claude response',
    );

    if (response.stop_reason === 'refusal') throw new ClaudeRefusedError(req.what, response.stop_details?.category ?? null);
    problem = response.stop_reason === 'max_tokens' ? 'The response was cut off at the token limit.' : undefined;
    if (!problem) {
      const parsed = req.parse(response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
      if (parsed.ok) return { value: parsed.value, attempts: attempt };
      problem = parsed.problem;
    }
    log.warn({ what: req.what, attempt, problem }, 'claude output failed validation');
    if (attempt >= MAX_ATTEMPTS) throw new Error(`${req.what} failed validation twice: ${problem}`);
  }
}

/** Parses JSON and checks it against a zod (v4) schema, naming the first few issues. */
export function parseJson<T>(
  text: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } },
): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'The response was not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
    return { ok: false, problem: `The response did not match the schema (${issues.join('; ')}).` };
  }
  return { ok: true, value: parsed.data };
}

/** True when `text` parses to a JSON object (JSON-Logic rules come back as strings). */
export function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

const retryNote = (what: string, problem: string) =>
  `<previous_attempt_problem>\nA previous attempt at this ${what} was rejected: ${problem} Produce it again in full.\n</previous_attempt_problem>`;
