import { createBuildJob, type BuildDeps } from './build/build-job.js';
import { DebriefDriver, type DebriefDeps } from './debrief/driver.js';
import type { Handlers } from './services/consumers.js';

export type MapperDeps = BuildDeps & DebriefDeps;

/** The mapper's bus handlers. Expert memory is a placeholder until its ticket lands. */
export function createHandlers(deps: MapperDeps): Handlers & { driver: DebriefDriver } {
  const build = createBuildJob(deps);
  const driver = new DebriefDriver(deps);
  return {
    driver,
    build: async (ev, log) => {
      await build(ev, log);
    },
    debrief: (ev, log) => driver.start(ev, log),
    turn: (ev, log) => driver.onTurn(ev, log),
    ended: async (ev, log) => {
      driver.end(ev.session_id);
      log.info('expert memory not implemented yet');
    },
  };
}
