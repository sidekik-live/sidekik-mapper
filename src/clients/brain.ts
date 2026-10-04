import { DecisionResponseSchema, type DecisionId, type DecisionResult, type QuestionAnswer } from '../contracts/index.js';
import { internalClient } from './internal-http.js';

export interface Decider {
  /** One result per requested decision, in request order. */
  decide(sessionId: string, decisions: { id: DecisionId; state: unknown }[]): Promise<DecisionResult[]>;
}

/** Brain `POST /internal/decide` (ARCHITECTURE §4.3: 600 ms per call). */
export function httpDecider(baseUrl: string, internalToken: string, timeoutMs = 600): Decider {
  const client = internalClient(baseUrl, internalToken);
  return {
    async decide(sessionId, decisions) {
      const { results } = await client.post(
        '/internal/decide',
        { session_id: sessionId, decisions },
        DecisionResponseSchema,
        timeoutMs,
      );
      if (results.length !== decisions.length) {
        throw new Error(`/internal/decide returned ${results.length} results for ${decisions.length} decisions`);
      }
      return results;
    },
  };
}

/** D6 for an explanation brain can't fault: fully specific, nothing unidentified. */
export const D6_FULLY_SPECIFIC: Record<string, QuestionAnswer> = {
  specificity: { answer: 4, confidence: 0.9, score: 3.9 },
  refers_to_unknown_entity: { answer: false, confidence: 0.95, p_true: 0.05 },
};
/** D6 for an explanation with gaps: an open item worth asking. */
export const D6_HAS_GAPS: Record<string, QuestionAnswer> = {
  specificity: { answer: 3, confidence: 0.85, score: 2.8 },
  refers_to_unknown_entity: { answer: false, confidence: 0.9, p_true: 0.1 },
};

/**
 * Fixed per-question answers until brain ships `/internal/decide` (KICKOFF §0.4); used by dev:mock.
 * `answer` and `confidence` mirror the first question, as brain's do.
 */
export function stubDecider(
  answers: Partial<Record<DecisionId, Record<string, QuestionAnswer>>> = { D6: D6_HAS_GAPS },
): Decider {
  return {
    async decide(_sessionId, decisions) {
      return decisions.map(({ id }) => {
        const perQuestion = answers[id];
        const first = perQuestion ? Object.values(perQuestion)[0] : undefined;
        return {
          id,
          answer: first?.answer ?? 'cannot_tell',
          confidence: first?.confidence ?? 0,
          provider: 'llm' as const,
          escalated: false,
          latency_ms: 0,
          ...(perQuestion && { answers: perQuestion }),
        };
      });
    },
  };
}
