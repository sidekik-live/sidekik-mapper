# TEMPORARY: stand-in for `@sidekik/contracts`

`sidekik-platform` hasn't published `@sidekik/contracts` yet. These files started as a copy of sidekik-gateway's stand-in and are aligned with sidekik-platform `main` (not yet tagged) where the mapper uses them: the bus wire format, the decision types and the names below.

**Every other file in this repo imports contracts only from `src/contracts/index.ts`.** When `v0.1.0` is tagged:

1. `pnpm add github:sidekik-live/sidekik-platform#v0.1.0`
2. Replace `index.ts` with `export * from '@sidekik/contracts';` and delete the other files here.
3. Run `pnpm typecheck && pnpm test` and fix any name drift.

Wire assumptions (checked against sidekik-platform `main`):

- Bus entries: `XADD <stream> MAXLEN ~ 10000 * ev <JSON envelope>` (one field named `ev`, as in sidekik-platform `src/bus.ts`).
- Envelope `type` values: `"session.lifecycle"`, `"transcript.turn"`, `"agent.command"`, `"usage"`.
- Replays publish under a new session id, and every lifecycle event of a replay carries `mode: "replay"`.

Added here beyond the gateway's copy, from sidekik-platform: `ScreenEvent`/`ScreenState` in `screen.ts`, `workmap.ts` (`WorkMap`, `Step`, `Guardrail`, `Evidence`, `OpenItem`, `WorkMapPublished`, `JSONLOGIC_VARIABLES`), and `decisions.ts` (`DecisionRequest`, `DecisionResult` with per-question `answers`, `DecisionResponseSchema`).

Switching to the package also means moving to zod 4 (the platform's version) and `fastify-type-provider-zod` 5+.
