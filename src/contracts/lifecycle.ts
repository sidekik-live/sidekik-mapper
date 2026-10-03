// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
import { z } from 'zod';

export const SessionKindSchema = z.enum(['capture', 'tutor']);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const PhaseSchema = z.enum(['capture', 'building', 'debrief', 'confirmed', 'tutoring', 'done']);
export type Phase = z.infer<typeof PhaseSchema>;

export const SessionModeSchema = z.enum(['browser', 'meeting', 'replay']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SessionLifecycleSchema = z.object({
  event: z.enum([
    'started',
    'task_done',
    'phase_changed',
    'offrecord_on',
    'offrecord_off',
    'ended',
    'bot_joined',
    'bot_left',
    'bot_error',
  ]),
  kind: SessionKindSchema,
  phase: PhaseSchema,
  workflow_id: z.string(),
  workmap_id: z.string().optional(),
  mode: SessionModeSchema,
  language: z.string(),
});
export type SessionLifecycle = z.infer<typeof SessionLifecycleSchema>;
