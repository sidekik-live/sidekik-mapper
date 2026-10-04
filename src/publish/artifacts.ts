import { JSONLOGIC_VARIABLES, type Guardrail, type WorkMap } from '../contracts/index.js';

/** `guardrails.jsonlogic.json`: the compiled rules tutor and other agents evaluate. */
export function compiledGuardrails(workmap: WorkMap) {
  return {
    workmap_id: workmap.id,
    workflow_id: workmap.workflow_id,
    version: workmap.version,
    variables: JSONLOGIC_VARIABLES,
    guardrails: workmap.guardrails.map(({ id, key, kind, description, rule, consequence }) => ({
      id,
      key,
      kind,
      description,
      rule,
      consequence,
    })),
  };
}

const ACTIONS: Record<NonNullable<Guardrail['consequence']['action']>, string> = {
  ask_controller: 'ask the controller before continuing',
  hold: 'put the invoice on hold',
  second_approval: 'get a second approval',
};

/** What a triggered guardrail requires, in words. */
export function consequenceText(c: Guardrail['consequence']): string {
  const parts = [
    ...Object.entries(c.require ?? {}).map(([field, value]) => `set ${field} to ${value}`),
    ...(c.block ? ['do not save'] : []),
    ...(c.action ? [ACTIONS[c.action]] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : 'stop and check';
}

const quoted = (quote: string, en: string | undefined) => (en && en !== quote ? `"${quote}" (${en})` : `"${quote}"`);

/**
 * `AGENT_RULES.md` (DESIGN §6): one section per step (when, do, why), the "STOP and ask a human"
 * rules, and the JSON-Logic attached, so another agent can follow the expert's way of working.
 */
export function agentRules(workmap: WorkMap, expertName: string): string {
  const byId = new Map(workmap.guardrails.map((g) => [g.id, g]));
  const lines: string[] = [
    `# ${workmap.title}: agent rules`,
    '',
    `Work Map \`${workmap.id}\`, version ${workmap.version}, captured from ${expertName} and confirmed by them in a spoken teach-back.`,
    'Follow the steps in order. Quotes are the expert\'s own words.',
    '',
    '## Steps',
  ];
  for (const s of workmap.steps) {
    const sig = s.screen_signature;
    const rules = s.guardrail_ids.flatMap((id) => byId.get(id)?.key ?? []);
    lines.push(
      '',
      `### ${s.key}. ${s.title}${s.is_judgment_call ? ' (judgment call)' : ''}`,
      '',
      `- **When:** ${sig.app}, ${sig.record_kind}${sig.field ? `, field \`${sig.field}\`` : ''}`,
      `- **Do:** ${s.decision}`,
      `- **Why:** ${s.reason ? `${quoted(s.reason.quote, s.reason.quote_en)}, ${s.reason.source_label}` : 'not stated'}`,
      ...(rules.length > 0 ? [`- **Guardrails:** ${rules.join(', ')}`] : []),
    );
  }
  lines.push('', '## STOP and ask a human when …', '');
  if (workmap.guardrails.length === 0) lines.push('No guardrails were captured.');
  for (const g of workmap.guardrails) {
    lines.push(`- **${g.key}:** ${g.description} Then: ${consequenceText(g.consequence)}. The expert: ${quoted(g.quote, g.quote_en)}`);
  }
  lines.push(
    '',
    '## Guardrails (JSON-Logic)',
    '',
    `Each rule reads the invoice record (${JSONLOGIC_VARIABLES.join(', ')}) and is true when the guardrail is triggered.`,
    '',
    '```json',
    JSON.stringify(compiledGuardrails(workmap).guardrails, null, 2),
    '```',
    '',
  );
  return lines.join('\n');
}
