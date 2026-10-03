import type { FastifyBaseLogger } from 'fastify';
import { STREAMS, type Bus, type Envelope, type SessionLifecycle, type TranscriptTurn } from '../contracts/index.js';
import type { JobRunner } from './jobs.js';
import { RecentIds } from './recent-ids.js';

/** What the mapper does with each bus event; each handler gets a logger carrying session_id, org_id and event_id. */
export type Handlers = {
  /** Runs inside a build job (one per session), so it may take minutes. */
  build(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void>;
  /** `phase_changed` to `debrief`: start driving the debrief. Must return quickly. */
  debrief(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void>;
  /** Every transcript turn of a non-replay session; the debrief driver picks the ones it waits for. */
  turn(ev: Envelope<TranscriptTurn>, log: FastifyBaseLogger): Promise<void>;
  /** Capture session `ended`: finalize expert memory. */
  ended(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void>;
};

export type ConsumerDeps = {
  bus: Bus;
  jobs: JobRunner;
  handlers: Handlers;
  log: FastifyBaseLogger;
};

/**
 * Subscribes to lifecycle and transcript turns and routes them to the handlers. Returns a function
 * that stops both consumers.
 *
 * Idempotent on `event.id`: an event is remembered only after its handler succeeds, so the bus's
 * retries still re-run a failed handler. Replay sessions are ignored: every lifecycle event of a
 * replay carries `mode: "replay"`, and their turns are dropped once the session is known as a
 * replay. Turns don't carry the mode, but they only matter during a debrief, which a replay's
 * `phase_changed` never starts.
 */
export function startConsumers(deps: ConsumerDeps): () => void {
  const replays = new RecentIds(1_000);
  const seenLifecycle = new RecentIds();
  const seenTurns = new RecentIds();

  const eventLog = (ev: Envelope<unknown>) =>
    deps.log.child({ session_id: ev.session_id, org_id: ev.org_id, event_id: ev.id });

  const onLifecycle = async (ev: Envelope<SessionLifecycle>) => {
    if (seenLifecycle.has(ev.id)) return;
    const log = eventLog(ev);
    const { event, kind, phase, mode } = ev.data;

    if (mode === 'replay') {
      replays.add(ev.session_id);
      log.debug({ event }, 'ignoring replay session event');
    } else if (kind === 'capture' && event === 'task_done') {
      const { job, deduped } = deps.jobs.enqueue('build', ev.session_id, { session_id: ev.session_id, org_id: ev.org_id }, (jobLog) =>
        deps.handlers.build(ev, jobLog.child({ event_id: ev.id })),
      );
      log.info({ job_id: job.id, deduped }, deduped ? 'build job already active' : 'build job queued');
    } else if (kind === 'capture' && event === 'phase_changed' && phase === 'debrief') {
      await deps.handlers.debrief(ev, log);
    } else if (kind === 'capture' && event === 'ended') {
      await deps.handlers.ended(ev, log);
    }
    seenLifecycle.add(ev.id);
  };

  const onTurn = async (ev: Envelope<TranscriptTurn>) => {
    if (seenTurns.has(ev.id) || replays.has(ev.session_id)) return;
    await deps.handlers.turn(ev, eventLog(ev));
    seenTurns.add(ev.id);
  };

  const stops = [
    deps.bus.consume<SessionLifecycle>(STREAMS.lifecycle, onLifecycle),
    deps.bus.consume<TranscriptTurn>(STREAMS.turns, onTurn),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
