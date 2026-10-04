# TEMPORARY: stand-in for `@sidekik/contracts`

`sidekik-platform` hasn't published `@sidekik/contracts` yet. These files are copied from sidekik-gateway's stand-in (same platform layout), which was written from `docs/ARCHITECTURE.md` §5 and the sidekik-platform API. Keep the two copies identical so both services agree on the wire format.

**Every other file in this repo imports contracts only from `src/contracts/index.ts`.** When `v0.1.0` is tagged:

1. `pnpm add github:<org>/sidekik-platform#v0.1.0`
2. Replace `index.ts` with `export * from '@sidekik/contracts';` and delete the other files here.
3. Run `pnpm typecheck && pnpm test` and fix any name drift.

Assumptions shared with the gateway (confirm with Sahil):

- Bus entries: `XADD <stream> MAXLEN ~ 10000 * data <JSON envelope>` (one field named `data`).
- Envelope `type` values: `"session.lifecycle"`, `"transcript.turn"`, `"agent.command"`.
- Replays publish under a new session id, and every lifecycle event of a replay carries `mode: "replay"`.

Added here beyond the gateway's copy (additive, from ARCHITECTURE §5 and Appendix B): `ScreenEvent`/`ScreenState` in `screen.ts`, and `workmap.ts` (`WorkMap`, `Step`, `Guardrail`, `Evidence`, `OpenItem`, `WorkMapPublished`, the allowed rule variables).

Still missing, and needed by later tickets: `DecisionRequest`/`DecisionResult`.
