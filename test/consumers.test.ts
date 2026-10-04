import { describe, expect, it } from 'vitest';
import { makeEvent, STREAMS } from '../src/contracts/index.js';
import { startConsumers } from '../src/services/consumers.js';
import { JobRunner } from '../src/services/jobs.js';
import { fakeBus, IDS, lifecycleEvent, recordingHandlers, silentLog, turnEvent } from './helpers.js';

function setup() {
  const bus = fakeBus();
  const jobs = new JobRunner({ log: silentLog() });
  const rec = recordingHandlers();
  const stop = startConsumers({ bus, jobs, handlers: rec.handlers, log: silentLog() });
  return { bus, jobs, rec, stop };
}

describe('startConsumers', () => {
  it('consumes lifecycle and transcript turns until stopped', () => {
    const { bus, stop } = setup();
    expect(bus.consuming(STREAMS.lifecycle)).toBe(true);
    expect(bus.consuming(STREAMS.turns)).toBe(true);
    stop();
    expect(bus.consuming(STREAMS.lifecycle)).toBe(false);
    expect(bus.consuming(STREAMS.turns)).toBe(false);
  });

  it('queues a build job on capture task_done without waiting for it', async () => {
    const { bus, jobs, rec } = setup();
    rec.state.hold = true;
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'task_done' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.calls).toEqual([expect.objectContaining({ handler: 'build', session_id: IDS.session })]);
    rec.release();
    await jobs.idle();
  });

  it('builds once when task_done is redelivered or repeated while the build runs', async () => {
    const { bus, jobs, rec } = setup();
    rec.state.hold = true;
    const ev = lifecycleEvent({ event: 'task_done' });
    await bus.deliver(STREAMS.lifecycle, ev);
    await bus.deliver(STREAMS.lifecycle, ev);
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'task_done' }));
    await new Promise((r) => setTimeout(r, 0));
    rec.release();
    await jobs.idle();
    expect(rec.calls.filter((c) => c.handler === 'build')).toHaveLength(1);
  });

  it('ignores task_done for tutor sessions', async () => {
    const { bus, jobs, rec } = setup();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'task_done', kind: 'tutor', phase: 'tutoring' }));
    await jobs.idle();
    expect(rec.calls).toEqual([]);
  });

  it('starts the debrief only on phase_changed to debrief', async () => {
    const { bus, rec } = setup();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'phase_changed', phase: 'building' }));
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'phase_changed', phase: 'debrief' }));
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'phase_changed', phase: 'confirmed' }));
    expect(rec.calls.map((c) => c.handler)).toEqual(['debrief']);
  });

  it('finalizes on a capture session ending, not a tutor one', async () => {
    const { bus, rec } = setup();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', kind: 'tutor', phase: 'done' }));
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', phase: 'confirmed' }));
    expect(rec.calls.map((c) => c.handler)).toEqual(['ended']);
  });

  it('routes each transcript turn once', async () => {
    const { bus, rec } = setup();
    const turn = turnEvent('Ja, passt');
    await bus.deliver(STREAMS.turns, turn);
    await bus.deliver(STREAMS.turns, turn);
    expect(rec.calls).toEqual([{ handler: 'turn', event_id: turn.id, session_id: IDS.session }]);
  });

  it('re-runs a handler that failed, since the bus retries the same event', async () => {
    const { bus, rec } = setup();
    const ev = lifecycleEvent({ event: 'phase_changed', phase: 'debrief' });
    rec.state.failNext = new Error('gateway down');
    await expect(bus.deliver(STREAMS.lifecycle, ev)).rejects.toThrow('gateway down');
    await bus.deliver(STREAMS.lifecycle, ev);
    await bus.deliver(STREAMS.lifecycle, ev);
    expect(rec.calls.map((c) => c.handler)).toEqual(['debrief', 'debrief']);
  });

  it('ignores every event of a replay session, including its turns', async () => {
    const { bus, jobs, rec } = setup();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started', mode: 'replay' }, IDS.replay));
    await bus.deliver(STREAMS.turns, turnEvent('replayed', IDS.replay));
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'task_done', mode: 'replay' }, IDS.replay));
    await bus.deliver(
      STREAMS.lifecycle,
      lifecycleEvent({ event: 'phase_changed', phase: 'debrief', mode: 'replay' }, IDS.replay),
    );
    await jobs.idle();
    expect(rec.calls).toEqual([]);

    // The original session is unaffected.
    await bus.deliver(STREAMS.turns, turnEvent('live'));
    expect(rec.calls.map((c) => c.handler)).toEqual(['turn']);
  });

  it('routes screen events, and ignores those of a replay session', async () => {
    const { bus, rec } = setup();
    const screen = (sessionId: string) =>
      makeEvent({
        type: 'screen.event',
        org_id: IDS.org,
        session_id: sessionId,
        t_ms: 0,
        producer: 'perception' as const,
        data: { event_id: `se-${sessionId}`, type: 'record_opened' as const, state: {}, confidence: 0.9, source: 'dom' as const },
      });
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started', mode: 'replay' }, IDS.replay));
    await bus.deliver(STREAMS.screen, screen(IDS.session));
    await bus.deliver(STREAMS.screen, screen(IDS.replay));
    expect(rec.calls.map((c) => [c.handler, c.session_id])).toEqual([['screen', IDS.session]]);
  });
});
