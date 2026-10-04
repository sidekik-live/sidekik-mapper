import { createBuildJob, type BuildDeps } from './build/build-job.js';
import type { Handlers } from './services/consumers.js';

/** The mapper's bus handlers. Debrief and expert memory are placeholders until their tickets land. */
export function createHandlers(deps: BuildDeps): Handlers {
  const build = createBuildJob(deps);
  return {
    build: async (ev, log) => {
      await build(ev, log);
    },
    debrief: async (_ev, log) => {
      log.warn('debrief driver not implemented yet');
    },
    turn: async () => {},
    ended: async (_ev, log) => {
      log.info('expert memory not implemented yet');
    },
  };
}
