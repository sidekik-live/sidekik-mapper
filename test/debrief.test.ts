import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider, type Decider } from '../src/clients/brain.js';
import { stubGateway, type PhaseRequest } from '../src/clients/gateway.js';
import { makeEvent, STREAMS, type AgentCommand, type QuestionAnswer, type TranscriptTurn } from '../src/contracts/index.js';
import { DebriefDriver, plainYes } from '../src/debrief/driver.js';
import { noopCorrector, type AnswerPatch, type AnswerPatcher, type Correction, type CorrectionPatcher } from '../src/debrief/patch.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { runDemoCases } from '../src/guardrails/demo-cases.js';
import { memoryStore } from '../src/store/memory.js';
import { fakeBus, lifecycleEvent, silentLog } from './helpers.js';

const NOT_DONE = { expert_signals_done: { answer: false, confidence: 0.9, p_true: 0.1 } };
const DONE = { expert_signals_done: { answer: true, confidence: 0.95, p_true: 0.95 } };
const d8 = (answer: string, confidence = 0.92): Record<string, QuestionAnswer> => ({ teachback_reply: { answer, confidence } });

const SUPPLIER_ANSWER = 'Ja, wenn ich einen Lieferanten nicht kenne, frage ich immer zuerst den Controller, bevor ich buche.';

/** Patcher stand-in: the unknown-supplier answer adds that guardrail; other answers just resolve. */
const patcher = (): AnswerPatcher & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async patch({ item, answer }) {
      calls.push(item.text);
      const none: AnswerPatch = { resolves_item: true, set_reasons: [], add_evidence: [], add_guardrails: [] };
      if (!item.text.includes('ask the controller first')) return none;
      return {
        ...none,
        add_guardrails: [
          {
            kind: 'stop_and_ask',
            description: 'Unknown supplier: ask the controller before booking.',
            rule_json: '{"==":[{"var":"supplier_known"},false]}',
            consequence: { require: [], block: false, action: 'ask_controller' },
            quote: 'wenn ich einen Lieferanten nicht kenne, frage ich immer zuerst den Controller',
            quote_en: "if I don't know a supplier, I always ask the controller first",
            step_keys: ['S1'],
            evidence: [{ event_id: 'se-02', turn_id: answer[0]!.turn_id }],
          },
        ],
      };
    },
  };
};

async function setup(opts: { decider?: Decider; patcher?: AnswerPatcher; corrector?: CorrectionPatcher } = {}) {
  const store = memoryStore(sabineCapture());
  const bus = fakeBus();
  const phases: PhaseRequest[] = [];
  const gateway = stubGateway((_id, body) => phases.push(body));
  const decider = opts.decider ?? stubDecider({ D6: D6_HAS_GAPS, D12: NOT_DONE, D8: d8('confirmed') });
  const build = createBuildJob({ store, bus, gateway, decider, drafter: fixtureDrafter() });
  await build({ ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 }, silentLog());
  const p = opts.patcher ?? patcher();
  const driver = new DebriefDriver({
    store,
    bus,
    gateway,
    decider,
    patcher: p,
    corrector: opts.corrector ?? noopCorrector,
    teachback: { write: async () => 'SCRIPT' },
  });

  let t = 200_000;
  let n = 0;
  const turn = async (role: TranscriptTurn['role'], text: string) => {
    t += 3_000;
    const ev = makeEvent({
      type: 'transcript.turn',
      org_id: SABINE.org,
      session_id: SABINE.session,
      t_ms: t,
      producer: 'gateway',
      data: { turn_id: `db-${++n}`, role, text, lang: 'de', source: 'live', redacted: true } satisfies TranscriptTurn,
    });
    await driver.onTurn(ev, silentLog());
    return ev.data.turn_id;
  };
  const commands = () =>
    bus.published.filter((x) => x.stream === STREAMS.commands).map((x) => x.ev.data as AgentCommand);
  const start = () => driver.start({ ...lifecycleEvent({ event: 'phase_changed', phase: 'debrief' }, SABINE.session), t_ms: 190_000 }, silentLog());
  const map = () => store.data.work_maps[0]!;
  const items = () => store.data.open_items.filter((o) => o.work_map_id === map().id);
  /** Answers the current follow-up and lets the silence window pass. */
  const answer = async (text: string) => {
    await turn('agent', 'Frage …');
    await turn('user', text);
    await vi.advanceTimersByTimeAsync(2_000);
  };
  return { store, bus, driver, phases, patcher: p, turn, commands, start, map, items, answer };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('debrief driver', () => {
  it("runs Sabine's debrief: 3 follow-ups, teach-back, confirmation on her \"Ja, passt\"", async () => {
    const s = await setup();
    await s.start();
    expect(s.commands()).toEqual([]); // waits for the agent's greeting

    await s.turn('agent', 'Hallo Sabine, ich habe ein paar Rückfragen.');
    expect(s.commands().map((c) => c.type)).toEqual(['followup']);
    expect(s.commands()[0]).toMatchObject({ text: expect.stringContaining('ask the controller first') });

    await s.answer(SUPPLIER_ANSWER);
    await s.answer('Dann lege ich zuerst eine Anlagennummer im Anlagenmodul an.');
    await s.answer('Ab 10.000 Euro brauchen wir in DE01 eine zweite Freigabe.');
    const cmds = s.commands();
    expect(cmds.map((c) => c.type)).toEqual(['followup', 'followup', 'followup', 'teachback']);
    expect(cmds[3]).toEqual({ type: 'teachback', workmap_id: s.map().id, script: 'SCRIPT' });

    // The answers are in the map before the teach-back goes out.
    const g = s.map().json.guardrails.find((x) => x.description.startsWith('Unknown supplier'))!;
    expect(g).toMatchObject({ key: 'G6', consequence: { action: 'ask_controller' } });
    expect(g.evidence).toEqual([
      expect.objectContaining({ event_id: 'se-02', turn_id: 'db-3', keyframe_id: '00000000-0000-4000-8000-000000000f01' }),
    ]);
    expect(s.map().json.steps.find((x) => x.key === 'S1')!.guardrail_ids).toContain(g.id);

    await s.turn('agent', 'So machen Sie das: …');
    const yes = await s.turn('user', 'Ja, passt.');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(s.map()).toMatchObject({ status: 'confirmed' });
    expect(s.map().json).toMatchObject({ status: 'confirmed', confirmed_turn_id: yes });
    expect(s.phases.map((p) => p.phase)).toEqual(['debrief', 'confirmed']);
    expect(s.items().map((o) => [o.importance, o.status])).toEqual([
      [3, 'resolved'],
      [2, 'resolved'],
      [2, 'resolved'],
      [1, 'open'],
    ]);
    // With the debrief's G6, every demo case passes, Checkpoint 3 included.
    expect(runDemoCases(s.map().json.guardrails).filter((d) => !d.pass)).toEqual([]);
    expect(s.driver.active(SABINE.session)).toBe(false);
  });

  it('starts the follow-ups if the agent never greets', async () => {
    const s = await setup();
    await s.start();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(s.commands()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.commands().map((c) => c.type)).toEqual(['followup']);
  });

  it('asks an unanswered follow-up again, then moves on', async () => {
    const s = await setup();
    await s.start();
    await s.turn('agent', 'Hallo!');
    await vi.advanceTimersByTimeAsync(60_000);
    const [first, again] = s.commands();
    expect(again).toEqual(first);
    await vi.advanceTimersByTimeAsync(60_000);
    const third = s.commands()[2]!;
    expect(third.type).toBe('followup');
    expect(third).not.toEqual(first);
    expect(s.items().find((o) => o.id === (first as { open_item_id: string }).open_item_id)!.status).toBe('asked');
  });

  it('ignores talk while the teach-back is read, and asks again on an unclear reply', async () => {
    const decide = vi.fn();
    const answers = [d8('unclear', 0.9), d8('confirmed', 0.9)];
    const base = stubDecider({ D6: D6_HAS_GAPS, D12: NOT_DONE });
    const decider: Decider = {
      async decide(sid, decisions) {
        if (decisions[0]!.id !== 'D8') return base.decide(sid, decisions);
        decide(decisions[0]!.state);
        return stubDecider({ D8: answers.shift()! }).decide(sid, decisions);
      },
    };
    const s = await setup({ decider });
    await s.start();
    await s.turn('agent', 'Hallo!');
    for (const a of ['a', 'b', 'c']) await s.answer(a);

    await s.turn('user', 'Mhm.'); // before the agent has read the script
    await vi.advanceTimersByTimeAsync(2_000);
    expect(decide).not.toHaveBeenCalled();

    await s.turn('agent', 'So machen Sie das: …');
    await s.turn('user', 'Hm, weiß nicht.');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(decide).toHaveBeenCalledWith({ teachback: 'SCRIPT', reply: 'Hm, weiß nicht.' });
    expect(s.commands().at(-1)).toEqual({
      type: 'teachback',
      workmap_id: s.map().id,
      script: 'Kurze Rückfrage: Stimmt die Zusammenfassung so, oder möchten Sie etwas ändern?',
    });

    await s.turn('agent', 'Kurze Rückfrage …');
    await s.turn('user', 'Doch, stimmt so.');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.map().status).toBe('confirmed');
  });

  describe('corrections', () => {
    /** brain: D6/D12 as usual, D8 answers from the queue in order. */
    const d8Queue = (...answers: string[]): Decider => {
      const base = stubDecider({ D6: D6_HAS_GAPS, D12: NOT_DONE });
      return {
        async decide(sid, decisions) {
          if (decisions[0]!.id !== 'D8') return base.decide(sid, decisions);
          return stubDecider({ D8: d8(answers.shift() ?? 'unclear') }).decide(sid, decisions);
        },
      };
    };
    const correction = (over: Partial<Correction> = {}): Correction => ({
      set_reasons: [],
      add_evidence: [],
      add_guardrails: [],
      update_steps: [],
      update_guardrails: [],
      remove_steps: [],
      remove_guardrails: [],
      restatement: 'Verstanden: Ausrüstung ist erst ab 10.000 Euro Capex.',
      ...over,
    });
    const raiseG1 = (turnId: string): Partial<Correction> => ({
      update_guardrails: [
        {
          guardrail_key: 'G1',
          description: 'Equipment over €10,000 net is capex on cost center 0400.',
          rule_json: '{"and":[{">":[{"var":"net_amount"},10000]},{"==":[{"var":"category"},"equipment"]},{"!=":[{"var":"cost_center"},"0400"]}]}',
          consequence: null,
          quote: 'Ausrüstung ist erst ab 10.000 Euro Capex',
          quote_en: 'Equipment only counts as capex from €10,000',
          turn_id: turnId,
        },
      ],
    });

    /** Runs the follow-ups and has the agent read the teach-back. */
    async function toTeachback(s: Awaited<ReturnType<typeof setup>>) {
      await s.start();
      await s.turn('agent', 'Hallo!');
      for (const a of ['a', 'b', 'c']) await s.answer(a);
      await s.turn('agent', 'So machen Sie das: …');
    }
    const CORRECTION_TEXT = 'Nein, Ausrüstung ist erst ab 10.000 Euro Capex.';

    it('patches the map, restates only the correction, and confirms on the next yes', async () => {
      const calls: { script: string; correction: string[] }[] = [];
      const corrector: CorrectionPatcher = {
        async correct({ script, correction: turns }) {
          calls.push({ script, correction: turns.map((t) => t.text) });
          return correction(raiseG1(turns[0]!.turn_id));
        },
      };
      const s = await setup({ decider: d8Queue('corrected', 'confirmed'), corrector });
      await toTeachback(s);
      const fix = await s.turn('user', CORRECTION_TEXT);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(calls).toEqual([{ script: 'SCRIPT', correction: [CORRECTION_TEXT] }]);
      expect(s.commands().at(-1)).toEqual({
        type: 'teachback',
        workmap_id: s.map().id,
        script: 'Verstanden: Ausrüstung ist erst ab 10.000 Euro Capex.',
      });
      const g1 = s.map().json.guardrails.find((g) => g.key === 'G1')!;
      expect(g1.rule).toMatchObject({ and: [{ '>': [{ var: 'net_amount' }, 10000] }, expect.anything(), expect.anything()] });
      expect(g1.evidence.at(-1)).toMatchObject({ turn_id: fix });
      expect(s.map().status).toBe('in_debrief');

      await s.turn('agent', 'Verstanden: …');
      const yes = await s.turn('user', 'Ja, jetzt passt es.');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(s.map()).toMatchObject({ status: 'confirmed', json: { confirmed_turn_id: yes } });
    });

    it('restates from the map when part of the correction did not apply', async () => {
      const corrector: CorrectionPatcher = {
        async correct({ correction: turns }) {
          return correction({ ...raiseG1(turns[0]!.turn_id), update_steps: [{ step_key: 'S9', title: 'x', decision: null }] });
        },
      };
      const s = await setup({ decider: d8Queue('corrected'), corrector });
      await toTeachback(s);
      await s.turn('user', CORRECTION_TEXT);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(s.commands().at(-1)).toMatchObject({
        type: 'teachback',
        script: "I've corrected it. Equipment over €10,000 net is capex on cost center 0400.",
      });
    });

    it('asks again when the correction changes nothing or cannot be applied', async () => {
      const failing: CorrectionPatcher = {
        correct: async () => {
          throw new Error('sonnet timed out');
        },
      };
      for (const corrector of [noopCorrector, failing]) {
        const s = await setup({ decider: d8Queue('corrected'), corrector });
        await toTeachback(s);
        await s.turn('user', CORRECTION_TEXT);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(s.commands().at(-1)).toMatchObject({ type: 'teachback', script: expect.stringMatching(/^Kurze Rückfrage/) });
        expect(s.map().status).toBe('in_debrief');
      }
    });

    it('stops after two correction loops, leaving the map in debrief', async () => {
      let n = 0;
      const corrector: CorrectionPatcher = {
        async correct({ correction: turns }) {
          n++;
          return correction(raiseG1(turns[0]!.turn_id));
        },
      };
      const s = await setup({ decider: d8Queue('corrected', 'corrected', 'corrected'), corrector });
      await toTeachback(s);
      for (let i = 0; i < 3; i++) {
        await s.turn('user', CORRECTION_TEXT);
        await vi.advanceTimersByTimeAsync(2_000);
        await s.turn('agent', 'Verstanden: …');
      }
      expect(n).toBe(2);
      expect(s.commands().filter((c) => c.type === 'teachback')).toHaveLength(3); // script + 2 restatements
      expect(s.map().status).toBe('in_debrief');
      expect(s.driver.active(SABINE.session)).toBe(false);
    });
  });

  it('confirms a plain yes when brain is unreachable, but not a yes-but', async () => {
    const base = stubDecider({ D6: D6_HAS_GAPS });
    const decider: Decider = {
      async decide(sid, decisions) {
        if (decisions[0]!.id === 'D6') return base.decide(sid, decisions);
        throw new Error('brain unreachable');
      },
    };
    const s = await setup({ decider });
    await s.start();
    await s.turn('agent', 'Hallo!');
    for (const a of ['a', 'b', 'c']) await s.answer(a);
    await s.turn('agent', 'So machen Sie das: …');
    await s.turn('user', 'Ja, aber Schritt drei stimmt nicht.');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.map().status).toBe('in_debrief');

    await s.turn('agent', 'Kurze Rückfrage …');
    await s.turn('user', 'Ja, passt.');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.map().status).toBe('confirmed');
  });

  it('gives up after three unanswered confirmations, leaving the map in debrief', async () => {
    const s = await setup();
    await s.start();
    await s.turn('agent', 'Hallo!');
    for (const a of ['a', 'b', 'c']) await s.answer(a);
    await vi.advanceTimersByTimeAsync(150_000 * 3);
    expect(s.commands().filter((c) => c.type === 'teachback')).toHaveLength(3);
    expect(s.map().status).toBe('in_debrief');
    expect(s.driver.active(SABINE.session)).toBe(false);
  });

  it('stops after three follow-ups when the expert says that was everything', async () => {
    const s = await setup({ decider: stubDecider({ D6: D6_HAS_GAPS, D12: DONE, D8: d8('confirmed') }) });
    // Every open item important: without D12 the debrief would ask all four.
    for (const o of s.items()) o.importance = 3;
    await s.start();
    await s.turn('agent', 'Hallo!');
    for (const a of ['a', 'b', 'das war alles']) await s.answer(a);
    expect(s.commands().map((c) => c.type)).toEqual(['followup', 'followup', 'followup', 'teachback']);
  });

  it("asks why for a judgment call the map has no reason for", async () => {
    const s = await setup();
    const map = s.map();
    map.json = { ...map.json, steps: map.json.steps.map((x) => (x.key === 'S4' ? { ...x, reason: null } : x)) };
    await s.start();
    await s.turn('agent', 'Hallo!');
    await s.answer(SUPPLIER_ANSWER);
    // Equal importance keeps the draft's order: the high builder item first, then the why.
    const second = s.commands()[1]!;
    expect(second).toMatchObject({ type: 'followup', text: expect.stringMatching(/^At "Hold December invoices from Kranbau" you put/) });
    expect(s.items().find((o) => o.id === (second as { open_item_id: string }).open_item_id)).toMatchObject({ importance: 3 });
  });

  it('keeps going when an answer patch fails, leaving that item asked', async () => {
    const failing: AnswerPatcher = {
      patch: async () => {
        throw new Error('sonnet timed out');
      },
    };
    const s = await setup({ patcher: failing });
    await s.start();
    await s.turn('agent', 'Hallo!');
    for (const a of ['a', 'b', 'c']) await s.answer(a);
    expect(s.commands().at(-1)!.type).toBe('teachback');
    expect(s.items().filter((o) => o.status === 'asked')).toHaveLength(3);
  });

  it('ignores a repeated start, a map not in debrief, and turns after the session ends', async () => {
    const s = await setup();
    await s.start();
    await s.start();
    await s.turn('agent', 'Hallo!');
    expect(s.commands()).toHaveLength(1);

    s.driver.end(SABINE.session);
    await s.answer('a');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.commands()).toHaveLength(1);

    s.map().status = 'draft';
    await s.start();
    expect(s.driver.active(SABINE.session)).toBe(false);
  });
});

describe('plainYes', () => {
  it.each([
    ['Ja, passt.', true],
    ['Genau so.', true],
    ['Yes, that is right.', true],
    ['Ja, aber der zweite Schritt ist anders.', false],
    ['Nein.', false],
    ['Hm, weiß nicht.', false],
    ['Yes, but not step three.', false],
  ])('%s → %s', (reply, expected) => {
    expect(plainYes(reply)).toBe(expected);
  });
});
