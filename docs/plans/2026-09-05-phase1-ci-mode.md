# Phase 1 — CI Mode: `crucible` CLI, exit codes, JUnit XML

> **For Hermes:** TDD; commit per task; live drill at the end (exit code from a
> real pass AND a real fail). Decisions pre-made with user (2026-09-05):
> (1) CLI talks to the running server — no second execution path;
> (2) JUnit `<testcase>` per template run, failure embeds step + reason;
> (3) device = explicit `--udid` or `--boot` flag — never auto-pick.

## Design

**Entry point:** `bin/crucible.mjs` (thin) → `server/src/cli/index.ts` (logic).
Package.json gains `"bin": { "crucible": "bin/crucible.mjs" }` (repo-local bin;
npm -g install comes later, not this phase).

```
crucible run [--tags smoke] [--app <bundle>] [--udid <udid> | --boot <udid>]
             [--env KEY=VAL ...] [--scenario <id>] [--triggered-by ci]
             [--junit <path>] [--json] [--timeout <sec>]
```

**Execution = the existing API, nothing new server-side for the happy path:**
1. `--boot <udid>` → `POST /api/devices/:udid/power {action:'boot'}` first
   (explicit only; auto-pick rejected by design).
2. Suite = `POST /api/templates/play-all` (already runs sequentially, returns
   `runIds`, handles DEVICE_BUSY/APP_NOT_INSTALLED honestly — verified in
   `manual.ts:289-345`).
3. Poll `GET /api/runs?template=...` until every runId reaches a terminal
   status (passed/failed/aborted) — the WS bus is for the wall; CI wants
   dead-simple HTTP polling (1s cadence, `--timeout` cap, default 15 min).
4. Verdict: **exit 0** iff every run `passed`; exit 1 if any failed; exit 2 =
   infra abort (DEVICE_BUSY, stream gate, timeout) — reviewers must be able
   to distinguish "app broken" from "harness broken" in the exit code alone.
5. `--json` prints a run summary array; default prints a human table.

**JUnit XML** (`--junit path`): one `<testsuite>` = the invocation,
`<testcase name="<template name>" classname="crucible.<templateId>">` per run;
`<failure message="<failing step reason>">` body = failed step idx/name/reason
+ run note (alert-handled lines!) + evidence path (the retained screenshot) +
run URL `http://<host>/runs/<id>`. Skipped/aborted → `<skipped/>`. Properties:
git SHA/env if provided via `--property k=v`. Time attrs from started/finished.

**Env/config:** `CRUCIBLE_URL` (default `http://127.0.0.1:9230`) — the CLI is
environment-shaped from day one (CI sets URL + udid; nothing hardcoded).

**No server required for XML:** the CLI is a *client*. The server must be
running (started by dev.sh or CI's own service step). This is the decided
architecture: one execution path, the wall stays source of truth.

## Self-review findings (verified live, folded in)

1. **[dissolves most of Task 4]** `GET /api/runs/:id` exists and returns the
   run row (200, `{run}`) — but NO steps. Steps live in
   `/api/runs/:id/steps/:idx/triage` only (per-run-row UI). Task 4 shrinks
   to adding `GET /api/runs/:id/steps` (plain SELECT of run_steps ordered by
   idx — verified the table shape: idx/name/status/reason are all there).
2. **[edge 4 resolved]** `--boot` on a booted sim: raw `simctl boot` errors
   (code 405 "Unable to boot device in current state"), BUT the power route
   returns `{ok:true}` anyway — the engine's boot path already treats
   already-booted as success. CLI needs nothing special; edge 4 documented
   as verified-true.
3. **[note field confirmed]** run rows carry `note` (alert-handled audit
   lines, video-unavailable notes) — the JUnit failure body gets it for
   free via the existing runs endpoint.
4. **[polling shape]** `/api/runs?template=<id>` filter exists (verified in
   runs.ts:72-84) — but poll by explicit runId list instead: fetch
   `/api/runs?limit=200` once per tick and match ids (one request per tick,
   no N+1 per run).

## Tasks

### Task 1 — run-status poller + exit-code mapper (pure)
Files: `server/src/cli/runner.ts` + `server/test/cli-runner.test.ts`.
1. `awaitRuns(url, runIds, {timeoutMs, pollMs})` → poll loop, abort-aware,
   returns `Array<{runId, status, note, steps?}>` (steps only for failures).
2. `mapExitCode(runs, infraError?)` → 0 | 1 | 2. Unit tests: all-pass → 0;
   any failed → 1; aborted/timeout/busy → 2; empty batch error → 2.
3. Poll against a stubbed fetch (no server in unit tests).

### Task 2 — JUnit XML emitter (pure)
Files: `server/src/cli/junit.ts` + `server/test/cli-junit.test.ts`.
1. `junitXml({suiteName, runs, properties})` → string. XML-escape everything
   user-controlled (template names carry spaces/quotes; reasons carry JSON).
2. Tests: pass-only has no failure nodes; failure embeds step reason + note +
   evidence + URL; skipped for aborted; escaped `<>&"'`; valid XML parses
   back (use a regex-free structural check — no xml parser dep; compare
   against expected string).

### Task 3 — CLI wiring
Files: `bin/crucible.mjs`, `server/src/cli/index.ts`, package.json bin.
1. Arg parsing by hand (no dep — the flag set is small and frozen): tags,
   app, udid, boot, env (repeatable), scenario, triggered-by, junit, json,
   timeout, property (repeatable).
2. Flow: boot (if flagged) → play-all → awaitRuns → print → junit → exit.
3. Human output mirrors the wall's verdict language (passed/failed/blocked).
4. `crucible --help` renders usage (tested via exec snapshot).

### Task 4 — failure-detail fetch
Files: extend `server/src/cli/runner.ts`.
1. For failed runs, `GET /api/runs/:id` already returns steps? VERIFY — if
   steps live only in `/steps/:idx/triage`, add `GET /api/runs/:id/steps`
   (trivial SELECT, no logic) so the CLI has one obvious endpoint.
2. Emitter consumes: first failed step (idx, name, reason), run note.

### Task 5 — live drill + CI recipe
1. Boot sim via CLI flag; run the privacy case with `--junit /tmp/out.xml`:
   expect exit 0, valid XML, `<testcase>` with the template name.
2. Break the case (bad expect fragment in YAML): expect exit 1, XML carries
   the failing step reason + the retained evidence path.
3. Kill the server mid-run: expect exit 2 (infra), not 1.
4. Write `docs/ci.md`: GitHub Actions snippet (macOS runner, boot sim, start
   dev stack, `crucible run --tags smoke --junit results.xml`) + exit-code
   contract table.

## Edge cases
| # | Case | Decision |
|---|---|---|
| 1 | play-all returns zero matching templates | exit 2 with clear message (empty suite is config error, not pass) |
| 2 | Run stuck non-terminal past timeout | exit 2; XML marks remaining runs skipped + timeout note |
| 3 | Mixed failed + aborted | exit 1 (app failure outranks infra for the same invocation); XML records both accurately |
| 4 | `--boot` on an already-booted sim | Power route is idempotent (simctl boot on booted → error swallowed by engine? VERIFY live; treat as ok if state already Booted) |
| 5 | JUnit path unwritable | exit 2 (infra), runs still reported to stdout |
| 6 | Server URL wrong | exit 2 fast with connection-refused message |
| 7 | Retention deleted evidence mid-drill | Evidence path in XML points at the CURRENT run's artifacts — no cross-run references |
| 8 | Unicode in template names | XML-escaped; tests include a non-ASCII name |

## Out of scope
Parallel device fan-out (Phase 3), HTML reporting, artifact upload (CI's own
step — we hand it paths), auth (localhost), `crucible record` (later),
non-server standalone mode (decided against).
