import { strToU8, zipSync } from 'fflate';
import type { WorkMap } from '../contracts/index.js';
import { agentRules, compiledGuardrails } from './artifacts.js';

/** Statuses an agent export is offered for: the expert has confirmed the map. */
export const EXPORTABLE = ['confirmed', 'published'] as const;

/** "Supplier invoice coding" v2 → "supplier-invoice-coding-v2-agent-rules.zip" */
export function exportFilename(workmap: Pick<WorkMap, 'title' | 'version'>): string {
  const slug =
    workmap.title
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'work-map';
  return `${slug}-v${workmap.version}-agent-rules.zip`;
}

/**
 * The agent export (DESIGN §2, §6): a zip with `AGENT_RULES.md` and `guardrails.jsonlogic.json`,
 * rendered exactly as publish writes them to Storage.
 */
export function agentExport(workmap: WorkMap, expertName: string): { filename: string; zip: Uint8Array } {
  const zip = zipSync({
    'AGENT_RULES.md': strToU8(agentRules(workmap, expertName)),
    'guardrails.jsonlogic.json': strToU8(JSON.stringify(compiledGuardrails(workmap), null, 2)),
  });
  return { filename: exportFilename(workmap), zip };
}
