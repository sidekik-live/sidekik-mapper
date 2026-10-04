import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { gather, type BuildInput } from '../build/gather.js';
import { renderInput } from '../build/prompt.js';
import { validateWorkMap } from '../build/validate.js';
import type { Decider } from '../clients/brain.js';
import type { GatewayClient } from '../clients/gateway.js';
import {
  makeEvent,
  STREAMS,
  type AgentCommand,
  type Bus,
  type DecisionResult,
  type Envelope,
  type SessionLifecycle,
  type TranscriptTurn,
  type WorkMap,
} from '../contracts/index.js';
import { syncWorkMapRows } from '../publish/rows.js';
import { KeyedQueue } from '../services/keyed-queue.js';
import { claudeUsageRecords, publishUsage, type ClaudeUsage } from '../services/usage.js';
import type { OpenItemRow, Store, TranscriptTurnRow } from '../store/types.js';
import {
  applyMapPatch,
  templateRestatement,
  type AnswerPatcher,
  type CorrectionPatcher,
  type DebriefTurn,
  type MapPatch,
  type Touched,
} from './patch.js';
import { reconfirmScript, type TeachbackWriter } from './teachback.js';

export type DebriefTiming = {
  /** How long to wait for the debrief agent's greeting before starting anyway (it restarts in ~30–60 s). */
  greetingMs: number;
  /** How long to wait for any answer to a follow-up before asking it again (then skipping it). */
  answerMs: number;
  /** The expert's silence that ends an answer or a reply (DESIGN §5: ≥2 s). */
  silenceMs: number;
  /** How long to wait for a reply to the teach-back (the script alone is 60–90 s). */
  replyMs: number;
};

export const DEFAULT_TIMING: DebriefTiming = { greetingMs: 90_000, answerMs: 60_000, silenceMs: 2_000, replyMs: 150_000 };

/** DESIGN §5: at least 3 follow-ups, at most 6. */
export const MIN_FOLLOWUPS = 3;
export const MAX_FOLLOWUPS = 6;
/** A follow-up is asked at most twice; the teach-back confirmation at most three times. */
const MAX_FOLLOWUP_ASKS = 2;
const MAX_CONFIRM_ASKS = 3;
/** DESIGN §5: a corrected teach-back is patched and restated at most twice. */
export const MAX_CORRECTIONS = 2;
/** brain's act bands (sidekik-brain DESIGN §5): Choice ≥0.80, Noul ≥0.85. */
const CHOICE_CONFIDENT = 0.8;
const NOUL_TRUE = 0.85;

export type DebriefDeps = {
  store: Store;
  bus: Bus;
  decider: Decider;
  gateway: GatewayClient;
  patcher: AnswerPatcher;
  corrector: CorrectionPatcher;
  teachback: TeachbackWriter;
  timing?: Partial<DebriefTiming>;
};

type Phase = 'waiting_greeting' | 'followups' | 'confirming';

type State = {
  session: { id: string; org_id: string; workflow_id: string; expert_id: string; language: string; expert_name: string };
  workmap: WorkMap;
  /** The capture the map was built from: screen events and turns for patches and validation. */
  input: BuildInput;
  items: OpenItemRow[];
  phase: Phase;
  asked: number;
  current?: { item: OpenItemRow; turns: DebriefTurn[]; asks: number };
  /** The reply to the teach-back; collected only once the agent has spoken it (`spoken`). */
  reply?: { turns: DebriefTurn[]; spoken: boolean };
  /** What the expert is confirming: the teach-back, then each restatement of a correction. */
  script?: string;
  confirmAsks: number;
  corrections: number;
  /** Every expert turn of the debrief, so validation accepts quotes from it. */
  debriefTurns: DebriefTurn[];
  expertDone: boolean;
  /** Latest session time seen, for the envelopes this driver publishes. */
  lastT: number;
  timer?: NodeJS.Timeout;
  silence?: NodeJS.Timeout;
  timerGen: number;
  silenceGen: number;
  /** Answer patches run here, off the conversation's path; the teach-back waits for them. */
  patches: Promise<void>;
  log: FastifyBaseLogger;
};

/**
 * DESIGN §5 as a state machine per capture session:
 * waiting_greeting → followups → (teachback) confirming ⇄ (correction, restated) → confirmed.
 * Every event of a session (turns, timers) runs through one queue, so the state never interleaves.
 * State lives in memory: a restart mid-debrief loses it, and the Work Map stays `in_debrief`.
 */
export class DebriefDriver {
  private readonly timing: DebriefTiming;
  private readonly states = new Map<string, State>();
  private readonly queue = new KeyedQueue();

  constructor(private readonly deps: DebriefDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  /** `phase_changed` to debrief: load the in-debrief Work Map and wait for the agent's greeting. */
  start(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void> {
    return this.queue.run(ev.session_id, async () => {
      if (this.states.has(ev.session_id)) return;
      const session = await this.deps.store.getSession(ev.session_id);
      if (!session?.expert_id) {
        // Retrying can't create the session row, so skip instead of failing into the dead-letter stream.
        log.warn('debrief started for a session that is unknown or has no expert; ignoring');
        return;
      }
      const row = await this.deps.store.findWorkMapBySession(session.id);
      if (row?.status !== 'in_debrief') {
        log.warn({ workmap_id: row?.id, status: row?.status }, 'debrief started without a Work Map in debrief; ignoring');
        return;
      }
      const capture = { ...session, expert_id: session.expert_id };
      const [{ input }, items] = await Promise.all([
        gather(this.deps.store, capture, renderInput),
        this.deps.store.listOpenItems(row.id),
      ]);
      const st: State = {
        session: {
          id: session.id,
          org_id: session.org_id,
          workflow_id: session.workflow_id,
          expert_id: session.expert_id,
          language: session.language,
          expert_name: input.session.expert_name,
        },
        workmap: row.json,
        input,
        items,
        phase: 'waiting_greeting',
        asked: 0,
        confirmAsks: 0,
        corrections: 0,
        debriefTurns: [],
        expertDone: false,
        lastT: ev.t_ms,
        timerGen: 0,
        silenceGen: 0,
        patches: Promise.resolve(),
        log: log.child({ workmap_id: row.id }),
      };
      await this.addReasonItems(st);
      this.states.set(session.id, st);
      st.log.info({ open_items: st.items.filter((o) => o.status === 'open').length }, 'debrief waiting for the agent');
      this.schedule(st, this.timing.greetingMs, async () => {
        st.log.warn('no greeting from the debrief agent; starting the follow-ups anyway');
        st.phase = 'followups';
        await this.askNext(st);
      });
    });
  }

  /** A transcript turn of any session; ignored unless the session is in a debrief. */
  onTurn(ev: Envelope<TranscriptTurn>, log: FastifyBaseLogger): Promise<void> {
    if (!this.states.has(ev.session_id)) return Promise.resolve();
    return this.queue
      .run(ev.session_id, async () => {
        const st = this.states.get(ev.session_id);
        if (!st) return;
        st.lastT = Math.max(st.lastT, ev.t_ms);
        const turn: DebriefTurn = { turn_id: ev.data.turn_id, text: ev.data.text, t_ms: ev.t_ms };

        if (ev.data.role === 'agent') {
          if (st.phase === 'waiting_greeting') {
            st.log.info('debrief agent greeted the expert');
            st.phase = 'followups';
            this.clearTimer(st);
            await this.askNext(st);
          } else if (st.phase === 'confirming' && st.reply) {
            // Interjections while the agent reads the 60–90 s script are not the reply.
            st.reply.spoken = true;
          }
          return;
        }

        st.debriefTurns.push(turn);
        if (st.phase === 'followups' && st.current) {
          st.current.turns.push(turn);
          this.clearTimer(st);
          this.scheduleSilence(st, () => this.finishAnswer(st));
        } else if (st.phase === 'confirming' && st.reply?.spoken) {
          st.reply.turns.push(turn);
          this.clearTimer(st);
          this.scheduleSilence(st, () => this.finishReply(st));
        }
      })
      .catch((err) => log.error({ err }, 'debrief turn handling failed'));
  }

  /** The session ended: drop its state and timers. */
  end(sessionId: string): void {
    const st = this.states.get(sessionId);
    if (!st) return;
    this.clearTimer(st);
    this.clearSilence(st);
    this.states.delete(sessionId);
  }

  /** Whether a session is mid-debrief (tests and logs). */
  active(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  // ---- follow-ups ----------------------------------------------------------------------------

  /** Coverage holds once ≥3 follow-ups were asked and no high-importance item is left (or the expert is done). */
  private covered(st: State): boolean {
    if (st.asked < MIN_FOLLOWUPS) return false;
    return st.expertDone || !st.items.some((o) => o.status === 'open' && o.importance >= 3);
  }

  private async askNext(st: State): Promise<void> {
    const next = st.items.filter((o) => o.status === 'open').sort((a, b) => b.importance - a.importance)[0];
    if (this.covered(st) || !next || st.asked >= MAX_FOLLOWUPS) {
      const left = st.items.filter((o) => o.status === 'open').length;
      st.log.info({ asked: st.asked, open_items_left: left, expert_done: st.expertDone }, 'follow-ups done');
      return this.startTeachback(st);
    }
    st.asked++;
    next.status = 'asked';
    st.current = { item: next, turns: [], asks: 1 };
    await this.command(st, { type: 'followup', open_item_id: next.id, text: next.text });
    await this.deps.store.updateOpenItemStatus(next.id, 'asked');
    st.log.info({ open_item_id: next.id, followup: st.asked, importance: next.importance }, 'follow-up asked');
    this.schedule(st, this.timing.answerMs, () => this.onAnswerTimeout(st));
  }

  private async onAnswerTimeout(st: State): Promise<void> {
    const cur = st.current;
    if (!cur) return;
    if (cur.asks < MAX_FOLLOWUP_ASKS) {
      cur.asks++;
      await this.command(st, { type: 'followup', open_item_id: cur.item.id, text: cur.item.text });
      st.log.info({ open_item_id: cur.item.id }, 'no answer; follow-up asked again');
      this.schedule(st, this.timing.answerMs, () => this.onAnswerTimeout(st));
      return;
    }
    st.log.warn({ open_item_id: cur.item.id }, 'follow-up unanswered; moving on');
    st.current = undefined;
    await this.askNext(st);
  }

  private async finishAnswer(st: State): Promise<void> {
    const cur = st.current;
    if (!cur || cur.turns.length === 0) return;
    st.current = undefined;
    this.clearTimer(st);
    const text = cur.turns.map((t) => t.text).join(' ');
    st.log.info({ open_item_id: cur.item.id, turns: cur.turns.length }, 'answer received');

    st.patches = st.patches
      .then(() => this.integrate(st, cur.item, cur.turns))
      .catch((err) => st.log.error({ err, open_item_id: cur.item.id }, 'answer patch failed; the answer is not in the map'));

    if (await this.expertSignalsDone(st, text)) {
      st.expertDone = true;
      st.log.info('expert signals they are done');
    }
    await this.askNext(st);
  }

  /** D12: is the expert saying that's everything? Unsure or unreachable reads as no. */
  private async expertSignalsDone(st: State, answer: string): Promise<boolean> {
    try {
      const [r] = await this.deps.decider.decide(st.session.id, [{ id: 'D12', state: { answer } }]);
      const q = r?.answers?.expert_signals_done;
      if (q?.p_true !== undefined) return q.p_true >= NOUL_TRUE;
      return r?.answer === true && r.confidence >= NOUL_TRUE;
    } catch (err) {
      st.log.warn({ err }, 'D12 failed; assuming the expert is not done');
      return false;
    }
  }

  /** Folds an answer into the map (DESIGN §5): reasons, evidence or new guardrails, then validation. */
  private async integrate(st: State, item: OpenItemRow, answer: DebriefTurn[]): Promise<void> {
    const patch = await this.deps.patcher.patch(
      { workmap: st.workmap, item, answer, events: st.input.events },
      st.log,
      (usage) => this.usage(st, usage),
    );
    if (patch.resolves_item) item.status = 'resolved';
    const result = await this.applyAndSave(st, patch, answer);
    st.log.info({ open_item_id: item.id, resolved: patch.resolves_item, ...result }, 'answer integrated');
  }

  /** Applies a patch, validates the map again (debrief turns count as evidence) and saves it. */
  private async applyAndSave(
    st: State,
    patch: MapPatch,
    turns: DebriefTurn[],
  ): Promise<{ changes: string[]; warnings: string[]; issues: string[]; touched: Touched }> {
    const applied = applyMapPatch({ workmap: st.workmap, patch, turns, events: st.input.events, expert: st.session.expert_name });
    const validated = validateWorkMap({
      workmap: applied.workmap,
      openItems: st.items,
      input: { ...st.input, turns: [...st.input.turns, ...st.debriefTurns.map((t) => asTurnRow(st, t))] },
    });
    const known = new Set(st.items.map((o) => o.id));
    st.items.push(...validated.openItems.filter((o) => !known.has(o.id)));
    st.workmap = withOpenItems(validated.workmap, st.items);

    await this.deps.store.replaceOpenItems(st.workmap.id, st.items);
    await this.deps.store.updateWorkMap(st.workmap.id, { status: 'in_debrief', json: st.workmap });
    return { changes: applied.changes, warnings: applied.warnings, issues: validated.issues, touched: applied.touched };
  }

  /** Judgment calls the map has no reason for become open items, so coverage asks for them. */
  private async addReasonItems(st: State): Promise<void> {
    const missing = st.workmap.steps.filter((s) => s.is_judgment_call && !s.reason);
    if (missing.length === 0) return;
    for (const s of missing) {
      st.items.push({
        id: randomUUID(),
        org_id: st.session.org_id,
        workflow_id: st.session.workflow_id,
        work_map_id: st.workmap.id,
        session_id: st.session.id,
        text: `At "${s.title}" you ${s.decision.charAt(0).toLowerCase()}${s.decision.slice(1)}. Why?`,
        anchor_t_ms: s.screen_moment.t_ms,
        origin: 'builder',
        status: 'open',
        importance: 3,
      });
    }
    st.workmap = withOpenItems(st.workmap, st.items);
    await this.deps.store.replaceOpenItems(st.workmap.id, st.items);
    await this.deps.store.updateWorkMap(st.workmap.id, { status: 'in_debrief', json: st.workmap });
  }

  // ---- teach-back and confirmation -----------------------------------------------------------

  private async startTeachback(st: State): Promise<void> {
    st.phase = 'confirming';
    st.current = undefined;
    this.clearTimer(st);
    this.clearSilence(st);
    // Confirming the teach-back confirms the artifact, so every answer must be in it first.
    await st.patches;
    st.script = await this.deps.teachback.write(st.workmap, st.session.language, st.log, (u) => this.usage(st, u));
    st.confirmAsks = 1;
    st.reply = { turns: [], spoken: false };
    await this.command(st, { type: 'teachback', workmap_id: st.workmap.id, script: st.script });
    st.log.info({ words: st.script.split(/\s+/).length }, 'teach-back sent');
    this.schedule(st, this.timing.replyMs, () => this.reconfirm(st, 'no reply to the teach-back'));
  }

  private async finishReply(st: State): Promise<void> {
    const turns = st.reply?.turns ?? [];
    if (turns.length === 0) return;
    st.reply = undefined;
    this.clearTimer(st);
    const reply = turns.map((t) => t.text).join(' ');
    const { answer, confidence, source } = await this.teachbackReply(st, reply);
    st.log.info({ d8: answer, confidence, source }, 'teach-back reply classified');

    if ((answer === 'confirmed' || answer === 'confirmed_minor') && confidence >= CHOICE_CONFIDENT) {
      return this.confirm(st, turns[turns.length - 1]!);
    }
    if (answer === 'corrected' && confidence >= CHOICE_CONFIDENT) return this.correct(st, turns);
    return this.reconfirm(st, 'the reply did not settle the teach-back');
  }

  /** D8 on the reply. If brain is unreachable, a plain yes ("Ja, passt.") still confirms. */
  private async teachbackReply(st: State, reply: string): Promise<{ answer: string; confidence: number; source: string }> {
    try {
      const [r] = await this.deps.decider.decide(st.session.id, [{ id: 'D8', state: { teachback: st.script, reply } }]);
      const q = r?.answers?.teachback_reply ?? (r as DecisionResult | undefined);
      if (q) return { answer: String(q.answer), confidence: q.confidence, source: 'brain' };
    } catch (err) {
      st.log.warn({ err }, 'D8 failed; falling back to a plain yes/no check');
    }
    return plainYes(reply)
      ? { answer: 'confirmed', confidence: CHOICE_CONFIDENT, source: 'fallback' }
      : { answer: 'unclear', confidence: 0, source: 'fallback' };
  }

  /**
   * DESIGN §5: a correction is patched into the map and only the corrected part is restated, then
   * D8 runs on the next reply. The model's restatement is used only when the whole patch applied
   * cleanly; otherwise it is rebuilt from what actually changed, so confirming it confirms the map.
   */
  private async correct(st: State, turns: DebriefTurn[]): Promise<void> {
    if (st.corrections >= MAX_CORRECTIONS) {
      st.log.warn({ corrections: st.corrections }, 'corrected again after the last correction loop; the Work Map stays in debrief');
      this.end(st.session.id);
      return;
    }
    st.corrections++;
    await st.patches;
    let result: Awaited<ReturnType<DebriefDriver['applyAndSave']>>;
    let restatement: string;
    try {
      const correction = await this.deps.corrector.correct(
        { workmap: st.workmap, script: st.script ?? '', correction: turns, events: st.input.events, language: st.session.language },
        st.log,
        (usage) => this.usage(st, usage),
      );
      restatement = correction.restatement.trim();
      result = await this.applyAndSave(st, correction, turns);
    } catch (err) {
      st.log.error({ err }, 'correction could not be applied');
      return this.reconfirm(st, 'the correction could not be applied');
    }
    if (result.changes.length === 0) return this.reconfirm(st, 'the correction changed nothing in the map');

    const clean = result.warnings.length === 0 && result.issues.length === 0 && restatement !== '';
    st.script = clean ? restatement : templateRestatement(st.workmap, result.touched);
    st.reply = { turns: [], spoken: false };
    await this.command(st, { type: 'teachback', workmap_id: st.workmap.id, script: st.script });
    st.log.info({ correction: st.corrections, restatement: clean ? 'model' : 'template', ...result }, 'correction applied and restated');
    this.schedule(st, this.timing.replyMs, () => this.reconfirm(st, 'no reply to the restatement'));
  }

  private async reconfirm(st: State, why: string): Promise<void> {
    if (st.confirmAsks >= MAX_CONFIRM_ASKS) {
      st.log.warn({ why, asks: st.confirmAsks }, 'debrief ended without a confirmation; the Work Map stays in debrief');
      this.end(st.session.id);
      return;
    }
    st.confirmAsks++;
    st.reply = { turns: [], spoken: false };
    await this.command(st, { type: 'teachback', workmap_id: st.workmap.id, script: reconfirmScript(st.session.language) });
    st.log.info({ why, ask: st.confirmAsks }, 'asked to confirm the teach-back again');
    this.schedule(st, this.timing.replyMs, () => this.reconfirm(st, 'no reply to the teach-back'));
  }

  private async confirm(st: State, turn: DebriefTurn): Promise<void> {
    st.workmap = { ...st.workmap, status: 'confirmed', confirmed_turn_id: turn.turn_id };
    await this.deps.store.updateWorkMap(st.workmap.id, { status: 'confirmed', json: st.workmap, confirmed_turn_id: turn.turn_id });
    st.log.info({ confirmed_turn_id: turn.turn_id }, 'work map confirmed');
    // The Work Map page reads the normalized rows; publish writes them again in any case.
    await syncWorkMapRows(this.deps.store, {
      workmap: st.workmap,
      orgId: st.session.org_id,
      events: st.input.events,
      expert: st.session.expert_name,
    }).catch((err) => st.log.error({ err }, 'writing the Work Map rows failed; publish will write them'));
    this.end(st.session.id);
    try {
      const result = await this.deps.gateway.setPhase(st.session.id, { phase: 'confirmed' });
      st.log.info({ ...result }, 'confirmed phase requested');
    } catch (err) {
      // The Work Map is confirmed either way; only the UI's phase lags.
      st.log.error({ err }, 'gateway confirmed phase failed');
    }
  }

  // ---- plumbing ------------------------------------------------------------------------------

  private command(st: State, data: AgentCommand): Promise<string> {
    return this.deps.bus.publish(
      STREAMS.commands,
      makeEvent({ type: 'agent.command', producer: 'mapper', org_id: st.session.org_id, session_id: st.session.id, t_ms: st.lastT, data }),
    );
  }

  private async usage(st: State, usage: ClaudeUsage): Promise<void> {
    const ctx = { org_id: st.session.org_id, session_id: st.session.id, t_ms: st.lastT };
    await publishUsage(this.deps.bus, ctx, claudeUsageRecords(usage).records).catch((err) =>
      st.log.warn({ err }, 'usage publish failed'),
    );
  }

  /** Runs `fn` in the session's queue after `ms`, unless the timer is cleared or replaced first. */
  private schedule(st: State, ms: number, fn: () => Promise<void>): void {
    this.clearTimer(st);
    const gen = st.timerGen;
    st.timer = setTimeout(() => this.fire(st, () => st.timerGen === gen, fn), ms);
  }

  private scheduleSilence(st: State, fn: () => Promise<void>): void {
    this.clearSilence(st);
    const gen = st.silenceGen;
    st.silence = setTimeout(() => this.fire(st, () => st.silenceGen === gen, fn), this.timing.silenceMs);
  }

  private fire(st: State, current: () => boolean, fn: () => Promise<void>): void {
    void this.queue
      .run(st.session.id, async () => {
        if (this.states.get(st.session.id) !== st || !current()) return;
        await fn();
      })
      .catch((err) => st.log.error({ err }, 'debrief timer failed'));
  }

  private clearTimer(st: State): void {
    st.timerGen++;
    clearTimeout(st.timer);
  }

  private clearSilence(st: State): void {
    st.silenceGen++;
    clearTimeout(st.silence);
  }
}

/** The map's open items mirror the rows (statuses included). */
function withOpenItems(workmap: WorkMap, items: OpenItemRow[]): WorkMap {
  return {
    ...workmap,
    open_items: items.map((o) => ({
      id: o.id,
      text: o.text,
      ...(o.anchor_t_ms !== null && { anchor_t_ms: o.anchor_t_ms }),
      origin: o.origin,
      status: o.status,
    })),
  };
}

function asTurnRow(st: State, t: DebriefTurn): TranscriptTurnRow {
  return {
    session_id: st.session.id,
    turn_id: t.turn_id,
    role: 'user',
    text_redacted: t.text,
    lang: st.session.language,
    t_ms: t.t_ms,
    off_record: false,
  };
}

const YES = /^\s*(ja|jo|jep|genau|stimmt|passt|richtig|korrekt|yes|yeah|yep|correct|right|exactly)\b/i;
const BUT = /\b(nein|aber|falsch|nicht|außer|no|not|but|wrong|except)\b/i;

/** A reply that starts with a yes and carries no "but" or "not". */
export const plainYes = (reply: string) => YES.test(reply) && !BUT.test(reply);
