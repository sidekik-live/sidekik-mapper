import { describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { JobRunner } from '../src/services/jobs.js';
import { buildTestApp, fakeBus, lifecycleEvent, recordingHandlers, SECRETS, silentLog } from './helpers.js';

describe('app', () => {
  it('reports healthy dependencies with the package version', async () => {
    const app = await buildTestApp({ healthChecks: { redis: async () => {}, supabase: async () => {} } });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.1.0', deps: { redis: true, supabase: true } });
    await app.close();
  });

  it('returns 503 when a dependency is down', async () => {
    const app = await buildTestApp({
      healthChecks: {
        redis: async () => {},
        supabase: async () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, deps: { redis: true, supabase: false } });
    await app.close();
  });

  it('answers unknown routes with a JSON 404 and echoes x-request-id', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'req-12345678' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(res.headers['x-request-id']).toBe('req-12345678');
    await app.close();
  });

  it('guards internal routes with X-Internal-Token', async () => {
    const app = await buildTestApp();
    app.get('/internal/ping', { onRequest: app.requireInternal }, async () => ({ ok: true }));
    const missing = await app.inject({ method: 'GET', url: '/internal/ping' });
    const wrong = await app.inject({ method: 'GET', url: '/internal/ping', headers: { 'x-internal-token': 'nope' } });
    const right = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { 'x-internal-token': SECRETS.internal },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
    await app.close();
  });

  it('consumes the bus once ready; on close stops consuming, lets running jobs finish, then closes the bus', async () => {
    const order: string[] = [];
    const bus = fakeBus();
    bus.close = async () => {
      order.push('bus closed');
    };
    const jobs = new JobRunner({ log: silentLog() });
    const rec = recordingHandlers();
    rec.state.hold = true;
    rec.handlers.build = async () => {
      await new Promise<void>((r) => (rec.release = r));
      order.push(`build finished (consuming: ${bus.consuming(STREAMS.lifecycle)})`);
    };
    const app = await buildTestApp({ bus, jobs, handlers: rec.handlers });
    expect(bus.consuming(STREAMS.lifecycle)).toBe(false);

    await app.ready();
    expect(bus.consuming(STREAMS.lifecycle)).toBe(true);
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'task_done' }));
    await new Promise((r) => setTimeout(r, 0));

    const closing = app.close();
    await new Promise((r) => setTimeout(r, 0));
    rec.release();
    await closing;
    expect(bus.consuming(STREAMS.turns)).toBe(false);
    expect(order).toEqual(['build finished (consuming: false)', 'bus closed']);
  });
});
