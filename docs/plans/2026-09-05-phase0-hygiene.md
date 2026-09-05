# Phase 0 — Foundation Hygiene (iOS-first, platform-prep)

> **For Hermes:** TDD where logic changes; each task is a small, verifiable
> commit. This phase has zero new features — it makes what exists trustworthy
> and refactorable, and every item is also a prerequisite for parallel suites
> and future platforms (per ADR-0001).
> **For the selector seam:** Task 4 creates the seam opportunistically —
> only if selector code must change for an iOS reason first; otherwise it
> stays a line in ADR-0001's table.

## Task 1 — SQLite durability: WAL + backup

**Files:** `server/src/db/schema.ts` (or db init site); test in
`server/test/db-wal.test.ts`.

1. Enable WAL + a sane synchronous mode at db open:
   `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`
   (better-sqlite3: `db.pragma('journal_mode = WAL')`.)
2. Daily backup: on server start + every 24h, `db.backup(path)` to
   `server/artifacts-backups/crucible-YYYYMMDD.db` (better-sqlite3's async
   backup API — safe under writes). Keep last 7.
3. Tests: WAL mode is active after migrate (pragma read); backup file
   appears and is a valid sqlite db with the expected tables.

## Task 2 — Quarantine the flaky trio

**Files:** the three tests; possibly a `test/flaky.md` registry note.

Known-flaky under parallel load, passing in isolation (documented across
sessions): `health.test.ts` (sharp native binding under vitest — see the
VITEST guard comment in index.ts), `sim-routing.test.ts` (dead-listener
probe timing), `stream.route.test.ts` (guard timing under load).

1. Diagnose each honestly: fix if cheap (e.g. fake timers for the listener
   probe; skip health's sharp path explicitly under VITEST).
2. If a fix is structural (sharp), mark the test `describe.skip` under
   `process.env.VITEST` when the cause is environmental — an explicit,
   commented skip beats a red-green lottery.
3. Success criterion: `vitest run` three times consecutively, zero flakes.

## Task 3 — Dedupe ingestEvidence

**Files:** new `server/src/evidence/ingest.ts`; `playback.ts` + `alloy/runner.ts`
import it; delete both local copies; tests move/stay green.

1. One implementation returning `{ id, path }` (the shape both callers now
   use after the per-expect work).
2. Both call sites verified: playback screenshot/video + runner
   screenshot/diff/video/logs all route through it.
3. The bundle_id discipline stays: callers pass runId (never 'manual' —
   that was a bug we already fixed once).

## Task 4 — Selector seam (opportunistic only)

Per ADR-0001: if selector code changes for an iOS reason during this phase,
land `resolveSelector(nodes, sel, { platform: 'ios' })` with current
behavior as the ios branch. Otherwise: no code. This task is a reminder,
not work.

## Task 5 — Split playback.ts (962 lines)

**Order matters** — extract leaf-ier concerns first, tests green after each:
1. `server/src/manual/dialog-policy.ts` — drainDialogs, AlertStormError,
   resolveAlertPolicy wiring, the cap/note collector (~150 lines out).
2. `server/src/manual/evidence-recorder.ts` — ingest + per-expect capture +
   video start/stop ladder + finally-fallback (~120 lines out).
3. `server/src/manual/tap-verify.ts` — sig-before/after, recentre audit,
   screenChanged, no-change warn (~100 lines out) if it detaches cleanly;
   otherwise leave with a documented boundary.
4. playback.ts keeps: run lifecycle, gate ordering, step loop skeleton.
   Target ≤ 600 lines, no behavior change — the 393-test suite is the net.

## Task 6 — Engine-response codec (start small)

**Files:** new `server/src/alloy/responses.ts`; tests `responses.test.ts`.

The 20 `as never/as unknown as` casts and the message-regex error
classification (`.includes('already active')`, `/active session device/i`)
live at the alloy seam. Start with just the three shapes playback cares
about, as narrow codecs:
1. `decodeSnapshotResult(r)` → `{ nodes: SnapNode[] } | null`
2. `decodeAlertResult(r)` → `{ present: true; message } | { present: false } | { error }` — encodes the probed contract (ok:true+message = present)
3. `decodeErrorClass(r)` → `'runner-busy' | 'alert-active' | 'already-recording' | 'fetch-failed' | 'other'` — replaces the regexes we added this week

No engine changes; callers migrate opportunistically (playback.ts during
Task 5's moves).

## Edge cases

| # | Case | Decision |
|---|---|---|
| 1 | Backup during active run | better-sqlite3 backup API is snapshot-safe under WAL |
| 2 | WAL files on crash | WAL is crash-safe by design; artifacts dir gains -wal/-shm (gitignore already covers artifacts) |
| 3 | Skipped health test under VITEST | Comment must point at the sharp-binding cause so it isn't read as coverage abandonment |
| 4 | Split changes hot paths | No behavior change permitted; any test edit = red flag |
| 5 | Task 5 ordering conflicts with Task 6 | Codec first where a module move would otherwise re-carry casts |

## Out of scope
CI mode (separate plan — Phase 1), parallel runner, any platform adapter,
UI component tests (Phase 1 alongside CI's headless push).
