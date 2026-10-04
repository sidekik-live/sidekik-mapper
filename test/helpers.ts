import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import {
  makeEvent,
  type Bus,
  type Envelope,
  type SessionLifecycle,
  type StreamKey,
  type TranscriptTurn,
} from '../src/contracts/index.js';
import { loadEnv, type Env } from '../src/env.js';
import type { Handlers } from '../src/services/consumers.js';
import { memoryStore } from '../src/store/memory.js';

export const SECRETS = { internal: 'i'.repeat(64) };

export const RAW_ENV: Record<string, string> = {
  PORT: '8083',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SK_INTERNAL_TOKEN: SECRETS.internal,
  ANTHROPIC_API_KEY: 'sk-ant-test',
  BUILDER_MODEL: 'claude-sonnet-5-5',
  PATCH_MODEL: 'claude-sonnet-5-5',
  BRAIN_URL: 'http://localhost:8082',
  GATEWAY_INTERNAL_URL: 'http://localhost:8080',
  PERCEPTION_URL: 'http://localhost:8081',
};

export const testEnv = (overrides: Record<string, string> = {}): Env => loadEnv({ ...RAW_ENV, ...overrides });

export const silentLog = (): FastifyBaseLogger => pino({ level: 'silent' });

export const IDS = {
  org: '00000000-0000-4000-8000-00000000a001',
  workflow: '00000000-0000-4000-8000-00000000b001',
  session: '00000000-0000-4000-8000-00000000d001',
  replay: '00000000-0000-4000-8000-00000000d003',
};

export function lifecycleEvent(
  data: Partial<SessionLifecycle> & Pick<SessionLifecycle, 'event'>,
  sessionId = IDS.session,
): Envelope<SessionLifecycle> {
  return makeEvent({
    type: 'session.lifecycle',
    org_id: IDS.org,
    session_id: sessionId,
    t_ms: 0,
    producer: 'gateway',
    data: { kind: 'capture', phase: 'capture', workflow_id: IDS.workflow, mode: 'browser', language: 'de', ...data },
  });
}

export function turnEvent(text: string, sessionId = IDS.session, role: TranscriptTurn['role'] = 'user'): Envelope<TranscriptTurn> {
  return makeEvent({
    type: 'transcript.turn',
    org_id: IDS.org,
    session_id: sessionId,
    t_ms: 0,
    producer: 'gateway',
    data: { turn_id: `turn-${text}`, role, text, lang: 'de', source: 'live', redacted: true },
  });
}

type Handler = (ev: Envelope<unknown>) => Promise<void>;

/** In-memory bus: `deliver` hands an event to the stream's consumer the way the real bus would. */
export function fakeBus() {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  const handlers = new Map<StreamKey, Handler>();
  const bus: Bus & {
    published: typeof published;
    deliver(stream: StreamKey, ev: Envelope<unknown>): Promise<void>;
    consuming(stream: StreamKey): boolean;
  } = {
    published,
    async publish(stream, ev) {
      published.push({ stream, ev });
      return `${published.length}-0`;
    },
    consume(stream, handler) {
      handlers.set(stream, handler as Handler);
      return () => handlers.delete(stream);
    },
    async deliver(stream, ev) {
      const handler = handlers.get(stream);
      if (!handler) throw new Error(`no consumer for ${stream}`);
      await handler(ev);
    },
    consuming: (stream) => handlers.has(stream),
    async close() {},
  };
  return bus;
}

/** Handlers that record every call; `build` waits for `release()` when `hold` is set. */
export function recordingHandlers() {
  const calls: { handler: keyof Handlers; event_id: string; session_id: string }[] = [];
  let release: () => void = () => {};
  const state = { hold: false, failNext: undefined as Error | undefined };
  const record = (handler: keyof Handlers) => async (ev: Envelope<unknown>) => {
    calls.push({ handler, event_id: ev.id, session_id: ev.session_id });
    if (state.failNext) {
      const err = state.failNext;
      state.failNext = undefined;
      throw err;
    }
  };
  const handlers: Handlers = {
    build: async (ev, log) => {
      await record('build')(ev);
      if (state.hold) await new Promise<void>((r) => (release = r));
      log.info('built');
    },
    debrief: record('debrief'),
    turn: record('turn'),
    ended: record('ended'),
  };
  return { handlers, calls, state, release: () => release() };
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    env: testEnv(),
    bus: fakeBus(),
    handlers: recordingHandlers().handlers,
    store: memoryStore(),
    publish: async () => {},
    comparator: { differences: async () => [] },
    healthChecks: {},
    logger: false,
    ...overrides,
  });
}
