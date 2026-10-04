# sidekik-mapper

Part of **Sidekik**, an AI apprentice (sidekik.live). Team: Sahil, Aadil, Mayukh. This repo's spec is `docs/DESIGN.md`. The system design and contracts are in `docs/ARCHITECTURE.md`, and the database is in `docs/SCHEMA.md`.

@docs/DESIGN.md
@docs/ARCHITECTURE.md
@docs/SCHEMA.md

## Rules for Claude Code in this repo
- Stack: Node 22, TypeScript strict, Fastify, zod, pino, vitest, pnpm. Listen on host `::` and `PORT`.
- Build the tickets in docs/DESIGN.md in order; one PR per ticket or two; conventional commits.
- Import every payload type, stream name, and the bus/auth helpers from `@sidekik/contracts` (pinned git tag). Never redefine a contract locally. If one is missing, stop and draft an issue for sidekik-platform.
- Write only to the tables this service owns (ARCHITECTURE §6, SCHEMA.md). You may read any table.
- Validate env with zod at boot; keep `.env.example` complete; never commit secrets.
- Every bus handler is idempotent on `event.id`; every log line carries `session_id` and `org_id`.
- `pnpm dev:mock` must run this service against sidekik-platform dev fixtures without teammates' services; stub their HTTP endpoints behind an interface.
- Ignore events for sessions whose lifecycle `started` had `mode:"replay"` (this doesn't apply to sidekik-gateway).
- When unsure about a vendor API (Jev/TypeSafe, ElevenLabs, Recall, Supabase), read the installed SDK's type definitions or the official docs before writing code. Don't guess field names.
- Never edit docs/ARCHITECTURE.md or docs/SCHEMA.md here. They are synced copies; the source is the sidekik-docs repo (change it there by PR).
