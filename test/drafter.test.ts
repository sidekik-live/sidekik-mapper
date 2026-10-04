import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { claudeDrafter, parseDraft } from '../src/build/drafter.js';
import { ClaudeRefusedError } from '../src/services/claude.js';
import type { ClaudeUsage } from '../src/services/usage.js';
import { silentLog } from './helpers.js';

const DRAFT = readFileSync(new URL('../dev/fixtures/sabine-draft.json', import.meta.url), 'utf8');

type Reply = { text?: string; stop_reason?: string; category?: string };

/** A client whose beta.messages.create returns the given replies in order and records requests. */
function fakeClient(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        async create(body: Record<string, unknown>) {
          requests.push(body);
          const reply = replies.shift();
          if (!reply) throw new Error('no more replies');
          return {
            model: 'claude-sonnet-5-5',
            stop_reason: reply.stop_reason ?? 'end_turn',
            stop_details: reply.category ? { type: 'refusal', category: reply.category, explanation: null } : null,
            content: reply.text === undefined ? [] : [{ type: 'text', text: reply.text }],
            usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

async function run(replies: Reply[]) {
  const { client, requests } = fakeClient(replies);
  const usage: ClaudeUsage[] = [];
  const drafter = claudeDrafter({ model: 'claude-sonnet-5-5', client });
  const result = drafter.draft('<session>…</session>', silentLog(), async (u) => {
    usage.push(u);
  });
  return { result, requests, usage };
}

describe('claudeDrafter', () => {
  it('asks Sonnet for structured output with server-side refusal fallback', async () => {
    const { result, requests, usage } = await run([{ text: DRAFT }]);
    const { draft, attempts } = await result;
    expect(attempts).toBe(1);
    expect(draft.steps).toHaveLength(6);
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: '<session>…</session>' }],
    });
    expect(requests[0]).not.toHaveProperty('thinking');
    expect(usage).toEqual([
      { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
  });

  it('retries once with the validation problem, recording usage for both attempts', async () => {
    const { result, requests, usage } = await run([{ text: '{"title": "x"}' }, { text: DRAFT }]);
    expect((await result).attempts).toBe(2);
    expect(usage).toHaveLength(2);
    const retry = (requests[1]!.messages as { content: string }[])[0]!.content;
    expect(retry).toContain('<previous_attempt_problem>');
    expect(retry).toContain('did not match the schema');
  });

  it('retries a response cut off at max_tokens', async () => {
    const { result, requests } = await run([{ text: '{"title": "Supp', stop_reason: 'max_tokens' }, { text: DRAFT }]);
    expect((await result).attempts).toBe(2);
    expect((requests[1]!.messages as { content: string }[])[0]!.content).toContain('cut off at the token limit');
  });

  it('gives up after the second invalid draft', async () => {
    const { result } = await run([{ text: 'not json' }, { text: 'still not json' }]);
    await expect(result).rejects.toThrow(/Work Map draft failed validation twice: The response was not valid JSON/);
  });

  it('does not retry a refusal', async () => {
    const { result, requests } = await run([{ stop_reason: 'refusal', category: 'general_harms' }, { text: DRAFT }]);
    await expect(result).rejects.toBeInstanceOf(ClaudeRefusedError);
    expect(requests).toHaveLength(1);
  });
});

describe('parseDraft', () => {
  it('rejects a rule that is not a JSON-Logic object', () => {
    const draft = JSON.parse(DRAFT) as { guardrails: { rule_json: string }[] };
    draft.guardrails[1]!.rule_json = '["cost_center"]';
    expect(parseDraft(JSON.stringify(draft))).toEqual({
      ok: false,
      problem: 'Guardrail G2 has a rule_json that is not a JSON object.',
    });
  });
});
