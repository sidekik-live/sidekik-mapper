// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
import { z } from 'zod';

export const TranscriptTurnSchema = z.object({
  turn_id: z.string(),
  role: z.enum(['user', 'agent']),
  text: z.string(),
  lang: z.string(),
  source: z.enum(['live', 'webhook']),
  redacted: z.literal(true),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const SpeechSignalSchema = z.object({
  kind: z.enum(['user_speech_start', 'user_speech_end', 'agent_speech_start', 'agent_speech_end', 'typing']),
  source: z.enum(['sdk', 'recall', 'dom']),
});
export type SpeechSignal = z.infer<typeof SpeechSignalSchema>;
