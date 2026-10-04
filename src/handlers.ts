import { createBuildJob, type BuildDeps } from './build/build-job.js';
import { DebriefDriver, type DebriefDeps } from './debrief/driver.js';
import { updateExpertMemory } from './memory/expert-memory.js';
import type { Handlers } from './services/consumers.js';

export type MapperDeps = BuildDeps & DebriefDeps;

/** The mapper's bus handlers. */
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
    // DESIGN §2: a capture session's end finalizes the expert's memory, from its map if it has one.
    ended: async (ev, log) => {
      driver.end(ev.session_id);
      const session = await deps.store.getSession(ev.session_id);
      if (!session?.expert_id) return;
      const row = await deps.store.findWorkMapBySession(session.id);
      await updateExpertMemory(
        deps.store,
        { orgId: session.org_id, expertId: session.expert_id, workflowId: session.workflow_id, workmap: row?.json ?? null },
        log,
      );
    },
  };
}
