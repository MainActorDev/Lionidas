# Review — Lionidas CLI plan (20260930T092035Z)

- Reviewed: `plans/20260930T092035Z-lionidas-cli-plan.md` (status Ready, 2026-09-30) against main `43c526b`
- Sources: brainstorm `20260930T092035Z-lionidas-cli.md` (Direction selected + Decisions log + Architecture); live code survey 2026-09-30 (auth/roles.ts hook incl. extractAgentToken + bot-token paths; index.ts buildApp; config.ts CRUCIBLE_PORT/CRUCIBLE_DB_PATH; users schema + role vocabulary; templates name uniqueness; PR #12 merged)
- Verdict: **Needs revision** (2026-09-30) → **plan rev 2 applies F1-F6; Ready for implementation** (operator: "Apply the five edits first. And I'll read the plan first")

## Traceability

All seven decisions trace to plan work: full table phased (Stage/Phase structure), PAT+approval+paste (Stage 1 server additions), workspace-bin-from-anywhere (acceptance check), architecture layering (carried verbatim), folder group (Phase 2 command spec + decision 5), command table (spec section), interim cookie auth (decision 7, Stage 0). No extra commitments found.

## Findings

### F1 (High) — the plan designs PAT auth blind to the existing Authorization machinery; as written it would break bot auth or be unimplementable as described

Verified in `server/src/auth/roles.ts` (`registerUserResolution` hook):
- `extractAgentToken` ALREADY parses `Authorization: Bearer crucible-…` and an `x-crucible-agent` header, resolving them to BOT users (per-bot scrypt secrets + a legacy shared `CRUCIBLE_AGENT_TOKEN` + an internal `BOOT_SECRET` self-call path).
- The plan's "Bearer parsing in the session hook" lands in the SAME hook with NO collision strategy: a `Bearer lionidas_…` PAT and a `Bearer crucible-…` bot token must be disambiguated, and the plan's stated token format is unpinned.

**Correction (mechanical, decision preserved):** pin the PAT wire format with a distinct prefix — `Authorization: Bearer lion_<hex>` — and insert PAT resolution in the hook AFTER cookie-session and BEFORE the agent-token branch, returning early on hit (PAT ≠ bot: real user row + its role; never falls through to bot fallbacks). Add: PAT lookup indexes `api_tokens.token_hash`, constant-time compare, `last_used` touch (throttled), revoked_at check. Tests: PAT works alongside a bot token on the same scratch server (both authenticate as their own identities); `Bearer crucible-…` path unchanged.

### F2 (Medium) — contract-harness claim is supported but the plan doesn't name the seam it will use

Verified: `buildApp(env)` in server/src/index.ts:52 builds the full app from env (`CRUCIBLE_PORT`, `CRUCIBLE_DB_PATH`, `CRUCIBLE_SILENT`/`VITEST` for silent logs) and `app.inject` is the established route-test pattern (env-vars-routes, logout-registry tests). But CLI contract tests want a REAL listening server (the CLI is an HTTP client) — `inject` can't exercise the client layer.

**Correction:** Stage 0 pins the harness: spawn via `buildApp` + `app.listen({ port: 0 })` (ephemeral) in the test process, tmp `CRUCIBLE_DB_PATH`, `CRUCIBLE_WATCHDOG=0`, then point the CLI client at `127.0.0.1:<port>` via `LIONIDAS_URL`. One harness module shared by all per-command test files; teardown closes app + deletes tmp DB. (The plan's "scratch server on ephemeral port" becomes a named mechanism, not an aspiration.)

### F3 (Medium) — `stack up` supervision vs the running dev workflow: port-conflict policy stated for conflicts but not for DETACHED-mode orphan cleanup

The plan detects port conflicts and refuses (good). But `stack down`/`restart` rely on the pidfile group; pids that died without cleanup (reboot, kill -9) leave stale pidfiles, and a server started MANUALLY (`pnpm dev` by the human) won't be in the group at all. Policy needed: `stack status` reconciles pidfile vs actual listeners (lsof on ports wins; stale pidfile pruned with a note); `stack down` stops only pids it owns + reports foreign listeners instead of killing them (the plan says never kill unknowns — extend explicitly to stale-pidfile reconciliation).

### F4 (Low) — `case verify` semantics vs infra-abort: an aborted run (stream gate, device busy) is NOT a case failure

Verified run statuses: passed/failed/aborted (+blocked flag for infra). `verify` exiting 1 on abort conflates "case broken" with "environment broken" — an agent loop would retry pointlessly or report a false regression. Correction: verify exit codes — 0 pass; 1 case-failed (step fail); 2 infra/aborted (message: fix environment, re-run); document in playbook.

### F5 (Low) — `env list --reveal` masking boundary lives server-side, not CLI-side

Verified: env PUT/GET mask secrets (`secret` flag, masked responses) — the server never returns plaintext after write. So `--reveal` cannot work as specified against the current API without a new server route. Correction: drop `--reveal` from phase 1 (masked only, honest); if plaintext read is genuinely needed later, it's a server feature with its own review. Keep `--secret` on set.

### F6 (Low) — `pnpm --filter cli link --global` as the PATH mechanism: verify pnpm 10/11 global-bin permissions on macOS at Stage 0

pnpm's global bin dir must be on PATH (often `~/Library/pnpm`), and `link --global` behavior changed across pnpm majors (this repo pins pnpm 10+/11 allowBuilds). Stage 0 acceptance should VERIFY the linked command resolves from `~` and print the resolved path; fallback documented: `pnpm --filter cli build && npm i -g .`-style or a shell alias in setup.sh. Not a design flaw — an install-mechanism verification step.

## Human questions

None blocking — all corrections are mechanical within the approved decisions.

## Required plan edits

1. Stage 1 auth: PAT prefix `lion_`, hook insertion point + ordering, coexistence tests with bot tokens (F1).
2. Stage 0: named harness mechanism — `buildApp` + `listen(0)` + env vars, shared module (F2).
3. `stack` edge section: pidfile reconciliation vs live listeners; foreign-listener policy (F3).
4. `case verify` exit-code table incl. infra=2 (F4); drop `--reveal` from phase 1 (F5).
5. Stage 0 acceptance: verify linked `lionidas` resolves from `~` + document fallback (F6).

## Inspected on paper vs. requires execution

Paper: auth hook structure + existing Bearer paths (read in full), buildApp/env seam, run status vocabulary, env masking contract, name uniqueness, pnpm workspace shape. Requires execution: the real listening harness, PAT↔bot coexistence under load of the hook, stack supervision against a live dev workflow, link-from-anywhere on this macOS setup, agent-loop drill end-to-end.
