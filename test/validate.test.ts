import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleWorkMap } from '../src/build/assemble.js';
import type { WorkMapDraft } from '../src/build/draft-schema.js';
import { gather } from '../src/build/gather.js';
import { renderInput } from '../src/build/prompt.js';
import { validateWorkMap } from '../src/build/validate.js';
import { WorkMapSchema } from '../src/contracts/index.js';
import { SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { memoryStore } from '../src/store/memory.js';

const sabineDraft = (): WorkMapDraft =>
  JSON.parse(readFileSync(new URL('../dev/fixtures/sabine-draft.json', import.meta.url), 'utf8')) as WorkMapDraft;

async function validate(edit: (draft: WorkMapDraft) => void = () => {}) {
  const store = memoryStore(sabineCapture());
  const session = (await store.getSession(SABINE.session))!;
  const { input } = await gather(store, { ...session, expert_id: session.expert_id! }, renderInput);
  const draft = sabineDraft();
  edit(draft);
  const assembled = assembleWorkMap({ id: 'wm-1', version: 1, input, draft });
  let n = 0;
  return validateWorkMap({ workmap: assembled.workmap, openItems: assembled.openItems, input, newId: () => `new-${++n}` });
}

describe('validateWorkMap', () => {
  it("leaves Sabine's recorded draft as it is", async () => {
    const { workmap, issues, openItems } = await validate();
    expect(issues).toEqual([]);
    expect(WorkMapSchema.parse(workmap)).toEqual(workmap);
    expect(workmap.steps).toHaveLength(6);
    expect(workmap.guardrails).toHaveLength(4);
    expect(openItems).toHaveLength(4);
  });

  it('turns a rule over a variable outside InvoiceState into an open item', async () => {
    const { workmap, openItems, issues } = await validate((d) => {
      d.guardrails[2]!.rule_json = '{"==":[{"var":"payment_status"},"on_hold"]}'; // G4
    });
    expect(workmap.guardrails.map((g) => g.key)).toEqual(['G1', 'G2', 'G5']);
    expect(workmap.steps.find((s) => s.key === 'S4')!.guardrail_ids).toEqual([]);
    expect(issues).toEqual(['guardrail G4 dropped: rule reads variables outside InvoiceState: payment_status']);
    // Ties keep their order, so it follows the draft's own high-importance item.
    expect(openItems.map((o) => [o.id.startsWith('new-') ? o.id : 'draft', o.importance]).slice(0, 2)).toEqual([
      ['draft', 3],
      ['new-1', 3],
    ]);
    expect(openItems[1]).toMatchObject({
      text: 'Confirm the rule "Hold every December invoice from Kranbau GmbH and check for duplicates.": when exactly does it apply?',
      importance: 3,
      origin: 'builder',
      anchor_t_ms: 70_000,
      work_map_id: 'wm-1',
    });
    expect(workmap.open_items.map((o) => o.id)).toEqual(openItems.map((o) => o.id));
  });

  it('turns a guardrail with no screen evidence into an open item (the unknown-supplier rule)', async () => {
    const { workmap, issues, openItems } = await validate((d) => {
      d.guardrails.push({
        key: 'G3',
        kind: 'stop_and_ask',
        description: 'Ask the controller before booking an unknown supplier.',
        rule_json: '{"==":[{"var":"supplier_known"},false]}',
        consequence: { require: [], block: false, action: 'ask_controller' },
        quote: 'Wenn ich einen Lieferanten nicht kenne, frage ich immer erst den Controller',
        quote_en: "If I don't know a supplier, I always ask the controller first",
        evidence: [{ event_id: null, turn_id: 'tt-10' }],
      });
    });
    expect(workmap.guardrails.map((g) => g.key)).not.toContain('G3');
    expect(issues).toEqual(["guardrail G3 dropped: needs a screen event and the expert's words as evidence"]);
    expect(openItems.find((o) => o.id === 'new-1')).toMatchObject({
      text: 'Confirm the rule "Ask the controller before booking an unknown supplier." and show where it applies on screen.',
      importance: 3,
      anchor_t_ms: 120_000,
    });
  });

  it('re-cites a quote that is in another turn, and replaces one that is nowhere verbatim', async () => {
    const { workmap, issues } = await validate((d) => {
      d.steps[1]!.reason!.turn_id = 'tt-04'; // S2's quote is really from tt-03
      d.steps[2]!.reason!.quote = 'Ohne Anlagennummer geht es nicht.'; // paraphrase of tt-05
      d.guardrails[0]!.quote = 'Alles, was Ausrüstung ist und über 5000 Euro netto kostet'; // G1: punctuation differs only
    });
    expect(issues).toEqual([
      'step S2: reason quote is from turn tt-03; re-cited',
      'step S3: reason quote not found verbatim; replaced with turn tt-05',
    ]);
    expect(workmap.steps[1]!.reason).toMatchObject({ turn_id: 'tt-03', source_label: 'Sabine · 00:24' });
    expect(workmap.steps[2]!.reason).toEqual({
      quote: 'Und ohne Anlagennummer darf ich nicht auf 0400 buchen, das lehnt die Buchhaltung ab.',
      turn_id: 'tt-05',
      source_label: 'Sabine · 00:38',
    });
  });

  it('drops unknown IDs, and a step left without a screen event', async () => {
    const { workmap, issues, openItems } = await validate((d) => {
      d.steps[0]!.screen_moment.event_ids = ['se-02', 'se-99'];
      d.steps[5]!.screen_moment.event_ids = ['se-14']; // off the record: not in the input
      d.guardrails[1]!.evidence.push({ event_id: 'se-77', turn_id: 'tt-05' }, { event_id: 'se-05', turn_id: 'tt-11' });
    });
    expect(issues).toEqual([
      'guardrail G2: dropped unknown event se-77 from evidence',
      'guardrail G2: dropped evidence citing unknown turn tt-11',
      'step S1: dropped unknown screen events',
      'step S6: dropped unknown screen events',
      'step S6 dropped: no screen event shows it',
    ]);
    expect(workmap.steps.map((s) => [s.key, s.ordinal])).toEqual([
      ['S1', 1],
      ['S2', 2],
      ['S3', 3],
      ['S4', 4],
      ['S5', 5],
    ]);
    expect(workmap.steps[0]!.screen_moment.event_ids).toEqual(['se-02']);
    expect(workmap.guardrails[1]!.evidence).toEqual([
      { event_id: 'se-05', keyframe_id: '00000000-0000-4000-8000-000000000f03', turn_id: 'tt-05', t_ms: 36_000 },
      { turn_id: 'tt-05', t_ms: 38_000 },
    ]);
    expect(openItems.find((o) => o.text.includes('Save the coded invoice'))).toMatchObject({ importance: 2 });
  });
});
