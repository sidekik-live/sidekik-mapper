# sidekik-mapper

The Work Map builder for **Sidekik**, an AI apprentice ([sidekik.live](https://sidekik.live)). It turns a capture session into a **confirmed, evidence-linked Work Map** that tutor and voice can teach from.

**Owner:** Mayukh · **Reviewer:** Aadil · **Public host:** none (private) · **Local port:** 8083

## What it does

- **Build:** on `task_done`, gathers screen events, transcript turns, questions and answers, and drafts a Work Map with Claude Sonnet (zod structured output). Every step and guardrail cites at least one event and one turn; gaps become open items.
- **Debrief:** drives the spoken debrief as a state machine. It asks at least 3 follow-ups, gives a teach-back generated from the Work Map JSON, and records the expert's confirming turn (D8). Corrections go through a Sonnet patch.
- **Guardrails:** compiles rules to JSON-Logic over the normalized `InvoiceState` and keeps the G1–G5 demo tests green. These tests are the contract with tutor.
- **Publish:** fetches one clip per step from perception, writes `kb_chunks` (full-text, original language + English), stores `workmap.json`, `AGENT_RULES.md` and `guardrails.jsonlogic.json` in Storage, and emits `sk:workmap.published`.
- **Memory and recall:** keeps cross-session `expert_memory` and serves the `recall_context` tool.

The full spec is in `docs/DESIGN.md`. System design and contracts are in `docs/ARCHITECTURE.md`, and the database is in `docs/SCHEMA.md`. All three are synced from [`sidekik-docs`](../sidekik-docs).

## Interfaces

| Direction | What |
|---|---|
| Consumes | `sk:session.lifecycle` (`task_done`, `phase_changed`, `ended`), `sk:transcript.turns` |
| Serves | `POST /internal/workmaps/:id/publish`, `GET /internal/workmaps/:id/export?format=agent`, `POST /internal/tools/recall_context` |
| Publishes | `sk:agent.commands` (`followup`, `teachback`), `sk:workmap.published`, `sk:usage` |
| Calls | gateway `/internal/sessions/:id/phase`, brain `/internal/decide` (D6, D8, D12), perception `/internal/clips` |
| Writes | `work_maps`, `work_map_steps`, `guardrails`, `step_evidence`, `open_items`, `kb_chunks`, `expert_memory` |

## Stack

Node 20, TypeScript (strict), Fastify, zod, pino, vitest, pnpm, `json-logic-js`, the Anthropic SDK, and Docker (`node:20-slim`). Contracts come from `@sidekik/contracts`, pinned to a `sidekik-platform` git tag.

## Setup

```bash
# 1. Sync docs, CLAUDE.md and .env.example from sidekik-docs
cd ../sidekik-docs
bash scripts/sync-docs.sh .. --only sidekik-mapper

# 2. Configure env (values come from the team vault; never commit .env)
cd ../sidekik-mapper
cp .env.example .env

# 3. Start the shared dev stack (Redis + Presidio) from a sidekik-platform clone
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d

# 4. Install and run
pnpm install
pnpm dev            # tsx watch, reads .env
```

| Script | What it does |
|---|---|
| `pnpm dev` | Run from source with reload (reads `.env`) |
| `pnpm build` / `pnpm start` | Compile to `dist/` / run the compiled server |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest, including the G1–G5 guardrail tests (`test/guardrails.test.ts`, the contract with tutor) |
| `pnpm dev:mock` | Run against Redis only: in-memory store seeded with Sabine's session, no Supabase, teammates' services stubbed |
| `pnpm dev:replay <file.jsonl>` | Publish fixture events onto the bus (`--speed`, `--session`) |
| `pnpm dev:draft [--out file]` | Build Sabine's Work Map with the real Claude model and print it with the validation issues and demo cases (costs a few cents) |

### Running without teammates' services

```bash
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d   # Redis
pnpm dev:mock                                                         # prints the dev internal token
pnpm dev:replay dev/fixtures/capture_sabine.jsonl --speed 50          # task_done → draft → validated → "debrief requested"
```

`dev/fixtures/capture_sabine.json` is Sabine's 3-invoice capture session as the database holds it after capture (screen events, turns with an off-record span, brain's questions and answers, an open item from an earlier session). `pnpm dev:mock` drafts with Claude when `ANTHROPIC_API_KEY` is set, otherwise it replays the recorded draft in `dev/fixtures/sabine-draft.json`. `capture-lifecycle.jsonl` exercises the bus routing (replay sessions ignored, duplicates dropped).

In the mock, brain answers D6 with a fixed score and the gateway phase call is logged instead of sent.

The service checks every env var at boot and exits with a list of the ones that are missing. `GET /healthz` returns `{ok, version, deps}`, with 503 when Redis or Supabase is down.

Bus handling: every handler is idempotent on `event.id`, and every event of a replay session (`mode:"replay"`) is ignored. `task_done` queues a build job in an in-process queue: one active job per session, jobs for one session run in order, and on shutdown the service stops consuming, lets running jobs finish, then closes the bus.

Build job (`src/build/`), DESIGN §4:

1. **Gather** the session's change events and the expert's on-record turns (anything in an off-record span is dropped), brain's questions and answers, unasked questions and this expert's unresolved open items; trim screen events to a ~60k-token budget.
2. **Draft** with Claude Sonnet (`BUILDER_MODEL`) as structured output with server-side refusal fallback, retrying once on an invalid draft; save it as a `draft` with its `open_items`. IDs, timestamps, keyframes and source labels come from the session rows, not the model. Token usage goes to `sk:usage`.
3. **Validate** in code (`validate.ts`): unknown event and turn IDs are dropped, quotes must be verbatim in the cited turn (re-cited or replaced otherwise), rules must parse and read only `InvoiceState` variables, and every step and guardrail keeps a screen event and the expert's words; what can't be repaired becomes an open item. The G1–G5 demo cases (`src/guardrails/demo-cases.ts`) run against the result and are logged.
4. **Score** open items with brain's D6 and drop the trivial ones (never below three; kept as-is if brain is down).
5. **Hand over**: status `in_debrief`, then gateway `POST /internal/sessions/:id/phase` `{phase: "debrief", dynamic_variables: {open_items, prior_summary}}`. If the gateway call fails, the map goes back to `draft` and a redelivered `task_done` resumes from it without drafting again.

## Roadmap

One PR per ticket from `docs/DESIGN.md` §9. Each PR leaves the service booting with typecheck and tests green.

| PR | Branch | Ticket | Needs |
|---|---|---|---|
| 1 | `feat/scaffold` | Scaffold, env, bus wiring, in-process job runner (one job per session) | — |
| 2 | `feat/build` | Gather + build prompt with zod structured output, run against `capture_sabine.jsonl` | `@sidekik/contracts`, fixture |
| 3 | `feat/validate` | Code validation and the G1–G5 guardrail tests | `json-logic-js` |
| 4 | `feat/debrief` | Debrief state machine (`waiting_greeting → followups → teachback → confirming → confirmed`), with a timeout and retry for each state | brain `/internal/decide` (stub) |
| 5 | `feat/patch` | Patch flow for corrections (at most 2 loops) | |
| 6 | `feat/publish` | Publish: clips, `kb_chunks`, Storage artifacts, `sk:workmap.published` | perception `/internal/clips` (stub) |
| | | **Checkpoint 2 (H14):** at least 3 follow-ups, a teach-back, "Ja, passt" confirmed; about 7 steps, 3 judgment calls, 4–5 guardrails, all evidence-linked | |
| 7 | `feat/recall` | `recall_context`: `search_kb()` RPC + last 20 screen events, at most 5 snippets | |
| 8 | `feat/export` | Export endpoint (`AGENT_RULES.md`, `guardrails.jsonlogic.json`) | |
| 9 | `feat/expert-memory` | Expert memory (summary of at most 1,500 characters + remaining open items) | |
| 10 | `feat/compare` | Stretch: two experts, one task (`POST /internal/workflows/:id/compare`) | |
