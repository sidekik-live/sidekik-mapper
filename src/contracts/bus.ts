// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
// Implements sidekik-platform docs/DESIGN.md §3: XADD MAXLEN ~ 10000 with the envelope in field "ev"; XREADGROUP + XACK,
// 3 attempts then dead-letter to "sk:dlq"; invalid events are logged and acked, never retried.
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { AgentCommandSchema } from './commands.js';
import type { Envelope, ServiceName } from './envelope.js';
import { SessionLifecycleSchema } from './lifecycle.js';
import { DomEventSchema } from './screen.js';
import { STREAMS, type StreamKey } from './streams.js';
import { SpeechSignalSchema, TranscriptTurnSchema } from './transcript.js';
import { UsageRecordSchema } from './usage.js';

export const DLQ_STREAM = 'sk:dlq';
/** Stream entry field holding the JSON envelope; sidekik-platform's bus.ts uses "ev". */
const FIELD = 'ev';

const EnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  v: z.literal(1),
  org_id: z.string(),
  session_id: z.string(),
  t_ms: z.number(),
  ts: z.string(),
  producer: z.string(),
  data: z.unknown(),
});

/** Payload schema per stream; streams not listed here are passed through unchecked. */
export const STREAM_SCHEMAS: Partial<Record<StreamKey, z.ZodTypeAny>> = {
  [STREAMS.lifecycle]: SessionLifecycleSchema,
  [STREAMS.turns]: TranscriptTurnSchema,
  [STREAMS.speech]: SpeechSignalSchema,
  [STREAMS.dom]: DomEventSchema,
  [STREAMS.commands]: AgentCommandSchema,
  [STREAMS.usage]: UsageRecordSchema,
};

export type ConsumeOptions = { group?: string; batch?: number; blockMs?: number };
export type BusLogger = {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export interface Bus {
  publish<T>(stream: StreamKey, ev: Envelope<T>): Promise<string>;
  /** Starts a consumer loop; returns a function that stops it. */
  consume<T>(stream: StreamKey, handler: (ev: Envelope<T>) => Promise<void>, opts?: ConsumeOptions): () => void;
  close(): Promise<void>;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamReply = [stream: string, entries: [id: string, fields: string[]][]][] | null;

export function createBus(
  redisUrl: string,
  service: ServiceName,
  log: BusLogger = { warn: console.warn, error: console.error },
): Bus & { redis: Redis } {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const consumers = new Set<Redis>();

  function consume<T>(
    stream: StreamKey,
    handler: (ev: Envelope<T>) => Promise<void>,
    opts: ConsumeOptions = {},
  ): () => void {
    const group = opts.group ?? service;
    const consumer = `${service}-${hostname()}-${process.pid}`;
    const schema = STREAM_SCHEMAS[stream];
    // XREADGROUP BLOCK holds its connection, so each consumer gets its own.
    const conn = redis.duplicate({ maxRetriesPerRequest: null });
    conn.on('error', (err) => log.warn({ err: err.message, stream }, 'bus consumer connection error'));
    consumers.add(conn);
    let stopped = false;

    const ensureGroup = async () => {
      try {
        await conn.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
      }
    };

    const handleEntry = async (entryId: string, fields: string[]) => {
      const raw = fields[fields.indexOf(FIELD) + 1];
      let ev: Envelope<T>;
      try {
        const envelope = EnvelopeSchema.parse(JSON.parse(raw ?? ''));
        const data = schema ? schema.parse(envelope.data) : envelope.data;
        ev = { ...envelope, data } as Envelope<T>;
      } catch (err) {
        log.warn({ stream, entry_id: entryId, err: errMessage(err) }, 'invalid bus event acked without handling');
        await conn.xack(stream, group, entryId);
        return;
      }

      for (let attempt = 1; ; attempt++) {
        try {
          await handler(ev);
          break;
        } catch (err) {
          const ctx = { stream, event_id: ev.id, session_id: ev.session_id, org_id: ev.org_id, attempt };
          if (attempt >= MAX_ATTEMPTS) {
            log.error({ ...ctx, err: errMessage(err) }, 'bus handler failed; sent to dead-letter queue');
            await conn.xadd(DLQ_STREAM, 'MAXLEN', '~', 10000, '*', 'stream', stream, 'group', group,
              'error', errMessage(err), FIELD, raw ?? '');
            break;
          }
          log.warn({ ...ctx, err: errMessage(err) }, 'bus handler failed; retrying');
          await sleep(50 * attempt);
        }
      }
      await conn.xack(stream, group, entryId);
    };

    void (async () => {
      // Start with this consumer's unacked entries from a previous run ("0"), then new ones (">").
      let cursor: '0' | '>' = '0';
      while (!stopped) {
        try {
          if (cursor === '0') await ensureGroup();
          const reply = (await conn.xreadgroup(
            'GROUP', group, consumer,
            'COUNT', opts.batch ?? 10,
            'BLOCK', opts.blockMs ?? 1000,
            'STREAMS', stream, cursor,
          )) as StreamReply;
          const entries = reply?.[0]?.[1] ?? [];
          if (cursor === '0' && entries.length === 0) cursor = '>';
          for (const [entryId, fields] of entries) {
            if (stopped) break;
            await handleEntry(entryId, fields);
          }
        } catch (err) {
          if (stopped) break;
          if (errMessage(err).includes('NOGROUP')) cursor = '0';
          log.warn({ stream, err: errMessage(err) }, 'bus read failed; retrying');
          await sleep(500);
        }
      }
    })();

    return () => {
      stopped = true;
      consumers.delete(conn);
      conn.disconnect();
    };
  }

  return {
    redis,
    async publish(stream, ev) {
      const id = await redis.xadd(stream, 'MAXLEN', '~', 10000, '*', FIELD, JSON.stringify(ev));
      if (!id) throw new Error(`XADD to ${stream} returned no id`);
      return id;
    },
    consume,
    async close() {
      for (const conn of consumers) conn.disconnect();
      consumers.clear();
      await redis.quit();
    },
  };
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
