import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { assembleWorkMap } from '../src/build/assemble.js';
import type { WorkMapDraft } from '../src/build/draft-schema.js';
import { gather } from '../src/build/gather.js';
import { renderInput } from '../src/build/prompt.js';
import { applyMapPatch, parseCorrection, parsePatch, templateRestatement, type AnswerPatch } from '../src/debrief/patch.js';
import { claudeTeachbackWriter, reconfirmScript, templateTeachback } from '../src/debrief/teachback.js';
import { SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { memoryStore } from '../src/store/memory.js';
import { silentLog } from './helpers.js';

async function sabine() {
  const store = memoryStore(sabineCapture());
  const session = (await store.getSession(SABINE.session))!;
  const { input } = await gather(store, { ...session, expert_id: session.expert_id! }, renderInput);
  const draft = JSON.parse(readFileSync(new URL('../dev/fixtures/sabine-draft.json', import.meta.url), 'utf8')) as WorkMapDraft;
  let n = 0;
  const { workmap } = assembleWorkMap({ id: 'wm-1', version: 1, input, draft, newId: () => `id-${++n}` });
  return { workmap, input };
}

const answer = [{ turn_id: 'db-1', text: 'Ohne Lieferantennummer frage ich den Controller. Und bei Kranbau prüfe ich auf Duplikate.', t_ms: 250_000 }];
const none: AnswerPatch = { resolves_item: true, set_reasons: [], add_evidence: [], add_guardrails: [] };

describe('applyMapPatch', () => {
  it('sets reasons, adds evidence and new guardrails with the next key', async () => {
    const { workmap, input } = await sabine();
    const g4 = workmap.guardrails.find((g) => g.key === 'G4')!;
    const { workmap: patched, changes, warnings } = applyMapPatch({
      workmap,
      turns: answer,
      events: input.events,
      expert: 'Sabine',
      newId: () => 'g-new',
      patch: {
        ...none,
        set_reasons: [{ step_key: 'S6', quote: 'Ohne Lieferantennummer', quote_en: 'Without a supplier number', turn_id: 'db-1' }],
        add_evidence: [{ guardrail_key: 'G4', turn_id: 'db-1', event_id: 'se-10' }],
        add_guardrails: [
          {
            kind: 'stop_and_ask',
            description: 'Unknown supplier: ask the controller.',
            rule_json: '{"==":[{"var":"supplier_known"},false]}',
            consequence: { require: [], block: false, action: 'ask_controller' },
            quote: 'frage ich den Controller',
            quote_en: 'I ask the controller',
            step_keys: ['S1'],
            evidence: [{ event_id: 'se-02', turn_id: 'db-1' }],
          },
        ],
      },
    });
    expect(warnings).toEqual([]);
    expect(changes).toEqual(['S6: reason set', 'G4: evidence added', 'G6: added (Unknown supplier: ask the controller.)']);
    expect(patched.steps.find((s) => s.key === 'S6')!.reason).toEqual({
      quote: 'Ohne Lieferantennummer',
      quote_en: 'Without a supplier number',
      turn_id: 'db-1',
      source_label: 'Sabine · 04:10',
    });
    expect(patched.guardrails.find((g) => g.key === 'G4')!.evidence.at(-1)).toEqual({
      event_id: 'se-10',
      keyframe_id: '00000000-0000-4000-8000-000000000f05',
      turn_id: 'db-1',
      t_ms: 250_000,
    });
    const added = patched.guardrails.at(-1)!;
    expect(added).toMatchObject({ id: 'g-new', key: 'G6', rule: { '==': [{ var: 'supplier_known' }, false] }, consequence: { action: 'ask_controller' } });
    expect(patched.steps.find((s) => s.key === 'S1')!.guardrail_ids).toEqual(['g-new']);
    // The input map is not modified.
    expect(workmap.guardrails.find((g) => g.key === 'G4')!.evidence).toEqual(g4.evidence);
    expect(workmap.guardrails).toHaveLength(4);
  });

  it('skips references to unknown steps, guardrails and non-answer turns', async () => {
    const { workmap, input } = await sabine();
    const { changes, warnings } = applyMapPatch({
      workmap,
      turns: answer,
      events: input.events,
      expert: 'Sabine',
      patch: {
        ...none,
        set_reasons: [
          { step_key: 'S9', quote: 'x', quote_en: 'x', turn_id: 'db-1' },
          { step_key: 'S2', quote: 'x', quote_en: 'x', turn_id: 'tt-03' },
        ],
        add_evidence: [{ guardrail_key: 'G9', turn_id: 'db-1', event_id: null }],
      },
    });
    expect(changes).toEqual([]);
    expect(warnings).toEqual([
      'reason for S9: unknown step',
      'reason for S2: tt-03 is not an expert turn of this exchange',
      'evidence for G9: unknown guardrail',
    ]);
  });
});

describe('applyMapPatch with a correction', () => {
  const correction = [{ turn_id: 'db-9', text: 'Nein, Ausrüstung ist erst ab 10.000 Euro Capex. Und den Schritt mit dem Speichern brauchst du nicht.', t_ms: 300_000 }];

  it('rewrites a guardrail with the correction as evidence, and removes what the expert rejects', async () => {
    const { workmap, input } = await sabine();
    const g1 = workmap.guardrails.find((g) => g.key === 'G1')!;
    const { workmap: patched, changes, warnings, touched } = applyMapPatch({
      workmap,
      turns: correction,
      events: input.events,
      expert: 'Sabine',
      patch: {
        ...none,
        update_steps: [{ step_key: 'S2', title: null, decision: 'Re-coded equipment over €10,000 to capex (0400)' }],
        update_guardrails: [
          {
            guardrail_key: 'G1',
            description: 'Equipment over €10,000 net is capex on cost center 0400.',
            rule_json: '{"and":[{">":[{"var":"net_amount"},10000]},{"==":[{"var":"category"},"equipment"]},{"!=":[{"var":"cost_center"},"0400"]}]}',
            consequence: null,
            quote: 'Ausrüstung ist erst ab 10.000 Euro Capex',
            quote_en: 'Equipment only counts as capex from €10,000',
            turn_id: 'db-9',
          },
        ],
        remove_steps: ['S6'],
        remove_guardrails: ['G5'],
      },
    });
    expect(warnings).toEqual([]);
    expect(changes).toEqual(['S6: removed', 'G5: removed', 'S2: updated', 'G1: corrected']);
    expect(touched).toEqual({
      steps: ['S2'],
      guardrails: ['G1'],
      removed: ['Save the coded invoice', 'Invoices for the Czech subsidiary always need a second approval.'],
    });
    const updated = patched.guardrails.find((g) => g.key === 'G1')!;
    expect(updated.rule).toMatchObject({ and: [{ '>': [{ var: 'net_amount' }, 10000] }, expect.anything(), expect.anything()] });
    expect(updated.consequence).toEqual(g1.consequence); // null keeps it
    expect(updated.quote).toBe('Ausrüstung ist erst ab 10.000 Euro Capex');
    expect(updated.evidence.at(-1)).toEqual({ turn_id: 'db-9', t_ms: 300_000 });
    expect(patched.steps.map((s) => s.key)).not.toContain('S6');
    expect(patched.guardrails.map((g) => g.key)).toEqual(['G1', 'G2', 'G4']);
    expect(patched.steps.find((s) => s.key === 'S5')!.guardrail_ids).toEqual([]);

    expect(templateRestatement(patched, touched)).toBe(
      "I've corrected it. Code equipment over €5,000 as capex: Re-coded equipment over €10,000 to capex (0400). " +
        'Equipment over €10,000 net is capex on cost center 0400. I removed "Save the coded invoice". ' +
        'I removed "Invoices for the Czech subsidiary always need a second approval.".',
    );
  });

  it('skips a guardrail update that cites a turn outside the correction', async () => {
    const { workmap, input } = await sabine();
    const { changes, warnings } = applyMapPatch({
      workmap,
      turns: correction,
      events: input.events,
      expert: 'Sabine',
      patch: {
        ...none,
        update_guardrails: [
          { guardrail_key: 'G1', description: 'x', rule_json: null, consequence: null, quote: 'x', quote_en: 'x', turn_id: 'tt-04' },
        ],
      },
    });
    expect(changes).toEqual([]);
    expect(warnings).toEqual(['update G1: tt-04 is not an expert turn of this exchange']);
  });
});

describe('parsePatch', () => {
  it('rejects a new guardrail whose rule is not a JSON object', () => {
    const patch = {
      ...none,
      add_guardrails: [
        {
          kind: 'condition',
          description: 'x',
          rule_json: '"supplier_known"',
          consequence: { require: [], block: true, action: null },
          quote: 'x',
          quote_en: 'x',
          step_keys: [],
          evidence: [],
        },
      ],
    };
    expect(parsePatch(JSON.stringify(patch))).toEqual({ ok: false, problem: 'New guardrail 1 has a rule_json that is not a JSON object.' });
    expect(parsePatch(JSON.stringify(none))).toEqual({ ok: true, value: none });
  });

  it('rejects a corrected rule that is not a JSON-Logic object, and accepts null for "keep it"', () => {
    const base = { ...none, update_steps: [], remove_steps: [], remove_guardrails: [], restatement: 'Korrigiert.' };
    const update = { guardrail_key: 'G1', description: 'x', rule_json: '[1]', consequence: null, quote: 'x', quote_en: 'x', turn_id: 't' };
    expect(parseCorrection(JSON.stringify({ ...base, update_guardrails: [update] }))).toEqual({
      ok: false,
      problem: 'The update to G1 has a rule_json that is not a JSON object.',
    });
    expect(parseCorrection(JSON.stringify({ ...base, update_guardrails: [{ ...update, rule_json: null }] })).ok).toBe(true);
  });
});

describe('teach-back', () => {
  it('builds a template from the map: steps in order, reasons verbatim, rules', async () => {
    const { workmap } = await sabine();
    const script = templateTeachback(workmap);
    expect(script).toMatch(/^Here is how you do Supplier invoice coding\. First, open the invoice and check the supplier:/);
    expect(script).toContain('Because, in your words: "Das ist eine Maschine über 5.000 Euro, das ist Anlagevermögen."');
    expect(script).toContain('The rule here: Equipment over €5,000 net is always capex on cost center 0400.');
  });

  it('asks Claude in the session language and falls back to the template when Claude fails', async () => {
    const { workmap } = await sabine();
    const requests: { messages: { content: string }[] }[] = [];
    const reply = (text: string) => ({
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      stop_details: null,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const replies = [reply('{"script":"Sie öffnen die Rechnung …"}'), reply('not json'), reply('still not json')];
    const client = {
      beta: { messages: { create: async (body: { messages: { content: string }[] }) => (requests.push(body), replies.shift()) } },
    } as unknown as Anthropic;
    const writer = claudeTeachbackWriter({ model: 'claude-sonnet-5-5', client });
    const noUsage = async () => {};

    expect(await writer.write(workmap, 'de', silentLog(), noUsage)).toBe('Sie öffnen die Rechnung …');
    expect(requests[0]!.messages[0]!.content).toMatch(/^<language>German<\/language>/);
    expect(await writer.write(workmap, 'de', silentLog(), noUsage)).toBe(templateTeachback(workmap));
  });

  it('re-asks in the session language', () => {
    expect(reconfirmScript('de')).toMatch(/^Kurze Rückfrage/);
    expect(reconfirmScript('en')).toMatch(/^Quick check/);
  });
});
