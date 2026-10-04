import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Bus, Envelope, SessionLifecycle, WorkMap } from '../contracts/index.js';
import { claudeUsageRecords, publishUsage } from '../services/usage.js';
import { VersionConflictError, type Store } from '../store/types.js';
import { assembleWorkMap } from './assemble.js';
import type { Drafter } from './drafter.js';
import { gather } from './gather.js';
import { renderInput } from './prompt.js';

export type BuildDeps = { store: Store; drafter: Drafter; bus: Bus };

export type BuildOutcome =
  | { status: 'drafted'; workmap: WorkMap; warnings: string[] }
  | { status: 'skipped'; reason: string };

/**
 * The build job for one capture session (DESIGN §4 steps 1–2): gather, draft with Claude, and
 * save the draft Work Map with its open items. Validation and the debrief handover come next.
 */
export function createBuildJob(deps: BuildDeps) {
  return async function build(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<BuildOutcome> {
    const session = await deps.store.getSession(ev.session_id);
    if (!session) throw new Error(`session ${ev.session_id} not found`);
    if (session.kind !== 'capture' || session.mode === 'replay') {
      return skip(log, `not a live capture session (${session.kind}, ${session.mode})`);
    }
    if (!session.expert_id) throw new Error('capture session has no expert');

    // A redelivered task_done after a restart must not draft a second Work Map.
    const existing = await deps.store.findWorkMapBySession(session.id);
    if (existing) return skip(log, `work map ${existing.id} (v${existing.version}) already exists`);

    const { input, stats } = await gather(deps.store, { ...session, expert_id: session.expert_id }, renderInput);
    log.info({ ...stats, questions_asked: input.asked.length, carried_over: input.carriedOver.length }, 'session gathered');
    if (input.events.length === 0 || input.turns.length === 0) {
      throw new Error('nothing to draft from: the session has no on-record screen events or expert turns');
    }

    const usageCtx = { org_id: session.org_id, session_id: session.id, t_ms: ev.t_ms };
    const { draft, attempts } = await deps.drafter.draft(renderInput(input), log, async (usage) => {
      const { records, priced } = claudeUsageRecords(usage);
      if (!priced) log.warn({ model: usage.model }, 'no price for model; usage recorded at $0');
      // The cost ledger must never fail a build.
      await publishUsage(deps.bus, usageCtx, records).catch((err) => log.warn({ err }, 'usage publish failed'));
    });

    const id = randomUUID();
    for (let tries = 1; ; tries++) {
      const version = (await deps.store.latestWorkMapVersion(session.workflow_id)) + 1;
      const { workmap, openItems, warnings } = assembleWorkMap({ id, version, input, draft });
      try {
        await deps.store.insertWorkMap(
          {
            id,
            org_id: session.org_id,
            workflow_id: session.workflow_id,
            expert_id: session.expert_id,
            session_id: session.id,
            version,
            status: workmap.status,
            language: workmap.language,
            json: workmap,
          },
          openItems,
        );
      } catch (err) {
        // Another session of this workflow took the version first; take the next one.
        if (err instanceof VersionConflictError && tries < 3) continue;
        throw err;
      }
      log.info(
        {
          workmap_id: id,
          workmap_version: version, // `version` is the service version on every line
          attempts,
          steps: workmap.steps.length,
          judgment_calls: workmap.steps.filter((s) => s.is_judgment_call).length,
          guardrails: workmap.guardrails.length,
          open_items: workmap.open_items.length,
          warnings,
        },
        'draft work map saved',
      );
      return { status: 'drafted', workmap, warnings };
    }
  };
}

function skip(log: FastifyBaseLogger, reason: string): BuildOutcome {
  log.info({ reason }, 'build skipped');
  return { status: 'skipped', reason };
}
