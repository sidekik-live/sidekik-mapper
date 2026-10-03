// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
export const STREAMS = {
  lifecycle: 'sk:session.lifecycle',
  turns: 'sk:transcript.turns',
  speech: 'sk:speech.signals',
  dom: 'sk:dom.events',
  screen: 'sk:screen.events',
  commands: 'sk:agent.commands',
  workmapPublished: 'sk:workmap.published',
  usage: 'sk:usage',
} as const;

export type StreamKey = (typeof STREAMS)[keyof typeof STREAMS];
