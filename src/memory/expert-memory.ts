import type { FastifyBaseLogger } from 'fastify';
import type { WorkMap } from '../contracts/index.js';
import type { ExpertMemoryRow, Store } from '../store/types.js';

/** DESIGN §6: the summary is at most 1,500 characters. */
export const SUMMARY_MAX = 1500;

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * What the agent should know before the expert's next session (it becomes `{{prior_summary}}`):
 * the map's steps with the expert's own reasons for judgment calls, its rules, and how much is
 * still open. Built from the map, not generated, so it can't say anything the expert didn't
 * confirm. Items that don't fit in 1,500 characters are dropped from the end, marked with "…".
 */
export function memorySummary(workmap: WorkMap, expertName: string, openItems: number): string {
  const head = `${workmap.title}, as ${expertName} does it (Work Map v${workmap.version}, ${workmap.status.replace('_', ' ')}).`;
  const open = openItems > 0 ? ` Still open: ${openItems} question${openItems === 1 ? '' : 's'} for ${expertName}.` : '';
  const items = [
    ...workmap.steps.map((s, i) => {
      const why = s.is_judgment_call && s.reason ? ` (judgment call; why: "${s.reason.quote}")` : '';
      return `${i === 0 ? ' Steps: ' : ' '}${i + 1}. ${sentence(`${s.title}${why}`)}`;
    }),
    ...workmap.guardrails.map((g, i) => `${i === 0 ? ' Rules: ' : ' '}${g.key}: ${sentence(g.description)}`),
  ];

  const budget = SUMMARY_MAX - open.length;
  let body = head;
  for (const [i, item] of items.entries()) {
    const rest = i < items.length - 1 ? ' …' : '';
    if (body.length + item.length + rest.length > budget) {
      body = `${body} …`;
      break;
    }
    body += item;
  }
  return `${body}${open}`.slice(0, SUMMARY_MAX);
}

/**
 * Refreshes the expert's memory for a workflow (DESIGN §6 step 6, and on `ended`): the open items
 * still unresolved across their capture sessions and, when a Work Map is given, a new summary of
 * it. Without one (a session that ended before its map), the previous summary is kept.
 */
export async function updateExpertMemory(
  store: Store,
  args: { orgId: string; expertId: string; workflowId: string; workmap: WorkMap | null },
  log: FastifyBaseLogger,
): Promise<ExpertMemoryRow> {
  const [open, previous, expert] = await Promise.all([
    store.listCarriedOverOpenItems(args.workflowId, args.expertId),
    store.getExpertMemory(args.expertId, args.workflowId),
    store.getExpert(args.expertId),
  ]);
  const summary = args.workmap
    ? memorySummary(args.workmap, expert?.display_name ?? 'the expert', open.length)
    : (previous?.summary ?? '');
  const row = { expert_id: args.expertId, workflow_id: args.workflowId, summary, open_item_ids: open.map((o) => o.id) };
  await store.upsertExpertMemory({ ...row, org_id: args.orgId });
  log.info(
    { expert_id: args.expertId, workflow_id: args.workflowId, summary_chars: summary.length, open_items: open.length, from_workmap: args.workmap?.id ?? null },
    'expert memory updated',
  );
  return row;
}
