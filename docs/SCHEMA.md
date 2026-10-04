# Sidekik: Database schema (Supabase Postgres)

This is the canonical list of tables. Migrations in `sidekik-platform/supabase/migrations` implement this file exactly. Each service **writes only to the tables it owns** and may read any table.

The base column set is `org_id` plus the defaults below. Every table except `orgs` has it.

```sql
-- every table (except orgs) has:
id         uuid primary key default gen_random_uuid(),
org_id     uuid not null references orgs(id) on delete cascade,
created_at timestamptz not null default now()
```

The `-- + base` comment below marks tables that have this base set.

Time on the session timeline is always `t_ms int` (milliseconds since session start).

## 0000 extensions

```sql
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;    -- fuzzy matching for recall_context
```

## 0001_core.sql — owner: gateway (Mayukh)

```sql
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  settings jsonb not null default '{"retention_days":30,"store_learner_keyframes":false,
     "languages":["de","en"],"jev_enabled":true,"consent_text_version":"v1"}',
  created_at timestamptz not null default now()
);

create table org_members (            -- + base
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','expert','learner','manager')),
  unique (org_id, user_id)
);

create table experts (                -- + base
  user_id uuid references auth.users(id),
  display_name text not null,
  language text not null default 'de',
  onet_code text
);

create table learners (               -- + base
  user_id uuid references auth.users(id),
  display_name text not null,
  language text not null default 'en'
);

create table workflows (              -- + base
  name text not null,
  description text,
  onet_code text,
  current_workmap_id uuid           -- FK added in 0005
);

create table sessions (               -- + base
  workflow_id uuid not null references workflows(id),
  kind text not null check (kind in ('capture','tutor')),
  mode text not null check (mode in ('browser','meeting','replay')),
  phase text not null check (phase in ('capture','building','debrief','confirmed','tutoring','done')),
  expert_id uuid references experts(id),
  learner_id uuid references learners(id),
  workmap_id uuid,                  -- FK added in 0005 (tutor sessions)
  language text not null default 'en',
  el_agent_id text,
  el_conversation_id text,
  off_record boolean not null default false,
  consent_at timestamptz,
  replay_of uuid references sessions(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table consent_records (        -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid references auth.users(id),
  text_version text not null,
  scopes text[] not null,           -- {'audio','screen','storage'}
  granted_at timestamptz not null default now()
);

create table off_record_spans (       -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  start_t_ms int not null,
  end_t_ms int,
  source text not null check (source in ('ui','agent','chat','brain','retroactive'))
);

create table agent_host_tokens (      -- + base
  token text not null unique,
  session_id uuid not null references sessions(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table cost_ledger (            -- + base
  session_id uuid references sessions(id) on delete cascade,
  service text not null,
  vendor text not null check (vendor in ('elevenlabs','typesafe','anthropic','recall')),
  units numeric not null,
  unit text not null,
  cost_usd numeric(12,6) not null,
  counterfactual_usd numeric(12,6)
);

create table replay_events (          -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  stream text not null,
  t_ms int not null,
  envelope jsonb not null
);
create index on replay_events (session_id, t_ms);
```

## 0002_voice.sql — owner: voice (Aadil)

```sql
create table transcript_turns (       -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  turn_id text not null,
  role text not null check (role in ('user','agent')),
  text_redacted text not null,
  lang text,
  t_ms int not null,
  source text not null check (source in ('live','webhook')),
  off_record boolean not null default false,
  unique (session_id, turn_id)
);
create index on transcript_turns (session_id, t_ms);

create table agent_configs (          -- + base
  workmap_id uuid,                  -- FK added in 0005
  version int not null,
  el_agent_id text not null,
  kb_doc_id text,
  procedure_ids jsonb not null default '{}'   -- {step_id: procedure_id, "intervention": id}
);
```

## 0003_meetbot.sql — owner: meetbot (Aadil)

```sql
create table meeting_bots (           -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  bot_id text not null unique,
  platform text check (platform in ('google_meet','zoom','teams','unknown')),
  status text not null,
  joined_at timestamptz,
  left_at timestamptz,
  error text
);
```

## 0004_capture.sql — owner: perception + brain (Sahil)

```sql
-- perception
create table keyframes (              -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  t_ms int not null,
  storage_path text not null,
  phash text not null,              -- 16 hex chars (64-bit)
  redacted boolean not null default true
);
create index on keyframes (session_id, t_ms);

create table screen_events (          -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  event_id text not null unique,    -- ulid from the envelope
  t_ms int not null,
  type text not null,
  entity_kind text, entity_id text, field text,
  before_val text, after_val text,
  state jsonb,
  bbox jsonb,
  confidence real,
  source text not null check (source in ('vision','dom')),
  keyframe_id uuid references keyframes(id) on delete set null,
  event_class text                  -- D2 result, written by brain via update
);
create index on screen_events (session_id, t_ms);

create table clips (                  -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  step_id uuid,                     -- FK added in 0005
  t_ms int not null,
  storage_path text not null,
  duration_s real not null
);

-- brain
create table questions (              -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  phase text not null check (phase in ('capture','debrief')),
  qtype text not null check (qtype in ('exception','limit','other','stop_and_ask','why')),
  text text not null,
  anchor_event_ids text[] not null default '{}',
  status text not null check (status in ('candidate','asked','answered','expired')),
  created_t_ms int not null,
  asked_t_ms int,
  jev_scores jsonb
);
create index on questions (session_id, status);

create table answers (                -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  turn_ids text[] not null,
  content_class text not null,
  quote text not null,
  quote_en text,
  has_condition boolean not null default false,
  extracted_rule text
);

create table decisions_log (          -- + base
  session_id uuid references sessions(id) on delete cascade,
  decision text not null,           -- 'D1'..'D12'
  provider text not null check (provider in ('jev','openrouter-jev','llm')),
  model text,
  answer jsonb not null,
  confidence real,
  escalated boolean not null default false,
  latency_ms int not null,
  input_tokens int,
  cost_usd numeric(12,6),
  counterfactual_usd numeric(12,6)
);
create index on decisions_log (session_id, created_at);
```

Note: brain updates `screen_events.event_class` (a column perception doesn't write). This is the one shared-write exception, and it's allowed.

## 0005_mapping.sql — owner: mapper (Mayukh)

```sql
create table work_maps (              -- + base
  workflow_id uuid not null references workflows(id),
  expert_id uuid not null references experts(id),
  session_id uuid references sessions(id),
  version int not null,
  status text not null check (status in ('draft','in_debrief','confirmed','published','retired')),
  language text not null,
  json jsonb not null,              -- full WorkMap (ARCHITECTURE Appendix B)
  confirmed_turn_id text,
  published_at timestamptz,
  unique (workflow_id, version)
);

create table work_map_steps (         -- + base
  work_map_id uuid not null references work_maps(id) on delete cascade,
  key text not null,                -- 'S4'
  ordinal int not null,
  title text not null,
  decision text not null,
  reason_quote text, reason_quote_en text, reason_turn_id text, source_label text,
  is_judgment_call boolean not null default false,
  screen_moment jsonb not null,
  screen_signature jsonb not null,
  el_procedure_id text,
  unique (work_map_id, key)
);

create table guardrails (             -- + base
  work_map_id uuid not null references work_maps(id) on delete cascade,
  key text not null,                -- 'G1'
  kind text not null check (kind in ('threshold','condition','stop_and_ask','second_approval','hold')),
  description text not null,
  rule_jsonlogic jsonb not null,
  consequence jsonb not null,
  quote text not null, quote_en text,
  unique (work_map_id, key)
);

create table step_evidence (          -- + base
  work_map_id uuid not null references work_maps(id) on delete cascade,
  step_id uuid references work_map_steps(id) on delete cascade,
  guardrail_id uuid references guardrails(id) on delete cascade,
  screen_event_id text,
  keyframe_id uuid references keyframes(id) on delete set null,
  clip_id uuid references clips(id) on delete set null,
  transcript_turn_id text not null,
  t_ms int not null,
  quote text,
  source_label text,
  check (step_id is not null or guardrail_id is not null)
);

create table open_items (             -- + base
  workflow_id uuid not null references workflows(id),
  work_map_id uuid references work_maps(id) on delete cascade,
  session_id uuid references sessions(id),
  text text not null,
  anchor_t_ms int,
  origin text not null check (origin in ('live','builder','learner_gap')),
  status text not null check (status in ('open','asked','resolved')),
  importance int not null default 2  -- 1 low .. 3 high
);

create table kb_chunks (              -- + base
  workflow_id uuid not null references workflows(id),
  work_map_id uuid references work_maps(id) on delete cascade,
  kind text not null check (kind in ('step','guardrail','answer')),
  ref_id uuid,
  content text not null,             -- original language + English, concatenated
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);
-- 'simple' config: no language stemming, so German and English text index the same way
create index on kb_chunks using gin (tsv);
create index on kb_chunks using gin (content gin_trgm_ops);   -- fuzzy fallback (typos, partial words)

-- recall_context query (mapper): full-text first, trigram word similarity as fallback.
-- Word similarity (<%), not whole-string similarity (%): a short query against a long chunk never reaches
-- the whole-string threshold, so typos would never match. 0.4 finds typo'd words ("Anlagenumer", "Kranbua").
create or replace function search_kb(p_org uuid, p_workflow uuid, p_query text, p_limit int default 5)
returns table (id uuid, kind text, ref_id uuid, content text, score real)
language sql stable
set pg_trgm.word_similarity_threshold = 0.4
as $$
  with fts as (
    select k.id, k.kind, k.ref_id, k.content,
           ts_rank(k.tsv, websearch_to_tsquery('simple', p_query)) as score
    from kb_chunks k
    where k.org_id = p_org and k.workflow_id = p_workflow
      and k.tsv @@ websearch_to_tsquery('simple', p_query)
  ), trgm as (
    select k.id, k.kind, k.ref_id, k.content, word_similarity(p_query, k.content) as score
    from kb_chunks k
    where k.org_id = p_org and k.workflow_id = p_workflow
      and not exists (select 1 from fts)
      and p_query <% k.content
  )
  select * from fts union all select * from trgm
  order by score desc limit p_limit;
$$;

create table expert_memory (          -- + base
  expert_id uuid not null references experts(id),
  workflow_id uuid not null references workflows(id),
  summary text not null default '',
  open_item_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (expert_id, workflow_id)
);

alter table workflows     add foreign key (current_workmap_id) references work_maps(id);
alter table sessions      add foreign key (workmap_id) references work_maps(id);
alter table agent_configs add foreign key (workmap_id) references work_maps(id);
alter table clips         add foreign key (step_id) references work_map_steps(id) on delete set null;
```

## 0006_teaching.sql — owner: tutor (Mayukh)

```sql
create table learner_attempts (       -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  learner_id uuid not null references learners(id),
  work_map_id uuid not null references work_maps(id),
  step_id uuid not null references work_map_steps(id),
  case_ref text,
  predicted text,
  prediction_grade text,
  actual_action jsonb,
  outcome text check (outcome in ('independent_correct','prompted_correct',
                                   'corrected_after_intervention','not_attempted'))
);

create table interventions (          -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  learner_id uuid not null references learners(id),
  guardrail_id uuid references guardrails(id),
  step_id uuid references work_map_steps(id),
  t_ms int not null,
  trigger text not null check (trigger in ('presave','live','divergence')),
  style text not null check (style in ('hint_soft','intervene_now')),
  resolved boolean not null default false
);

create table mastery (                -- + base
  session_id uuid not null references sessions(id) on delete cascade,
  learner_id uuid not null references learners(id),
  work_map_id uuid not null references work_maps(id),
  summary jsonb not null            -- MasterySummary
);

create table gap_flags (              -- + base
  work_map_id uuid not null references work_maps(id) on delete cascade,
  step_id uuid references work_map_steps(id),
  guardrail_id uuid references guardrails(id),
  kind text not null check (kind in ('guardrail_tripped','prediction_unsure')),
  learner_ids uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open','sent_to_expert','resolved')),
  unique (work_map_id, step_id, guardrail_id, kind)
);
```

## 0007_rls.sql — owner: platform (Sahil), reviewed by Mayukh

```sql
create or replace function is_member(org uuid) returns boolean
language sql security definer stable as $$
  select exists (select 1 from org_members m where m.org_id = org and m.user_id = auth.uid());
$$;

create or replace function has_role(org uuid, roles text[]) returns boolean
language sql security definer stable as $$
  select exists (select 1 from org_members m where m.org_id = org and m.user_id = auth.uid()
                 and m.role = any(roles));
$$;

-- For EVERY table with org_id:
--   alter table <t> enable row level security;
--   create policy org_read on <t> for select using (is_member(org_id));
-- orgs: create policy org_read on orgs for select using (is_member(id));
-- Exception: agent_host_tokens gets RLS but NO policy. They are one-time credentials, read only by the
-- gateway (service role); an org_read policy would let any member claim an agent-host session.
-- is_member/has_role are SECURITY DEFINER: pin `set search_path = ''` and schema-qualify public.org_members.

-- Learner privacy (replace org_read on these two):
create policy learner_own on learner_attempts for select using (
  has_role(org_id, array['admin','manager'])
  or learner_id in (select id from learners where user_id = auth.uid()));
create policy learner_own on mastery for select using (
  has_role(org_id, array['admin','manager'])
  or learner_id in (select id from learners where user_id = auth.uid()));

-- No insert/update/delete policies for the browser: services write with the service role.
```

## 0008_storage.sql

```sql
insert into storage.buckets (id, name, public) values
  ('captures','captures',false), ('workmaps','workmaps',false), ('replays','replays',false)
on conflict do nothing;
-- No storage policies for anon/authenticated: all access via signed URLs minted by services.
```

## seed.sql (demo data)

- **Org:** "Maschinenbau AG".
- **Users:**
  - admin: one per teammate, so Sahil, Aadil and Mayukh each sign in by magic link and then get the admin role in `org_members`
  - expert: "Sabine" (de)
  - learner: "Lena" (en)
- **Workflow:** "Supplier invoice coding" (O*NET 43-3031.00).
- **MiniERP invoices** live in a JSON file in sidekik-web (`src/sandbox/invoices.json`), not in the database:
  1. #4471: CNC fixture from "Präzisionswerk Ulm", known supplier, €6,350, equipment, DE01, opened on 4711. The expert recodes it to 0400 and adds an asset number.
  2. #4480: "Kranbau GmbH" (double-bills in December), known, €1,980, services, DE01, dated December → hold.
  3. #4492: "Strojírna Brno s.r.o.", known, €3,400, parts, **CZ01** → second approval.
  4. #4501: "Bürobedarf Weber", known, €240, office, DE01, 4711 → routine.
  5. #4510 (tutor case, never shown in capture): "Antriebstechnik Nord", **unknown supplier**, €7,200, equipment (spindle motor), DE01 → learner reaches for 4711 → G1, G2, G3.
  6. #4511 (tutor case): "Kranbau GmbH", €2,150, December → G4.
- **A pre-confirmed Work Map** (version 1, status `published`) with steps S1–S7 and guardrails G1–G5, for the demo fallback.
