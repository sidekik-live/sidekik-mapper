import { z } from 'zod';
import { PhaseSchema } from '../contracts/index.js';
import { internalClient, withRetry } from './internal-http.js';

const PhaseResultSchema = z.object({
  session_id: z.string(),
  phase: PhaseSchema,
  changed: z.boolean(),
  /** False while the session is off the record: the gateway holds the command until it's back on. */
  delivered: z.boolean().optional(),
});
export type PhaseResult = z.infer<typeof PhaseResultSchema>;

export type PhaseRequest = { phase: 'debrief'; dynamic_variables: Record<string, string> } | { phase: 'confirmed' };

export interface GatewayClient {
  /** Gateway `POST /internal/sessions/:id/phase` (sidekik-gateway routes/internal.ts). */
  setPhase(sessionId: string, body: PhaseRequest): Promise<PhaseResult>;
}

/** 1 s budget per call (ARCHITECTURE §4.3), three tries on network errors, 429 and 5xx. */
export function httpGateway(baseUrl: string, internalToken: string): GatewayClient {
  const client = internalClient(baseUrl, internalToken);
  return {
    setPhase: (sessionId, body) =>
      withRetry(() => client.post(`/internal/sessions/${encodeURIComponent(sessionId)}/phase`, body, PhaseResultSchema, 1000), 3),
  };
}

/** Records phase calls instead of sending them; used by dev:mock and tests. */
export function stubGateway(onCall: (sessionId: string, body: PhaseRequest) => void = () => {}): GatewayClient {
  return {
    async setPhase(sessionId, body) {
      onCall(sessionId, body);
      return { session_id: sessionId, phase: body.phase, changed: true, delivered: true };
    },
  };
}
