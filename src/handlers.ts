import type { Handlers } from './services/consumers.js';

/** Placeholders until the build, debrief and expert-memory tickets land; they only log. */
export const pendingHandlers: Handlers = {
  build: async (ev, log) => {
    log.warn({ workflow_id: ev.data.workflow_id }, 'build job not implemented yet');
  },
  debrief: async (_ev, log) => {
    log.warn('debrief driver not implemented yet');
  },
  turn: async () => {},
  ended: async (_ev, log) => {
    log.info('expert memory not implemented yet');
  },
};
