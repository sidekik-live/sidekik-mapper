// `pnpm dev:draft [--out workmap.json] [--model claude-sonnet-5-5]`
// Runs the build job once against Sabine's capture fixture with the real Claude model and prints
// the draft Work Map. Credentials: ANTHROPIC_API_KEY, or any source the Anthropic SDK resolves.
// Costs real tokens (roughly 10–20k in, a few k out).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { createBuildJob } from '../build/build-job.js';
import { claudeDrafter } from '../build/drafter.js';
import { makeEvent, type Bus, type UsageRecord } from '../contracts/index.js';
import { memoryStore } from '../store/memory.js';
import { SABINE, sabineCapture } from './fixtures.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    model: { type: 'string', default: process.env.BUILDER_MODEL ?? 'claude-sonnet-5-5' },
  },
});

const usage: UsageRecord[] = [];
const bus: Bus = {
  async publish(_stream, ev) {
    usage.push(ev.data as UsageRecord);
    return '0-0';
  },
  consume: () => () => {},
  async close() {},
};
const log = pino({ level: 'info', transport: { target: 'pino-pretty' } });
const build = createBuildJob({
  store: memoryStore(sabineCapture()),
  drafter: claudeDrafter({ apiKey: process.env.ANTHROPIC_API_KEY, model: values.model! }),
  bus,
});

const outcome = await build(
  makeEvent({
    type: 'session.lifecycle',
    org_id: SABINE.org,
    session_id: SABINE.session,
    t_ms: 145_000,
    producer: 'gateway',
    data: {
      event: 'task_done',
      kind: 'capture',
      phase: 'building',
      workflow_id: SABINE.workflow,
      mode: 'browser',
      language: 'de',
    },
  }),
  log,
);

if (outcome.status !== 'drafted') {
  console.error(`build skipped: ${outcome.reason}`);
  process.exit(1);
}
const json = JSON.stringify(outcome.workmap, null, 2);
if (values.out) writeFileSync(values.out, json);
else console.log(json);
const cost = usage.reduce((sum, r) => sum + r.cost_usd, 0);
console.error(`\n${outcome.workmap.steps.length} steps, ${outcome.workmap.guardrails.length} guardrails, ` +
  `${outcome.workmap.open_items.length} open items, ${outcome.warnings.length} warnings, $${cost.toFixed(4)}`);
for (const w of outcome.warnings) console.error(`  warning: ${w}`);
