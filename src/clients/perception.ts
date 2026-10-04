import { z } from 'zod';
import { internalClient } from './internal-http.js';

export type ClipRequest = { step_id: string; t_ms: number; before_s: number; after_s: number };

export interface PerceptionClient {
  /**
   * Perception `POST /internal/clips` (sidekik-perception DESIGN §2): cuts the clips in the
   * background, writes `clips` rows (step_id → clip) and answers 202 with its job id.
   */
  requestClips(sessionId: string, items: ClipRequest[]): Promise<{ job_id: string }>;
}

/** The request only queues the job, so a short budget is enough. */
export function httpPerception(baseUrl: string, internalToken: string, timeoutMs = 2000): PerceptionClient {
  const client = internalClient(baseUrl, internalToken);
  return {
    requestClips: (sessionId, items) =>
      client.post('/internal/clips', { session_id: sessionId, items }, z.object({ job_id: z.string() }), timeoutMs),
  };
}

/** Records clip requests instead of sending them; used by dev:mock and tests. */
export function stubPerception(onRequest: (sessionId: string, items: ClipRequest[]) => void = () => {}): PerceptionClient {
  return {
    async requestClips(sessionId, items) {
      onRequest(sessionId, items);
      return { job_id: 'stub-clips' };
    },
  };
}
