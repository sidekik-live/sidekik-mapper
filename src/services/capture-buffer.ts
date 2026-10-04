import type { Envelope, ScreenEvent, TranscriptTurn } from '../contracts/index.js';
import type { ScreenEventRow, SessionCapture, TranscriptTurnRow } from '../store/types.js';

type Buffered = { events: Map<string, ScreenEventRow>; turns: Map<string, TranscriptTurnRow> };

/**
 * Screen events and transcript turns of recent sessions as they came off the bus (ARCHITECTURE
 * §4.2: mapper consumes both). The build and the debrief read the database first; this fills in
 * what perception or voice haven't written (or never write, e.g. a fixture replayed onto the bus).
 * Bounded: the oldest session is dropped past `maxSessions`, and each session keeps its newest
 * `maxPerSession` events and turns.
 */
export class CaptureBuffer {
  private readonly sessions = new Map<string, Buffered>();

  constructor(
    private readonly maxSessions = 200,
    private readonly maxPerSession = 5_000,
  ) {}

  addScreen(ev: Envelope<ScreenEvent>): void {
    const e = ev.data;
    put(this.session(ev.session_id).events, e.event_id, this.maxPerSession, {
      event_id: e.event_id,
      session_id: ev.session_id,
      t_ms: ev.t_ms,
      type: e.type,
      entity_kind: e.entity?.kind ?? null,
      entity_id: e.entity?.id ?? null,
      field: e.field ?? null,
      before_val: e.before ?? null,
      after_val: e.after ?? null,
      state: e.state,
      confidence: e.confidence,
      source: e.source,
      keyframe_id: e.keyframe_id ?? null,
    });
  }

  /** Turns on the bus are already redacted and off-record filtered by the gateway. */
  addTurn(ev: Envelope<TranscriptTurn>): void {
    const t = ev.data;
    put(this.session(ev.session_id).turns, t.turn_id, this.maxPerSession, {
      session_id: ev.session_id,
      turn_id: t.turn_id,
      role: t.role,
      text_redacted: t.text,
      lang: t.lang,
      t_ms: ev.t_ms,
      off_record: false,
    });
  }

  get(sessionId: string): Pick<SessionCapture, 'screenEvents' | 'turns'> {
    const s = this.sessions.get(sessionId);
    return { screenEvents: s ? [...s.events.values()] : [], turns: s ? [...s.turns.values()] : [] };
  }

  private session(id: string): Buffered {
    let s = this.sessions.get(id);
    if (!s) {
      s = { events: new Map(), turns: new Map() };
      this.sessions.set(id, s);
      if (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
    }
    return s;
  }
}

function put<T>(map: Map<string, T>, id: string, max: number, row: T): void {
  map.set(id, row);
  if (map.size > max) map.delete(map.keys().next().value!);
}

/** The database capture plus the buffered rows it doesn't have yet (same event_id or turn_id: the database wins). */
export function mergeCapture(db: SessionCapture, buffered: Pick<SessionCapture, 'screenEvents' | 'turns'>): SessionCapture {
  const events = new Set(db.screenEvents.map((e) => e.event_id));
  const turns = new Set(db.turns.map((t) => t.turn_id));
  const byTime = <T extends { t_ms: number }>(rows: T[]) => rows.sort((a, b) => a.t_ms - b.t_ms);
  return {
    ...db,
    screenEvents: byTime([...db.screenEvents, ...buffered.screenEvents.filter((e) => !events.has(e.event_id))]),
    turns: byTime([...db.turns, ...buffered.turns.filter((t) => !turns.has(t.turn_id))]),
  };
}
