import type { FastifyBaseLogger } from 'fastify';
import type { PerceptionClient } from '../clients/perception.js';
import { makeEvent, STREAMS, type Bus, type WorkMap, type WorkMapPublished } from '../contracts/index.js';
import { runDemoCases, type DemoResult } from '../guardrails/demo-cases.js';
import { checkRule } from '../guardrails/rules.js';
import type { ArtifactStore } from '../store/artifacts.js';
import type { Store, WorkMapRow } from '../store/types.js';
import { agentRules, compiledGuardrails } from './artifacts.js';
import { kbChunks } from './chunks.js';

export type PublishDeps = { store: Store; bus: Bus; perception: PerceptionClient; artifacts: ArtifactStore };

/** Statuses a Work Map can be published from; publishing a published map again refreshes it. */
export const PUBLISHABLE = ['confirmed', 'published'] as const;

/** DESIGN §6: clip windows around each step's screen moment. */
const CLIP_BEFORE_S = 6;
const CLIP_AFTER_S = 4;

export type PublishOutcome = {
  workmap: WorkMap;
  paths: string[];
  chunks: number;
  clips_job_id: string | null;
  demo: DemoResult[];
};

/** `workmaps/org/{org}/{workmap_id}/v{n}/` in the `workmaps` bucket (ARCHITECTURE §6). */
export const artifactDir = (row: Pick<WorkMapRow, 'org_id' | 'id' | 'version'>) => `org/${row.org_id}/${row.id}/v${row.version}`;

/**
 * Publishes a confirmed Work Map (DESIGN §6): checks its rules, requests a clip per step, replaces
 * its search chunks, writes the three Storage files, marks it published and announces it on
 * `sk:workmap.published`. Storage and the row are written before the event, because voice loads
 * the map from Storage and tutor from the database when they see it.
 */
export function createPublishJob(deps: PublishDeps) {
  return async function publish(workmapId: string, log: FastifyBaseLogger): Promise<PublishOutcome> {
    const row = await deps.store.getWorkMap(workmapId);
    if (!row) throw new Error(`work map ${workmapId} not found`);
    if (!(PUBLISHABLE as readonly string[]).includes(row.status)) {
      throw new Error(`work map ${workmapId} is ${row.status}; only a confirmed map can be published`);
    }
    const workmap: WorkMap = { ...row.json, status: 'published' };

    // 1. Compile and test the guardrails. A rule that doesn't evaluate must never reach tutor.
    const broken = workmap.guardrails.flatMap((g) => checkRule(g.rule).map((p) => `${g.key}: ${p}`));
    if (broken.length > 0) throw new Error(`guardrails do not compile: ${broken.join('; ')}`);
    const demo = runDemoCases(workmap.guardrails);
    const failing = demo.filter((d) => !d.pass);
    if (failing.length > 0) log.warn({ demo_cases_failed: failing.map((d) => `${d.name}: ${d.problem}`) }, 'demo guardrail cases failing');

    // 2. Clips: perception cuts them in the background. Without them the UI falls back to keyframes.
    let clipsJobId: string | null = null;
    if (row.session_id && workmap.steps.length > 0) {
      try {
        const items = workmap.steps.map((s) => ({ step_id: s.id, t_ms: s.screen_moment.t_ms, before_s: CLIP_BEFORE_S, after_s: CLIP_AFTER_S }));
        clipsJobId = (await deps.perception.requestClips(row.session_id, items)).job_id;
      } catch (err) {
        log.warn({ err }, 'clip request failed; publishing without clips');
      }
    }

    // 3. Search chunks for recall_context.
    const capture = row.session_id ? await deps.store.loadCapture(row.session_id) : { answers: [], questions: [] };
    const chunks = kbChunks({ workmap, orgId: row.org_id, answers: capture.answers, questions: capture.questions });
    await deps.store.replaceKbChunks(row.id, chunks);

    // 4. Storage artifacts.
    const expert = await deps.store.getExpert(row.expert_id);
    const dir = artifactDir(row);
    const files: [string, string, string][] = [
      ['workmap.json', JSON.stringify(workmap, null, 2), 'application/json'],
      ['AGENT_RULES.md', agentRules(workmap, expert?.display_name ?? 'the expert'), 'text/markdown; charset=utf-8'],
      ['guardrails.jsonlogic.json', JSON.stringify(compiledGuardrails(workmap), null, 2), 'application/json'],
    ];
    for (const [name, body, contentType] of files) await deps.artifacts.put(`${dir}/${name}`, body, contentType);

    // 5. Published, then announced. (6. expert memory comes with its own ticket.)
    await deps.store.updateWorkMap(row.id, { status: 'published', json: workmap, published_at: new Date().toISOString() });
    await deps.bus.publish(
      STREAMS.workmapPublished,
      makeEvent<WorkMapPublished>({
        type: 'workmap.published',
        producer: 'mapper',
        org_id: row.org_id,
        session_id: row.session_id ?? row.id,
        t_ms: 0,
        data: { workmap_id: row.id, workflow_id: row.workflow_id, version: row.version },
      }),
    );

    const paths = files.map(([name]) => `${dir}/${name}`);
    log.info(
      { workmap_id: row.id, workmap_version: row.version, chunks: chunks.length, clips_job_id: clipsJobId, paths, demo_cases_failed: failing.length },
      'work map published',
    );
    return { workmap, paths, chunks: chunks.length, clips_job_id: clipsJobId, demo };
  };
}
