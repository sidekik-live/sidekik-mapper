import { describe, expect, it } from 'vitest';
import { gather, INPUT_TOKEN_BUDGET } from '../src/build/gather.js';
import { renderInput } from '../src/build/prompt.js';
import { SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { memoryStore } from '../src/store/memory.js';
import type { ScreenEventRow } from '../src/store/types.js';

async function gatherSabine(store = memoryStore(sabineCapture())) {
  const session = (await store.getSession(SABINE.session))!;
  return gather(store, { ...session, expert_id: session.expert_id! }, renderInput);
}

describe('gather', () => {
  it('keeps change events only, and nothing from the off-record span', async () => {
    const { input, stats } = await gatherSabine();
    const ids = input.events.map((e) => e.event_id);
    expect(ids).not.toContain('se-03'); // value_read
    expect(ids).not.toContain('se-09'); // idle
    expect(ids).not.toContain('se-16'); // typing_in_progress
    expect(ids).not.toContain('se-14'); // inside the off-record span
    expect(ids).toEqual(['se-01', 'se-02', 'se-04', 'se-05', 'se-06', 'se-07', 'se-08', 'se-10', 'se-11', 'se-12', 'se-13', 'se-15']);
    expect(stats).toMatchObject({ events_total: 16, events_kept: 12, trimmed_for_budget: 0 });
  });

  it("keeps only the expert's on-record turns", async () => {
    const { input } = await gatherSabine();
    const ids = input.turns.map((t) => t.turn_id);
    expect(ids).not.toContain('tt-11'); // flagged off_record
    expect(ids).not.toContain('tt-12'); // inside the span, though not flagged
    expect(ids.some((id) => id.startsWith('tt-2'))).toBe(false); // agent turns
    expect(ids).toHaveLength(11);
  });

  it('pairs asked questions with their answers and lists the unasked ones', async () => {
    const { input } = await gatherSabine();
    expect(input.asked.map((a) => [a.question.id, a.answer?.id])).toEqual([
      ['q-01', 'a-01'],
      ['q-02', 'a-02'],
      ['q-03', 'a-03'],
    ]);
    expect(input.unasked.map((q) => q.id)).toEqual(['q-04', 'q-05']);
  });

  it("carries over only this expert's unresolved open items from earlier sessions", async () => {
    const { input } = await gatherSabine();
    expect(input.carriedOver.map((o) => o.id)).toEqual(['00000000-0000-4000-8000-0000000001a1']);
    expect(input.session).toMatchObject({ workflow_name: 'Supplier invoice coding', expert_name: 'Sabine', language: 'de' });
  });

  it('renders the input without off-record text and with record state only where it matters', async () => {
    const { input } = await gatherSabine();
    const text = renderInput(input);
    expect(text).not.toContain('Ganz unter uns');
    expect(text).not.toContain('Kollege aus dem Einkauf');
    expect(text).toContain('"event_id":"se-04","t":"00:22","type":"field_changed"');
    expect(text).toMatch(/"event_id":"se-06"[^\n]*"type":"button_clicked"/);
    expect(text).not.toMatch(/"event_id":"se-06"[^\n]*"record"/);
  });

  it('trims screen events to the token budget, keeping anchored events and every turn', async () => {
    const seed = sabineCapture();
    const filler: ScreenEventRow[] = Array.from({ length: 4000 }, (_, i) => ({
      ...seed.screen_events![1]!,
      event_id: `fill-${i}`,
      t_ms: 150_000 + i * 100,
      type: i % 3 === 0 ? 'navigation' : 'field_changed',
      confidence: i % 4 === 0 ? 0.3 : 0.9,
    }));
    const { input, stats } = await gatherSabine(memoryStore({ ...seed, screen_events: [...seed.screen_events!, ...filler] }));
    expect(stats.trimmed_for_budget).toBeGreaterThan(0);
    expect(stats.estimated_tokens).toBeLessThanOrEqual(INPUT_TOKEN_BUDGET);
    const ids = new Set(input.events.map((e) => e.event_id));
    for (const anchored of ['se-04', 'se-10', 'se-13']) expect(ids.has(anchored)).toBe(true);
    expect(input.turns).toHaveLength(11);
  });
});
