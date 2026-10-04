import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { FastifyBaseLogger } from 'fastify';
import { callStructured, claudeClient, isJsonObject, parseJson, type Parsed } from '../services/claude.js';
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

export type ClaudeDrafterOptions = {
  /** Omit to let the SDK resolve credentials itself (dev:draft). */
  apiKey?: string;
  model: string;
  /** Injected in tests. */
  client?: Anthropic;
};

export function claudeDrafter(opts: ClaudeDrafterOptions): Drafter {
  const client = opts.client ?? claudeClient(opts.apiKey);
  const format = betaZodOutputFormat(WorkMapDraftSchema);
  return {
    async draft(input, log, onUsage) {
      const { value, attempts } = await callStructured(
        client,
        {
          what: 'Work Map draft',
          model: opts.model,
          system: SYSTEM_PROMPT,
          input,
          format,
          // Medium keeps the build within the ~30–60 s the debrief agent needs to restart anyway.
          effort: 'medium',
          maxTokens: 32_000,
          parse: parseDraft,
        },
        log,
        onUsage,
      );
      return { draft: value, attempts };
    },
  };
}

export function parseDraft(text: string): Parsed<WorkMapDraft> {
  const parsed = parseJson(text, WorkMapDraftSchema);
  if (!parsed.ok) return parsed;
  const badRule = parsed.value.guardrails.find((g) => !isJsonObject(g.rule_json));
  if (badRule) return { ok: false, problem: `Guardrail ${badRule.key} has a rule_json that is not a JSON object.` };
  return parsed;
}
