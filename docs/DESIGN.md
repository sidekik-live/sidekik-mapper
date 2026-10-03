# sidekik-mapper: DESIGN

**Owner:** Mayukh · **Reviewer:** Aadil · **Public host:** none (private) · **Local port:** 8083

## 1. Purpose

Mapper turns a capture session into a **confirmed, evidence-linked Work Map**. It:

1. builds a draft from screen events, transcript turns, questions and answers;
2. runs the spoken debrief (at least 3 follow-ups, then a teach-back the expert confirms);
3. compiles guardrails into JSON-Logic;
4. publishes the Work Map to tutor and voice;
5. exports it as agent-ready rules.

It also keeps cross-session expert memory and answers `recall_context`.

## 2. Interfaces

**Inbound**

| Interface | Detail |
|---|---|
| Consumes `sk:session.lifecycle` | `task_done` (kind capture) → build job. `phase_changed` → debrief starts. `ended` → finalize memory. |
| Consumes `sk:transcript.turns` | During `debrief`, collects the expert's answers to each follow-up and their reply to the teach-back. |
| `POST /internal/workmaps/:id/publish` | → `{job_id}` |
| `GET /internal/workmaps/:id/export?format=agent` | → `AGENT_RULES.md`, `guardrails.jsonlogic.json` (zip or JSON) |
| `POST /internal/tools/recall_context` | `{session_id, query, scope:"session"\|"workflow"}` → `{snippets:[{text, t_ms, source}]}` (`search_kb()` full-text top-5, trigram fallback, plus the last 20 events) |

**Outbound**

| Destination | Detail |
|---|---|
| `sk:agent.commands` | `followup`, `teachback` |
| Gateway `/internal/sessions/:id/phase` | `debrief`, then `confirmed` |
| Brain `/internal/decide` | D6, D8, D12 |
| Perception `/internal/clips` | at publish time |
| `sk:workmap.published`, `sk:usage` | |
| Tables | `work_maps`, `work_map_steps`, `guardrails`, `step_evidence`, `open_items`, `kb_chunks`, `expert_memory` |

## 3. Work Map schema (canonical copy: ARCHITECTURE Appendix B, implemented in `@sidekik/contracts/workmap.ts`)

```ts
type WorkMap = { id: string; workflow_id: string; expert_id: string; version: number;
  status: "draft"|"in_debrief"|"confirmed"|"published"|"retired";
  title: string; language: string; steps: Step[]; guardrails: Guardrail[]; open_items: OpenItem[];
  confirmed_turn_id?: string };

type Step = { id: string; ordinal: number; title: string;            // "Code the invoice to a cost center"
  screen_moment: { t_ms: number; label: string; event_ids: string[]; entity?: string; field?: string };
  decision: string;                                                    // "Re-coded opex (4711) to capex (0400)"
  reason: { quote: string; quote_en?: string; turn_id: string; source_label: string } | null;
  guardrail_ids: string[]; is_judgment_call: boolean;
  screen_signature: { app: string; record_kind: string; field?: string } };

type Guardrail = { id: string; kind: "threshold"|"condition"|"stop_and_ask"|"second_approval"|"hold";
  description: string; rule: JsonLogic; consequence: { require?: Record<string,string>; block?: boolean;
  action?: "ask_controller"|"hold"|"second_approval" };
  quote: string; quote_en?: string; evidence: Evidence[] };

type Evidence = { event_id?: string; keyframe_id?: string; clip_id?: string; turn_id: string; t_ms: number };
type OpenItem = { id: string; text: string; anchor_t_ms?: number; origin: "live"|"builder"|"learner_gap";
  status: "open"|"asked"|"resolved" };
```

**Allowed JSON-Logic variables** (normalized `InvoiceState` only): `net_amount, currency, category, supplier, supplier_known, invoice_month, company_code, cost_center, asset_number, approvals_count`.

## 4. Build job (on `task_done`)

1. **Gather.** Load the session's `screen_events` (change events only), `transcript_turns` (expert, redacted), `questions` + `answers`, expired candidate questions, and the open items left from the expert's previous sessions on this workflow.
2. **Draft.** Call **Claude Sonnet** with structured output against the zod schema (one retry on validation failure). Budget about 30–60k input tokens.
   - **Prompt rules:**
     - Every step and guardrail must cite ≥1 `event_id` and ≥1 `turn_id` from the input. If evidence is missing, create an open item instead.
     - Quote reasons verbatim in the original language and add an English translation.
     - Write rules only with the allowed variables.
     - Produce 3–8 open items, ordered by importance.
3. **Validate in code.**
   - Every evidence ID exists.
   - Every rule parses.
   - Run the **guardrail unit tests** (§6).
   - Score open items with D6 and drop the trivial ones.
4. **Hand over to the debrief.** Write the draft with status `in_debrief`, then call gateway phase `debrief` with `dynamic_variables.open_items` (the top 5 as text).
   - The agent needs about 30–60 s to restart in debrief mode. In the meantime the UI shows "reviewing your session".

## 5. Debrief driver

- **Wait for the agent.** After `phase_changed` (debrief), wait for the agent's first turn, which is the greeting.
- **Follow-ups (at least 3).** Publish `followup` for one open item at a time.
  - Collect the expert's turns until they've been silent for ≥2 s (or D12 says done).
  - Attach the answer as evidence to the affected step or guardrail, or create a new guardrail through a small Sonnet patch call.
  - Mark the open item `resolved`.
- **Coverage check (code).** It passes when:
  - every step has a decision, a reason quote, and either guardrails or an explicit "none";
  - at least 3 follow-ups have been asked;
  - no open items with high importance remain.
  - **If it fails:** ask the next open item, up to 6 follow-ups in total. After that, leave the rest open and mark it in the UI.
- **Teach-back.** Generate a 60–90 s script **from the Work Map JSON**, not from the transcript, so that confirming it confirms the artifact. Publish `teachback`.
- **Confirmation.** Run D8 on the expert's reply.
  - `confirmed` / `confirmed_minor` at ≥0.80 → save `confirmed_turn_id`, set status `confirmed`, call gateway phase `confirmed`.
  - `corrected` → apply a Sonnet patch, restate only the corrected part (a new short `teachback`), and run D8 again (at most 2 loops).

## 6. Publish (`/internal/workmaps/:id/publish`)

1. Compile and test the guardrails. Required demo tests:

| Rule | Case | Expected |
|---|---|---|
| G1 | net €7,200, category equipment, cost_center 4711 | violation; requires 0400 |
| G2 | cost_center 0400 with no asset_number | blocked |
| G3 | supplier_known = false | stop and ask the controller |
| G4 | double-billing supplier and invoice_month = 12 | hold + duplicate check |
| G5 | company_code starts with "CZ" and approvals_count < 2 | second approval |

2. Ask perception for one clip per step at `screen_moment.t_ms`.
3. Chunk the Work Map (one chunk per step, per guardrail and per expert answer) and upsert `kb_chunks`.
   - Each chunk's `content` holds the original-language text **and** the English translation, so German and English queries both match.
   - The `tsv` column is generated by Postgres, so no embedding call is needed.
4. Write `workmap.json`, `AGENT_RULES.md` and `guardrails.jsonlogic.json` to Storage under `workmaps/org/{org}/{id}/v{n}/`.
5. Set status `published` and publish `sk:workmap.published`.
6. Update `expert_memory`: a summary of at most 1,500 characters plus the remaining open items.

**`AGENT_RULES.md` format (stretch goal: agent-ready guardrails):**
- One section per step: when (screen signature), do (decision), why (quote).
- A list of "STOP and ask a human when …" rules.
- The JSON-Logic is attached.

## 7. Stretch: two experts, one task

`POST /internal/workflows/:id/compare {workmap_a, workmap_b}`:
1. Align steps by `screen_signature`.
2. Diff the decisions and guardrails.
3. Create an open item for each difference ("Sabine codes this 0400, Jürgen 0410. Why?") for both experts' next debriefs.

### Upgrade path (only if keyword search proves too weak)

Anthropic doesn't offer an embeddings model; its docs point to Voyage AI. If needed after the hackathon:
- add a `VOYAGE_API_KEY` and an `embedding` column to `kb_chunks`;
- combine vector and full-text scores.

Don't do this during the 24 hours.

## 8. Env

`PORT, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_INTERNAL_TOKEN, ANTHROPIC_API_KEY, BUILDER_MODEL, PATCH_MODEL, BRAIN_URL, GATEWAY_INTERNAL_URL, PERCEPTION_URL`

## 9. Claude Code tickets

1. Scaffold, env, bus wiring, job runner (in-process queue, one job per session).
2. Gather plus the build prompt with zod structured output, run against the `capture_sabine.jsonl` fixture.
3. Code validation and the guardrail tests in §6 (vitest, with `json-logic-js`).
4. Debrief driver as a state machine (`waiting_greeting → followups → teachback → confirming → confirmed`), with a timeout and retry for each state.
5. Patch flow for corrections.
6. Publish: clips, `kb_chunks` (full-text), Storage artifacts, publishing the event.
7. `recall_context` tool: call `search_kb()` via Supabase RPC, merge with the last 20 screen events, return ≤5 snippets.
8. Export endpoint.
9. Expert memory.
10. Stretch: compare endpoint.

## 10. Definition of done (Checkpoint 2)

- After Sabine's 3-invoice session, the debrief asks at least 3 follow-ups and delivers a teach-back.
- Her "Ja, passt" is recorded as the confirming turn.
- The published Work Map has about 7 steps, 3 judgment calls and 4–5 guardrails.
- Every step and guardrail links to an event, a keyframe or clip, and her words.
