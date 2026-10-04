import { describe, expect, it } from 'vitest';
import { createBuildJob } from '../src/build/build-job.js';
import { D6_HAS_GAPS, stubDecider } from '../src/clients/brain.js';
import { stubGateway } from '../src/clients/gateway.js';
import { makeEvent, type ScreenEvent, type TranscriptTurn } from '../src/contracts/index.js';
import { fixtureDrafter, SABINE, sabineCapture } from '../src/dev/fixtures.js';
import { publishOnConfirm } from '../src/publish/on-confirm.js';
import { CaptureBuffer, mergeCapture } from '../src/services/capture-buffer.js';
import { JobRunner } from '../src/services/jobs.js';
import { memoryStore } from '../src/store/memory.js';
import type { ScreenEventRow, TranscriptTurnRow } from '../src/store/types.js';
import { fakeBus, lifecycleEvent, silentLog } from './helpers.js';

/** A database row as the bus event perception or the gateway published for it. */
const screenEv = (r: ScreenEventRow) =>
  makeEvent<ScreenEvent>({
    type: 'screen.event',
    org_id: SABINE.org,
    session_id: r.session_id,
    t_ms: r.t_ms,
    producer: 'perception',
    data: {
      event_id: r.event_id,
      type: r.type,
      ...(r.entity_kind && { entity: { kind: r.entity_kind, id: r.entity_id ?? '' } }),
      ...(r.field && { field: r.field }),
      ...(r.before_val !== null && { before: r.before_val }),
      ...(r.after_val !== null && { after: r.after_val }),
      state: r.state ?? {},
      confidence: r.confidence ?? 1,
      source: r.source,
      ...(r.keyframe_id && { keyframe_id: r.keyframe_id }),
    },
  });
const turnEv = (r: TranscriptTurnRow) =>
  makeEvent<TranscriptTurn>({
    type: 'transcript.turn',
    org_id: SABINE.org,
    session_id: r.session_id,
    t_ms: r.t_ms,
    producer: 'gateway',
    data: { turn_id: r.turn_id, role: r.role, text: r.text_redacted, lang: r.lang ?? 'de', source: 'live', redacted: true },
  });

describe('CaptureBuffer', () => {
  it('keeps bus events and turns as database rows', () => {
    const seed = sabineCapture();
    const buffer = new CaptureBuffer();
    const se04 = seed.screen_events!.find((e) => e.event_id === 'se-04')!;
    buffer.addScreen(screenEv(se04));
    buffer.addTurn(turnEv(seed.transcript_turns![2]!));
    const { screenEvents, turns } = buffer.get(SABINE.session);
    expect(screenEvents).toEqual([se04]);
    expect(turns).toEqual([seed.transcript_turns![2]]);
    expect(buffer.get('other')).toEqual({ screenEvents: [], turns: [] });
  });

  it('merges with the database: database rows win, the rest added, in time order', () => {
    const db = { screenEvents: [{ event_id: 'a', t_ms: 20 }], turns: [], offRecordSpans: [], questions: [], answers: [] } as never;
    const merged = mergeCapture(db, {
      screenEvents: [{ event_id: 'a', t_ms: 999 }, { event_id: 'b', t_ms: 10 }] as never,
      turns: [{ turn_id: 't', t_ms: 5 }] as never,
    });
    expect(merged.screenEvents.map((e) => [e.event_id, e.t_ms])).toEqual([
      ['b', 10],
      ['a', 20],
    ]);
    expect(merged.turns).toHaveLength(1);
  });

  it('stays bounded: oldest session and oldest rows go first', () => {
    const buffer = new CaptureBuffer(2, 2);
    const seed = sabineCapture();
    for (const sid of ['s1', 's2', 's3']) buffer.addTurn(turnEv({ ...seed.transcript_turns![0]!, session_id: sid }));
    expect(buffer.get('s1').turns).toEqual([]);
    for (const r of seed.transcript_turns!.slice(0, 3)) buffer.addTurn(turnEv({ ...r, session_id: 's3' }));
    expect(buffer.get('s3').turns.map((t) => t.turn_id)).toEqual(['tt-02', 'tt-03']);
  });

  it('lets the build draft a session whose rows only exist on the bus', async () => {
    const seed = sabineCapture();
    const store = memoryStore({ ...seed, screen_events: [], transcript_turns: [] });
    const capture = new CaptureBuffer();
    for (const r of seed.screen_events!) capture.addScreen(screenEv(r));
    for (const r of seed.transcript_turns!.filter((t) => !t.off_record)) capture.addTurn(turnEv(r));

    const build = createBuildJob({ store, bus: fakeBus(), gateway: stubGateway(), decider: stubDecider({ D6: D6_HAS_GAPS }), drafter: fixtureDrafter(), capture });
    const outcome = await build({ ...lifecycleEvent({ event: 'task_done', phase: 'building' }, SABINE.session), t_ms: 145_000 }, silentLog());
    expect(outcome).toMatchObject({ status: 'handed_over', issues: [] });
    // The off-record span still applies to bus rows: tt-12 (inside it) never reaches the map.
    expect(JSON.stringify(store.data.work_maps[0]!.json)).not.toContain('tt-12');
  });
});

describe('publishOnConfirm', () => {
  it('queues the same publish job the route does, once per map', async () => {
    const jobs = new JobRunner({ log: silentLog() });
    const published: string[] = [];
    let release = () => {};
    const onConfirmed = publishOnConfirm(jobs, async (id) => {
      published.push(id);
      await new Promise<void>((r) => (release = r));
    });
    const map = { id: '00000000-0000-4000-8000-0000000000aa', org_id: SABINE.org, session_id: SABINE.session };
    onConfirmed(map, silentLog());
    onConfirmed(map, silentLog()); // e.g. the UI's publish arriving while it runs
    await new Promise((r) => setTimeout(r, 0));
    release();
    await jobs.idle();
    expect(published).toEqual([map.id]);
  });
});
