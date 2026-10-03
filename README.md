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
| `pnpm test` | vitest, including the G1–G5 guardrail tests |
| `pnpm dev:mock` | Run against Redis and the sidekik-platform dev fixtures, with brain, perception and gateway stubbed |

The service checks every env var at boot and exits with a list of the ones that are missing. Lifecycle events for sessions started with `mode:"replay"` are ignored.

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
