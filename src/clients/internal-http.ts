import type { z } from 'zod';

/** A non-2xx answer from another Sidekik service. */
export class UpstreamError extends Error {
  constructor(
    readonly path: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  /** Network failures, timeouts, 429 and 5xx are worth retrying; other 4xx are not. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/** Client for another Sidekik service: JSON bodies, `X-Internal-Token`, a hard timeout per call. */
export function internalClient(baseUrl: string, internalToken: string) {
  return {
    async post<S extends z.ZodTypeAny>(path: string, body: unknown, schema: S, timeoutMs: number): Promise<z.infer<S>> {
      let res: Response;
      try {
        res = await fetch(new URL(path, baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
        throw new UpstreamError(path, null, timedOut ? `${path} timed out after ${timeoutMs} ms` : `${path} unreachable`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new UpstreamError(path, res.status, `${path} returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      const parsed = schema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new UpstreamError(path, res.status, `${path} returned an unexpected body`);
      return parsed.data;
    },
  };
}

/** Retries retryable upstream failures with a short linear backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts: number, backoffMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = !(err instanceof UpstreamError) || err.retryable;
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
}
