// `pnpm dev:replay <file.jsonl> [--speed 2] [--session <sid>] [--redis redis://...]`
// Publishes bus events from a fixture file, spaced by their t_ms ÷ speed.
// Each line is {"stream": "sk:…", "envelope": {…}}; id and ts are refreshed so every run is new.
// Switch to sidekik-platform's `pnpm replay` and fixtures once they exist.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createBus, makeEvent, type Envelope, type StreamKey } from '../contracts/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    speed: { type: 'string', default: '1' },
    session: { type: 'string' },
    redis: { type: 'string', default: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
});

const file = positionals[0];
if (!file) {
  console.error('usage: pnpm dev:replay <file.jsonl> [--speed 2] [--session <sid>] [--redis <url>]');
  process.exit(2);
}
const speed = Number(values.speed);
const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('//'))
  .map((l) => JSON.parse(l) as { stream: StreamKey; envelope: Envelope<unknown> })
  .sort((a, b) => a.envelope.t_ms - b.envelope.t_ms);

const bus = createBus(values.redis!, 'mapper');
const start = Date.now();
for (const { stream, envelope } of lines) {
  const wait = envelope.t_ms / speed - (Date.now() - start);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const { id: _id, ts: _ts, v: _v, ...rest } = envelope;
  const ev = makeEvent({ ...rest, session_id: values.session ?? envelope.session_id });
  const entryId = await bus.publish(stream, ev);
  const data = ev.data as { type?: string; event?: string };
  console.log(`${String(ev.t_ms).padStart(7)} ms  ${stream}  ${data.type ?? data.event ?? ''}  → ${entryId}`);
}
await bus.close();
