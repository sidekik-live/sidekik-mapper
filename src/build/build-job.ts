import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Decider } from '../clients/brain.js';
import type { GatewayClient } from '../clients/gateway.js';
import type { Bus, Envelope, SessionLifecycle, WorkMap } from '../contracts/index.js';
import type { DemoResult } from '../guardrails/demo-cases.js';
import { claudeUsageRecords, publishUsage } from '../services/usage.js';
import { VersionConflictError, type OpenItemRow, type SessionRow, type Store, type WorkMapRow } from '../store/types.js';
import { assembleWorkMap } from './assemble.js';
import type { Drafter } from './drafter.js';
import { gather, type BuildInput } from './gather.js';
import { renderInput } from './prompt.js';
import { scoreOpenItems } from './score.js';
import { validateWorkMap } from './validate.js';

export type BuildDeps = { store: Store; drafter: Drafter; bus: Bus; decider: Decider; gateway: GatewayClient };

export type BuildOutcome =
  | { status: 'handed_over'; workmap: WorkMap; issues: string[]; demo: DemoResult[] }
  | { status: 'skipped'; reason: string };

/** How many open items the debrief agent hears about up front (DESIGN §4 step 4). */
const DEBRIEF_OPEN_ITEMS = 5;

type CaptureSession = SessionRow & { expert_id: string };

/**
 * The build job for one capture session (DESIGN §4): gather, draft with Claude and save the draft;
 * then validate it, score its open items with D6, mark it `in_debrief` and switch the session to
 * the debrief through the gateway. A session whose draft was saved but never handed over (the
 * gateway was down) resumes from the saved draft when its task_done arrives again.
 */
export function createBuildJob(deps: BuildDeps) {
  return async function build(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<BuildOutcome> {
    const found = await deps.store.getSession(ev.session_id);
    if (!found) throw new Error(`session ${ev.session_id} not found`);
    if (found.kind !== 'capture' || found.mode === 'replay') {
      return skip(log, `not a live capture session (${found.kind}, ${found.mode})`);
    }
    if (!found.expert_id) throw new Error('capture session has no expert');
    const session: CaptureSession = { ...found, expert_id: found.expert_id };

    const existing = await deps.store.findWorkMapBySession(session.id);
    if (existing && existing.status !== 'draft') {
      return skip(log, `work map ${existing.id} (v${existing.version}) is already ${existing.status}`);
    }

    const { input, stats } = await gather(deps.store, session, renderInput);
    log.info({ ...stats, questions_asked: input.asked.length, carried_over: input.carriedOver.length }, 'session gathered');

    const draft = existing
      ? { row: existing, openItems: await deps.store.listOpenItems(existing.id) }
      : await draftWorkMap(deps, session, input, ev.t_ms, log);
    if (existing) log.info({ workmap_id: existing.id }, 'resuming saved draft');

    return handOver(deps, session, input, draft.row, draft.openItems, log);
  };
}

/** DESIGN §4 steps 1–2: draft with Claude and save the Work Map as a draft. */
async function draftWorkMap(deps: BuildDeps, session: CaptureSession, input: BuildInput, t_ms: number, log: FastifyBaseLogger) {
  if (input.events.length === 0 || input.turns.length === 0) {
    throw new Error('nothing to draft from: the session has no on-record screen events or expert turns');
  }
  const usageCtx = { org_id: session.org_id, session_id: session.id, t_ms };
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
    const row: WorkMapRow = {
      id,
      org_id: session.org_id,
      workflow_id: session.workflow_id,
      expert_id: session.expert_id,
      session_id: session.id,
      version,
      status: workmap.status,
      language: workmap.language,
      json: workmap,
    };
    try {
      await deps.store.insertWorkMap(row, openItems);
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
        guardrails: workmap.guardrails.length,
        open_items: workmap.open_items.length,
        warnings,
      },
      'draft work map saved',
    );
    return { row, openItems };
  }
}

/** DESIGN §4 steps 3–4: validate, score open items, save as in_debrief, start the debrief. */
async function handOver(
  deps: BuildDeps,
  session: CaptureSession,
  input: BuildInput,
  row: WorkMapRow,
  draftOpenItems: OpenItemRow[],
  log: FastifyBaseLogger,
): Promise<BuildOutcome> {
  const validated = validateWorkMap({ workmap: row.json, openItems: draftOpenItems, input });
  const failing = validated.demo.filter((d) => !d.pass);
  log.info(
    {
      workmap_id: row.id,
      issues: validated.issues,
      demo_cases_passed: validated.demo.length - failing.length,
      demo_cases_failed: failing.map((d) => `${d.name}: ${d.problem}`),
    },
    'work map validated',
  );

  const { kept, dropped } = await scoreOpenItems(deps.decider, session.id, validated.openItems, input.turns, log);
  if (dropped.length > 0) log.info({ dropped: dropped.map((o) => o.text) }, 'trivial open items dropped');
  const keptIds = new Set(kept.map((o) => o.id));

  const workmap: WorkMap = {
    ...validated.workmap,
    status: 'in_debrief',
    open_items: validated.workmap.open_items.filter((o) => keptIds.has(o.id)),
  };
  await deps.store.replaceOpenItems(row.id, kept);
  await deps.store.updateWorkMap(row.id, { status: 'in_debrief', json: workmap });

  const memory = await deps.store.getExpertMemory(session.expert_id, session.workflow_id);
  const dynamic_variables = {
    open_items: kept
      .slice(0, DEBRIEF_OPEN_ITEMS)
      .map((o, i) => `${i + 1}. ${o.text}`)
      .join('\n'),
    prior_summary: memory?.summary ?? '',
  };
  try {
    const result = await deps.gateway.setPhase(session.id, { phase: 'debrief', dynamic_variables });
    log.info({ workmap_id: row.id, ...result }, 'debrief requested');
  } catch (err) {
    // Back to draft, so a redelivered task_done resumes the handover instead of skipping it.
    await deps.store.updateWorkMap(row.id, { status: 'draft', json: { ...workmap, status: 'draft' } });
    throw err;
  }
  return { status: 'handed_over', workmap, issues: validated.issues, demo: validated.demo };
}

function skip(log: FastifyBaseLogger, reason: string): BuildOutcome {
  log.info({ reason }, 'build skipped');
  return { status: 'skipped', reason };
}
