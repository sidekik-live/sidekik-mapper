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
pnpm dev:replay dev/fixtures/debrief_sabine.jsonl                     # 3 follow-ups → teach-back → "work map confirmed"
# or debrief_sabine_correction.jsonl: Sabine corrects the teach-back, hears it restated, confirms
curl -X POST localhost:8083/internal/workmaps/<id>/publish \
  -H 'x-internal-token: dev-mock-secret-not-for-production-0000000000'   # id from "work map confirmed"; files in dev/out/
curl -OJ localhost:8083/internal/workmaps/<id>/export \
  -H 'x-internal-token: dev-mock-secret-not-for-production-0000000000'   # the agent-rules zip
curl -X POST localhost:8083/internal/tools/recall_context -H 'content-type: application/json' \
  -H 'x-internal-token: dev-mock-secret-not-for-production-0000000000' \
  -d '{"session_id":"00000000-0000-4000-8000-00000000d001","query":"Kranbau Dezember","scope":"workflow"}'
```

`dev/fixtures/capture_sabine.json` is Sabine's 3-invoice capture session as the database holds it after capture (screen events, turns with an off-record span, brain's questions and answers, an open item from an earlier session). `pnpm dev:mock` drafts with Claude when `ANTHROPIC_API_KEY` is set, otherwise it replays the recorded draft in `dev/fixtures/sabine-draft.json`. `capture-lifecycle.jsonl` exercises the bus routing (replay sessions ignored, duplicates dropped).

In the mock, brain is a stand-in (D6 keeps every item, D12 never ends early, D8 confirms a plain yes and reads a no or a "but" as a correction), the gateway phase calls are logged instead of sent, and without `ANTHROPIC_API_KEY` answers and corrections don't change the map and the teach-back is a template. Replay `debrief_sabine.jsonl` at speed 1: its gaps exceed the 2 s silence that ends an answer.

The service checks every env var at boot and exits with a list of the ones that are missing. `GET /healthz` returns `{ok, version, deps}`, with 503 when Redis or Supabase is down.

Bus handling: every handler is idempotent on `event.id`, and every event of a replay session (`mode:"replay"`) is ignored. `task_done` queues a build job in an in-process queue: one active job per session, jobs for one session run in order, and on shutdown the service stops consuming, lets running jobs finish, then closes the bus.

Build job (`src/build/`), DESIGN §4:

1. **Gather** the session's change events and the expert's on-record turns (anything in an off-record span is dropped), brain's questions and answers, unasked questions and this expert's unresolved open items; trim screen events to a ~60k-token budget.
2. **Draft** with Claude Sonnet (`BUILDER_MODEL`) as structured output with server-side refusal fallback, retrying once on an invalid draft; save it as a `draft` with its `open_items`. IDs, timestamps, keyframes and source labels come from the session rows, not the model. Token usage goes to `sk:usage`.
3. **Validate** in code (`validate.ts`): unknown event and turn IDs are dropped, quotes must be verbatim in the cited turn (re-cited or replaced otherwise), rules must parse and read only `InvoiceState` variables, and every step and guardrail keeps a screen event and the expert's words; what can't be repaired becomes an open item. The G1–G5 demo cases (`src/guardrails/demo-cases.ts`) run against the result and are logged.
4. **Score** open items with brain's D6 and drop the trivial ones (never below three; kept as-is if brain is down).
5. **Hand over**: status `in_debrief`, then gateway `POST /internal/sessions/:id/phase` `{phase: "debrief", dynamic_variables: {open_items, prior_summary}}`. If the gateway call fails, the map goes back to `draft` and a redelivered `task_done` resumes from it without drafting again.

Debrief driver (`src/debrief/`), DESIGN §5, a state machine per session (`waiting_greeting → followups → confirming → confirmed`):

1. **Greeting:** after `phase_changed` to `debrief`, wait for the agent's first turn (90 s, then start anyway).
2. **Follow-ups:** publish `followup` for the most important open item; an answer ends after 2 s of the expert's silence; no answer in 60 s asks again once, then moves on. Each answer goes to a small Sonnet patch (`PATCH_MODEL`) that sets a step's reason, adds evidence to a guardrail or adds a guardrail; the map is validated again and saved. Judgment calls without a reason become open items. D12 tells whether the expert says that's everything.
3. **Coverage:** at least 3 follow-ups and no high-importance item left (or the expert is done after 3), at most 6.
4. **Teach-back:** a 60–90 s script written from the Work Map JSON in the expert's language (template if Claude fails), sent once every answer is in the map. Talk while the agent reads it isn't taken as the reply.
5. **Confirmation:** D8 on the reply. `confirmed`/`confirmed_minor` at ≥0.80 saves `confirmed_turn_id`, sets the map `confirmed` and requests the gateway's `confirmed` phase; `unclear` or low confidence asks again, three times at most, then the map stays `in_debrief`. If brain is unreachable, a plain yes ("Ja, passt.") still confirms.
6. **Corrections:** a `corrected` reply goes to a Sonnet correction patch (fix a step, rewrite or remove a guardrail with the correction as evidence, remove a step, add a rule), validated and saved; then only the corrected part is restated as a short `teachback` and D8 runs on the next reply. The model's restatement is used only when the whole patch applied cleanly, otherwise it is rebuilt from what changed in the map. At most two correction loops; a correction that changes nothing or fails is asked again.

The driver's state is in memory: a restart mid-debrief loses it, and the map stays `in_debrief`.

Publish (`src/publish/`), DESIGN §6: `POST /internal/workmaps/:id/publish` (gateway proxies it; `X-Internal-Token`) answers `202 {job_id}` for a `confirmed` map (or a `published` one, to refresh it), 404 for an unknown map and 409 otherwise. The job, one at a time per map:

1. **Guardrails:** every rule must compile, or the publish fails; the G1–G5 demo cases run and failures are logged.
2. **Clips:** asks perception for one clip per step (6 s before, 4 s after its screen moment); perception writes the `clips` rows. If perception is down the map is published without clips.
3. **Search:** replaces the map's `kb_chunks`: one per step, guardrail and brain answer, original language plus English.
4. **Storage:** `workmap.json`, `AGENT_RULES.md` and `guardrails.jsonlogic.json` under `workmaps/org/{org}/{id}/v{n}/`.
5. **Announce:** status `published` with `published_at`, then `sk:workmap.published {workmap_id, workflow_id, version}` (voice loads the map from Storage, tutor from the database).

Expert memory (`src/memory/`), one `expert_memory` row per expert and workflow: a summary of at most 1,500 characters (the map's steps with the expert's own reasons for judgment calls, its rules, how many questions are open) and the ids of the expert's unresolved open items across their capture sessions. The gateway reads it for the next capture session (`{{prior_summary}}`, `{{open_items}}`) and the debrief uses the summary. It is written at publish (after the announcement; a failure doesn't fail the publish) and when a capture session ends (from that session's map, whatever its status; without a map only the open items are refreshed). The summary is built from the map, not generated, so it repeats only what the expert confirmed.

Export (`src/publish/export.ts`): `GET /internal/workmaps/:id/export?format=agent` (gateway relays `GET /v1/workmaps/:id/export`) downloads `<title>-v<n>-agent-rules.zip` with `AGENT_RULES.md` and `guardrails.jsonlogic.json`, rendered exactly as publish writes them. Offered once the expert has confirmed the map (`confirmed` or `published`), 409 before that.

`recall_context` (`src/recall/`), the interviewer's webhook tool through the gateway (`POST /internal/tools/recall_context {session_id, query, scope}`, 1 s budget) → `{snippets: [{text, t_ms, source}]}`, at most 5:

- `scope: "workflow"`: the workflow's published knowledge from `search_kb()` (Postgres full-text, trigram fallback; given 600 ms, skipped if slow or down).
- `scope: "session"` (default): this session's on-record expert turns.
- Both: the session's last 20 screen events that match the query (an opened record carries its supplier, amount, category, company code, cost center and month).
- Ranked together, best first; if nothing matches, the 2 newest screen events. Nothing from an off-record span is ever returned.

Compare two experts (`src/compare/`, DESIGN §7, stretch): `POST /internal/workflows/:id/compare {workmap_a, workmap_b}` aligns the two confirmed maps' steps by screen signature (app, record kind, field), has Sonnet (`PATCH_MODEL`) report the differences in substance (a decision, value, threshold or rule, not wording), and turns each into an open item for both experts, naming the other ("Jürgen codes this 0410, you code it 0400. Why?"), on their map and session so their next debrief asks it. Comparing again adds nothing twice. Without `ANTHROPIC_API_KEY` (dev:mock) a structural comparison finds steps only one expert does and rules that differ.

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
