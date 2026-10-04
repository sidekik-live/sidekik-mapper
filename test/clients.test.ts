import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpDecider } from '../src/clients/brain.js';
import { httpGateway } from '../src/clients/gateway.js';
import { UpstreamError } from '../src/clients/internal-http.js';

type Seen = { method?: string; url?: string; token?: string | string[]; body: unknown };
let server: Server | undefined;

/** A local HTTP server answering each request with the next [status, body]. */
async function upstream(replies: [number, unknown][]) {
  const seen: Seen[] = [];
  server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, url: req.url, token: req.headers['x-internal-token'], body: raw ? JSON.parse(raw) : undefined });
    const [status, body] = replies.shift() ?? [500, { error: 'no reply' }];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterEach(async () => {
  await new Promise((r) => server?.close(r));
  server = undefined;
});

const result = { id: 'D6', answer: 3, confidence: 0.9, provider: 'jev', escalated: false, latency_ms: 12 };

describe('httpDecider', () => {
  it('posts a DecisionRequest with the internal token and returns the results', async () => {
    const { url, seen } = await upstream([[200, { results: [result] }]]);
    const results = await httpDecider(url, 'secret').decide('s1', [{ id: 'D6', state: { open_item: 'x' } }]);
    expect(results).toEqual([result]);
    expect(seen[0]).toEqual({
      method: 'POST',
      url: '/internal/decide',
      token: 'secret',
      body: { session_id: 's1', decisions: [{ id: 'D6', state: { open_item: 'x' } }] },
    });
  });

  it('rejects a response with the wrong number of results', async () => {
    const { url } = await upstream([[200, { results: [] }]]);
    await expect(httpDecider(url, 'secret').decide('s1', [{ id: 'D6', state: {} }])).rejects.toThrow(/0 results for 1/);
  });
});

describe('httpGateway', () => {
  const ok = { session_id: 's1', phase: 'debrief', changed: true, delivered: true };

  it('requests the debrief phase with the dynamic variables', async () => {
    const { url, seen } = await upstream([[200, ok]]);
    const body = { phase: 'debrief' as const, dynamic_variables: { open_items: '1. x', prior_summary: '' } };
    expect(await httpGateway(url, 'secret').setPhase('s1', body)).toEqual(ok);
    expect(seen[0]).toMatchObject({ url: '/internal/sessions/s1/phase', token: 'secret', body });
  });

  it('retries a 503 and succeeds', async () => {
    const { url, seen } = await upstream([[503, { error: 'unavailable' }], [200, ok]]);
    expect(await httpGateway(url, 'secret').setPhase('s1', { phase: 'confirmed' })).toEqual(ok);
    expect(seen).toHaveLength(2);
  });

  it('does not retry a 409 (invalid phase transition)', async () => {
    const { url, seen } = await upstream([[409, { error: 'invalid_transition' }], [200, ok]]);
    const err = await httpGateway(url, 'secret').setPhase('s1', { phase: 'confirmed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ status: 409, retryable: false });
    expect(seen).toHaveLength(1);
  });
});
