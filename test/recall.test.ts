import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider } from '../src/clients/brain.js';
import { stubGateway } from '../src/clients/gateway.js';
import { stubPerception } from '../src/clients/perception.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { createPublishJob } from '../src/publish/publish-job.js';
import { RecallContextResponseSchema } from '../src/contracts/index.js';
import { recallContext } from '../src/recall/recall.js';
import { overlap, words } from '../src/recall/words.js';
import { memoryArtifacts } from '../src/store/artifacts.js';
import { memoryStore } from '../src/store/memory.js';
import { buildTestApp, fakeBus, lifecycleEvent, SECRETS, silentLog } from './helpers.js';

/** Sabine's session with her map built, confirmed and published (so kb_chunks exist). */
async function publishedSabine() {
  const store = memoryStore(sabineCapture());
  const bus = fakeBus();
  await createBuildJob({ store, bus, gateway: stubGateway(), decider: stubDecider({ D6: D6_HAS_GAPS }), drafter: fixtureDrafter() })(
    { ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 },
    silentLog(),
  );
  store.data.work_maps[0]!.status = 'confirmed';
  await createPublishJob({ store, bus, perception: stubPerception(), artifacts: memoryArtifacts() })(store.data.work_maps[0]!.id, silentLog());
  const session = (await store.getSession(SABINE.session))!;
  const recall = (query: string, scope: 'session' | 'workflow') => recallContext({ store }, { session, query, scope }, silentLog());
  return { store, recall };
}

describe('recall_context', () => {
  it('workflow scope: published knowledge first, then matching screen events', async () => {
    const { recall } = await publishedSabine();
    const { snippets } = await recall('Kranbau Dezember', 'workflow');
    expect(snippets.length).toBeLessThanOrEqual(5);
    expect(snippets[0]).toMatchObject({ source: expect.stringMatching(/^kb:/), text: expect.stringContaining('Kranbau') });
    expect(snippets[0]).not.toHaveProperty('t_ms');
    expect(RecallContextResponseSchema.parse({ snippets })).toEqual({ snippets });
    expect(snippets.map((s) => s.source)).toEqual(expect.arrayContaining(['kb:step', 'kb:guardrail', 'kb:answer', 'screen']));
    expect(snippets).toContainEqual({
      text: '01:00 record_opened invoice 4480 (Kranbau GmbH, 1980 EUR, services, DE01, cost center 4711, month 12)',
      t_ms: 60_000,
      source: 'screen',
    });
  });

  it("session scope: the expert's own words and the screen, newest first on ties", async () => {
    const { recall } = await publishedSabine();
    const { snippets } = await recall('Anlagennummer 0400', 'session');
    expect(snippets[0]).toEqual({
      text: 'Und ohne Anlagennummer darf ich nicht auf 0400 buchen, das lehnt die Buchhaltung ab.',
      t_ms: 38_000,
      source: 'transcript',
    });
    expect(snippets).toContainEqual({ text: '00:22 field_changed invoice 4471 cost_center: 4711 → 0400', t_ms: 22_000, source: 'screen' });
    expect(snippets.every((s) => !s.source.startsWith('kb:'))).toBe(true);
  });

  it('never returns anything from the off-record span', async () => {
    const { recall } = await publishedSabine();
    for (const scope of ['session', 'workflow'] as const) {
      const { snippets } = await recall('Einkauf Kranbau nachsichtig Kollege off record note', scope);
      expect(snippets.map((s) => s.text).join(' ')).not.toMatch(/Einkauf|Kollege|off the record/);
    }
  });

  it('a question in her words finds her answer, not every turn with "ich"', async () => {
    const { recall } = await publishedSabine();
    const { snippets } = await recall('Was mache ich ohne Anlagennummer?', 'session');
    expect(snippets.map((s) => s.text)).toEqual([
      'Und ohne Anlagennummer darf ich nicht auf 0400 buchen, das lehnt die Buchhaltung ab.',
    ]);
  });

  it('falls back to what is on screen now when nothing matches', async () => {
    const { recall } = await publishedSabine();
    expect((await recall('Wetter morgen', 'workflow')).snippets).toEqual([
      { text: '02:20 button_clicked invoice 4492 save', t_ms: 140_000, source: 'screen' },
      { text: '01:44 button_clicked invoice 4492 request_second_approval', t_ms: 104_000, source: 'screen' },
    ]);
  });

  it('answers from the session when search_kb fails', async () => {
    const { store, recall } = await publishedSabine();
    store.searchKb = async () => {
      throw new Error('rpc failed');
    };
    const { snippets } = await recall('Kranbau', 'workflow');
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.every((s) => s.source === 'screen')).toBe(true);
  });
});

describe('words', () => {
  it('joins digit groups, keeps umlauts and drops stopwords', () => {
    expect(words('Über 5.000 Euro, nicht 5,000€ – Größe!')).toEqual(['über', '5000', 'euro', '5000', 'größe']);
    expect(words('Was mache ich ohne Anlagennummer?')).toEqual(['ohne', 'anlagennummer']);
    expect(overlap(words('Euro 5000 Kranbau'), 'über 5.000 Euro')).toBeCloseTo(2 / 3);
  });
});

describe('POST /internal/tools/recall_context', () => {
  it('answers with snippets, needs the token, and 404s an unknown session', async () => {
    const { store } = await publishedSabine();
    const app = await buildTestApp({ store });
    const post = (body: unknown, token: string | null = SECRETS.internal) =>
      app.inject({ method: 'POST', url: '/internal/tools/recall_context', payload: body as object, headers: token ? { 'x-internal-token': token } : {} });

    const ok = await post({ session_id: SABINE.session, query: 'Kranbau', scope: 'workflow', extra: 'ignored' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { snippets: unknown[] }).snippets.length).toBeGreaterThan(0);
    expect((await post({ session_id: SABINE.session, query: 'Kranbau' })).statusCode).toBe(200); // scope defaults to session
    expect((await post({ session_id: SABINE.session, query: '  ' })).statusCode).toBe(400);
    expect((await post({ session_id: 'nope', query: 'x' })).statusCode).toBe(404);
    expect((await post({ session_id: SABINE.session, query: 'x' }, null)).statusCode).toBe(401);
    await app.close();
  });
});
