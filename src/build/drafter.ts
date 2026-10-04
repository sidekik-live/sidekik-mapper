import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { FastifyBaseLogger } from 'fastify';
import type { ClaudeUsage } from '../services/usage.js';
import { WorkMapDraftSchema, type WorkMapDraft } from './draft-schema.js';
import { SYSTEM_PROMPT } from './prompt.js';

export type DraftResult = { draft: WorkMapDraft; attempts: number };

export interface Drafter {
  /**
   * Drafts a Work Map from the rendered session input. `onUsage` is called for every Claude
   * response, including failed attempts, so their cost is still recorded.
   */
  draft(input: string, log: FastifyBaseLogger, onUsage: (usage: ClaudeUsage) => Promise<void>): Promise<DraftResult>;
}

/** Claude declined the request (after server-side fallback); retrying the same input won't help. */
export class DraftRefusedError extends Error {
  constructor(category: string | null) {
    super(`Claude declined to draft the Work Map (${category ?? 'no category'})`);
    this.name = 'DraftRefusedError';
  }
}

export type ClaudeDrafterOptions = {
  /** Omit to let the SDK resolve credentials itself (dev:draft). */
  apiKey?: string;
  model: string;
  /** Injected in tests. */
  client?: Anthropic;
};

const MAX_ATTEMPTS = 2; // DESIGN §4: one retry on validation failure
const MAX_TOKENS = 32_000;
// Explicit timeout: the build runs as an async job, and an explicit value also opts out of the
// SDK's "use streaming" guard for large max_tokens. Server errors and 429s retry once in the SDK.
const TIMEOUT_MS = 5 * 60_000;

export function claudeDrafter(opts: ClaudeDrafterOptions): Drafter {
  const client = opts.client ?? new Anthropic({ ...(opts.apiKey && { apiKey: opts.apiKey }), maxRetries: 1, timeout: TIMEOUT_MS });
  const format = betaZodOutputFormat(WorkMapDraftSchema);

  return {
    async draft(input, log, onUsage) {
      let problem: string | undefined;
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        const response = await client.beta.messages.create({
          model: opts.model,
          max_tokens: MAX_TOKENS,
          // Thinking runs adaptively by default on Sonnet 5.5. Medium effort keeps the build
          // within the ~30–60 s the debrief agent needs to restart anyway.
          output_config: { effort: 'medium', format },
          // Server-side refusal fallback (Claude API): re-runs a declined request on the model
          // Anthropic recommends for that refusal category.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: problem ? `${input}\n\n${retryNote(problem)}` : input }],
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
            attempt,
            model: response.model,
            stop_reason: response.stop_reason,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            latency_ms: Date.now() - started,
          },
          'draft response',
        );

        if (response.stop_reason === 'refusal') throw new DraftRefusedError(response.stop_details?.category ?? null);
        problem = response.stop_reason === 'max_tokens' ? 'The response was cut off at the token limit.' : undefined;
        if (!problem) {
          const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
          const parsed = parseDraft(text);
          if (parsed.ok) return { draft: parsed.draft, attempts: attempt };
          problem = parsed.problem;
        }
        log.warn({ attempt, problem }, 'draft failed validation');
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Work Map draft failed validation twice: ${problem}`);
      }
    },
  };
}

export function parseDraft(text: string): { ok: true; draft: WorkMapDraft } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'The response was not valid JSON.' };
  }
  const parsed = WorkMapDraftSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, problem: `The response did not match the schema (${issues.join('; ')}).` };
  }
  const badRule = parsed.data.guardrails.find((g) => !isJsonObject(g.rule_json));
  if (badRule) return { ok: false, problem: `Guardrail ${badRule.key} has a rule_json that is not a JSON object.` };
  return { ok: true, draft: parsed.data };
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

const retryNote = (problem: string) =>
  `<previous_attempt_problem>\nA previous attempt at this Work Map was rejected: ${problem} Produce the complete Work Map again.\n</previous_attempt_problem>`;
