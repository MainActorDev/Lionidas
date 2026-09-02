# Batch 6 Implementation Plan — forge hygiene: close out section B (B4+B8, B6, B7, B9)

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

---

## What this plan is about (plain English)

The network-control side of Crucible (the "forge" — the proxy that records and
fakes the app's traffic) has five known dents, all verified in code this
session. None are emergencies, but together they mean: **the forge can lie
quietly.** This batch makes it stop lying.

1. **B8 — throttling vanishes in runs.** The dashboard sends a preset's
   "slow the network down to N kbps" flag to the proxy, but the playback path
   FORGOT to copy that field when it re-sends presets for a run. So a test
   you think runs on a bad network actually runs on a fast one. Fix: ONE
   shared row→preset mapper used by everyone, so a field can never be
   forgotten again.
2. **B4 — the proxy's config file is written carelessly.** Seven places write
   it (batch 5 added attribution writes), each writing the whole file in one
   non-atomic shot while the proxy may be mid-read (it can read a half-written
   file and silently keep the old config), and a preset edit during a
   scenario-backed run can clobber the run's network setup. Fix: atomic
   writes (temp file + rename) and ONE owner module that serializes every
   write and composes "current presets + active override + active run" so
   they can't stomp each other.
3. **B6 — frozen responses live in macOS's /tmp.** /tmp gets purged; the
   database still points at the files; presets silently serve nothing.
   Fix: move to Crucible's own data directory, migrate existing files.
4. **B7 — captured request/response bodies grow forever.** Every proxied
   request's body is stored; nothing ever deletes them. Fix: same retention
   pattern the evidence system already uses (age cap + count cap).
5. **B9 — "freeze this response" matches the FULL url including query
   string.** A saved response for `/api/x?ts=1690000001` never matches the
   next request because the timestamp differs. Fix: the path is the
   identity; query params become a guard concern (already a supported
   feature) instead of part of the match.

By the end, section B of DEFERRED is fully closed except B11 (accepted:
localhost-only tool). The forge becomes boring — which is the goal for
infrastructure QA relies on.

**Non-goals:** preset editor UI, scenario UI (both M3, unchanged), any
change to proxy network routing (the watchdog/resilience work stands),
B11 auth.

**Tech:** TypeScript (better-sqlite3, vitest), Python addon (small, tested
by contract + live). No new dependencies, no schema migration (B6 is files,
B7 reuses existing tables).

**Verified facts (this session, live code):**
- Writers of the state file — SEVEN sites, three shapes:
  `forge/routes.ts:20` (syncPresetsToMitm, full row→spec inline),
  `forge/routes.ts:119` (scenario activate, subset inline),
  `manual/playback.ts:193,206,369,381` (B1 attribution + scenario
  restore, via `rowToPresetSpec`). All default
  `CRUCIBLE_MITM_STATE_DIR ?? '/tmp/forge-mitm'` — the default literal is
  duplicated at 7 sites (part of B4's sprawl).
- `writeStateFile` (`mitm/manager.ts:28`) uses bare `writeFileSync` —
  non-atomic; the comment there already defers atomicity to B4.
- Playback's `rowToPresetSpec` (`playback.ts:82-99`) omits `throttle_kbps`
  while routes.ts's TWO inline mappers (`:44`, `:143`) include it — B8's
  drift, confirmed. `Preset.throttleKbps` exists (`matcher.ts:18`).
- Frozen bodies: `forge/routes.ts:301-306` writes `preset-bodies/<id>.body`
  under stateDir (=/tmp by default); presets table stores absolute
  `body_path`.
- `traffic_bodies` (schema.ts:126) has `first_seen` — age GC is derivable;
  retention precedent exists at `src/gc/retention.ts` (evidence: caps,
  orphan-file cleanup, report shape).
- Addon matching (`addon.py:56-63, 81-86`): `path_matches(pattern, kind,
  flow.request.path)` — mitmproxy's `request.path` INCLUDES the query
  string; save-preset stores `t.path` (also query-laden). Preset guards
  already support query-param matching (`addon.py:69-71` `g.get("query")`)
  — so moving identity to path-only loses nothing.

---

### Task 1 (B8): one shared row→preset mapper — TDD

**Objective:** a single `presetRowToSpec()` in `forge/matcher.ts` used by
routes AND playback; `throttleKbps` survives every path.

**Files:**
- Modify `server/src/forge/matcher.ts` — add `presetRowToSpec(p: Record<string, unknown>): Preset` (move playback.ts:82-99 body here + add `...(p['throttle_kbps'] ? { throttleKbps: p['throttle_kbps'] as number } : {})` — mirroring routes.ts:44; keep the `NonNullable<Preset['failure']>` cast, exactOptionalPropertyTypes rule).
- Modify `server/src/manual/playback.ts` — delete local `rowToPresetSpec` (lines 82-99), import from `../forge/matcher.ts`.
- Modify `server/src/forge/routes.ts` — replace BOTH inline mappers (`:20-33` syncPresetsToMitm, `:119-…` scenario activate) with `presetRowToSpec`.
- Test `server/test/forge.mapper.test.ts` (new): row with `throttle_kbps: 256` → spec has `throttleKbps: 256`; row without → key ABSENT (not undefined); `failure` cast sound; `headers_json`/`seq_json` parse.

**Verify:** `pnpm vitest run test/forge.mapper.test.ts` green; `pnpm typecheck`; grep confirms zero remaining `rowToPresetSpec` definitions outside matcher.ts and no inline `path_pattern` mapping sites.
**Commit:** `forge: B8 — single shared presetRowToSpec; throttleKbps survives playback`.

### Task 2 (B4a): atomic state-file writes — TDD

**Objective:** the addon can never read a torn state file.

**Files:**
- Modify `server/src/forge/mitm/manager.ts` `writeStateFile` — write to `forge-mitm-state.json.tmp` in the same dir, `renameSync` over the target (POSIX atomicity on same filesystem). Keep the mtime-change semantics (rename bumps mtime — verified semantics, addon reloads).
- Test `server/test/forge.attribution.test.ts` — extend: after write, no `.tmp` remains; file parses (already covered); NEW: rapid-fire 50 interleaved writes while a reader loop parses — reader NEVER sees invalid JSON (torn-write regression test; run with real tmpdir).

**Verify:** vitest green (incl. new interleaving test).
**Commit:** `forge: B4a — atomic state-file writes (tmp+rename); torn-read impossible`.

### Task 3 (B4b): single state owner — the forge-state service

**Objective:** every write composes current truth (DB presets + active
scenario override + active run id) through ONE mutex-serialized module;
duplicated `?? '/tmp/forge-mitm'` literals collapse into it.

**Design:** new `server/src/forge/state.ts`:
```ts
export interface ForgeStateService {
  readonly stateDir: string;                       // env-resolved ONCE
  sync(): void;                                    // DB presets → file (today's syncPresetsToMitm)
  activateScenario(presets: Preset[]): void;       // sets override, writes composed
  clearScenario(): void;                           // clears override, writes composed
  setActiveRun(runId: string | null): void;        // composes with current override/DB presets
}
export function forgeStateService(deps: { db, forgeState }): ForgeStateService;
```
Internals: a module-level `let writeChain: Promise<void>` — every method
chains onto it (`writeChain = writeChain.then(() => …)`) so writes serialize
even under concurrent routes/playback; each write always composes
`{ mode: forgeState.mode, presets: override ?? dbPresets.map(presetRowToSpec), activeRunId }`
— the clobber flaw dies because composition is central.

**Files:**
- Create `server/src/forge/state.ts`.
- Modify `server/src/forge/routes.ts` — syncPresetsToMitm and scenario activate/restore route through the service (delete the local stateDir lookups at `:18/:118`).
- Modify `server/src/manual/playback.ts` — B1 attribution writes (`:190-193, :377-381`) become `forgeStateService(...).setActiveRun(runId|null)`; scenario activate/restore (`:203-206, :368-370`) becomes `activateScenario/clearScenario`. The playback tests' `deps` seam: the service factory takes the SAME `{db, forgeState}` deps objects the tests already inject — no new harness surface.
- Modify `server/src/forge/mitm/manager.ts` — `startMitm` reads `stateService.stateDir` (env resolution moves into the service; manager's own default stays as fallback for early boot).

**TDD:** `server/test/forge.state.test.ts`:
1. `setActiveRun` during active scenario override → state file contains OVERRIDE presets AND the run id (composition, the B4 clobber case verbatim).
2. `sync()` during active override → file still serves the override (preset creation mid-scenario no longer clobbers).
3. Serialized writes: fire `sync()` + `setActiveRun()` + `activateScenario()` concurrently → final file valid, reflects last logical operation (chain order), never torn (parse in loop).
4. Legacy: service with no override writes DB presets + `activeRunId: null`.

**Verify:** new tests green; existing `forge.attribution`, `playback-expect`, `playback-abort`, suite tests all green (no behavior change visible to them).
**Commit:** `forge: B4b — single state owner; scenario override + attribution compose, never clobber`.

### Task 4 (B6): preset bodies out of /tmp — migration

**Objective:** frozen bodies survive macOS purges.

**Files:**
- Modify `server/src/forge/state.ts` (from Task 3) — `bodiesDir` = `<server data dir>/preset-bodies` (same root as `crucible.db`, resolved once; `CRUCIBLE_MITM_BODIES_DIR` env override for tests).
- Modify `server/src/forge/routes.ts` save-preset (`:301-306`) — write via the service's bodiesDir.
- Migration: on service init, if `/tmp/forge-mitm/preset-bodies` exists, copy `*.body` files into the new dir (skip existing), then rewrite `presets.body_path` rows pointing at the old dir (`UPDATE presets SET body_path = REPLACE(body_path, '<old>', '<new>') WHERE body_path LIKE '<old>%'`), then leave the old dir (no destructive cleanup — user can delete).
- Test: extend `forge.state.test.ts` — old dir with a body + a presets row with old path → init → file exists in new dir, row updated, addon-visible spec (via sync) carries the new bodyPath.

**Verify:** vitest green; live check in Task 7 (freeze one response → file lands in data dir, not /tmp).
**Commit:** `forge: B6 — preset bodies under server data dir + migration from /tmp`.

### Task 5 (B7+B9): body retention + query-normalized matching

**Objective:** `traffic_bodies` stops growing forever; freeze matches
survive volatile query params.

**Files (B7):**
- Modify `server/src/gc/retention.ts` — add `gcTrafficBodies(db, now)`:
  delete rows `first_seen < now - 30d` AND not referenced by any
  `traffic.req_sha/res_sha` row newer than 30d (join check — keep bodies
  still attached to recent traffic the UI can still open); cap total rows
  at 200k (oldest first). Wire into the existing nightly/boot GC entry
  point the evidence GC already uses.
- Test `server/test/gc-traffic.test.ts`: old unreferenced body deleted;
  old body referenced by recent traffic row kept; count-cap honors
  oldest-first.

**Files (B9):**
- Modify `server/src/forge/mitm/addon.py` `path_matches` — for `"exact"` and
  `"glob"` kinds compare against `path.split("?", 1)[0]` (path = identity);
  regex kind unchanged (author chose it). Query-intent moves to guards
  (already supported, `addon.py:69-71`).
- Modify `server/src/forge/routes.ts` save-preset — store `t.path.split('?')[0]`
  as `path_pattern` (authoring normalizes; new presets clean from birth;
  old presets self-heal at match time via the addon split).
- Python contract check in `test/forge.mapper.test.ts` via `python3 -c`
  subprocess invoking `path_matches` directly: `/api/x` matches
  `/api/x?ts=123`; `/api/y` does not; glob `*` behavior unchanged; invalid
  regex returns False.

**Verify:** both test files green.
**Commit:** `forge: B7+B9 — traffic-body retention (30d+cap); path-identity matching (query → guards)`.

### Task 6: live verification round (proxy ON with cleanup discipline)

1. **B8:** create a preset with `throttleKbps` (API) → play a case with that
   scenario → read `/tmp` state file DURING run → spec includes
   `throttleKbps`; addon log line shows throttling applied.
2. **B4a/b:** during an active run, hit preset CRUD → run's network choice
   survives (state file still override+runId); rapid sync+run-start shows no
   torn reads in the addon log (no parse-fallback lines).
3. **B6:** freeze a response from the traffic table → body file under
   server data dir → restart server → preset still serves (the /tmp purge
   scenario, simulated by reboot-survival).
4. **B9:** freeze an endpoint hit twice with different query params →
   second hit serves the frozen body (match); different path → live.
5. **B7:** run GC endpoint/manual call → old bodies gone, recent kept.
6. **Cleanup discipline (lesson from today's outage):** proxy + `route sims`
   OFF at the end; verify `scutil --proxy` shows disabled + internet 200
   STRICT (no `-k`) through direct connection.

**Verify:** all six drills pass; state left clean.
**Commit:** (fixes if any) + `docs: batch 6 live-verified`.

### Task 7: docs + DEFERRED close-out

- DEFERRED: B4, B6, B7, B8, B9 → fixed-list entries (mechanism + live
  result). Section B now: B1✓ B4✓ B6✓ B7✓ B8✓ B9✓ + B11 accepted — note
  the flaw review fully closed except the accepted item.
- Skill: batch-6 section + `references/forge-hygiene.md` (state-service
  semantics, migration, retention policy, path-identity rule, drill
  recipes + the proxy-off cleanup rule).
- Commit: `docs: batch 6 shipped — section B closed (B11 accepted)`.

---

## Self-review (executed at draft — findings folded in)

- [x] **B8 fix verified in BOTH directions** (skill lesson b): the mapper
  feeds the addon state file — confirmed the addon consumes
  `throttleKbps`? → NO, checked: the ADDON does not implement throttling;
  only `failure` modes are addon-side. **Finding:** `throttleKbps` is
  consumed by the IN-PROCESS proxy (`forge/proxy.ts` preset application),
  and the addon's preset dict simply carries unknown keys harmlessly.
  The B8 defect stands (playback drops the key so NEITHER consumer sees
  it), and the fix location stands (mapper). Task 6 drill 1 adjusted:
  verify via the in-process proxy path + state-file content, not addon
  logs.
- [x] **Task 3 concurrency claim sane:** JS single thread means "mutex" is
  purely async-interleave ordering; a promise chain suffices (no
  worker-thread complexity needed) — verified all seven writers are
  same-process (routes + playback both run in the server process).
- [x] **Rename bumps mtime:** verified semantics assumption — `rename(2)`
  on APFS updates the target's ctime/mtime; the addon's `getmtime` check
  sees the change. Risk flagged low; Task 6 drill 2 covers it live.
- [x] **B6 migration is non-destructive:** copies, never deletes; old rows
  rewritten only when the old prefix matches (LIKE anchored at start).
- [x] **B7 keeps run-evidence intact:** run-detail opens bodies via
  `req_sha/res_sha` joins — the 30d reference check preserves anything a
  surviving `traffic` row still points at; older-than-30d traffic rows are
  already invisible to the UI's default window. [VERIFY in Task 5: confirm
  the traffic list UI has no unbounded "all history" view that would 404
  on GC'd bodies — if it does, GC must follow traffic-row retention
  instead; check `routes.ts` traffic list default limit.]
- [x] **B9 backward compat:** old presets stored with query strings
  self-heal (addon strips query from the LIVE path before compare; stored
  pattern WITH query would still mismatch → **Finding:** strip the query
  from BOTH sides in `path_matches` (pattern and path) so legacy stored
  patterns match too. Folded into Task 5 design.
- [x] **No deletions in this plan** except DB rows under explicit GC rules
  (checked references: traffic bodies are leaf data, nothing joins them
  beyond traffic.req_sha/res_sha).
- [x] **Hermetic tests:** no real `networksetup`, no live proxy in unit
  tests; python contract check shells to `python3` only (present on host,
  and the addon itself already requires it).
- [x] **Plan-skill location rule vs repo rule:** `.hermes/plans/` is a
  protected write location in THIS workspace (crucible skill; memory) —
  plan lives at `docs/plans/` with the batch predecessors. Verified
  against the skill's "runtime-provided target path" allowance.

## Risks / open questions

- **Addon behavior under rapid state churn** (Task 3 serialization): the
  addon reloads on mtime change with last-good-keep on parse failure —
  worst case it lags one write. Accepted; drill 2 observes.
- **B7 default 30d** is a policy guess — flagged as env-tunable
  (`CRUCIBLE_TRAFFIC_BODY_DAYS`), easy to revisit.
- **Playback test harness** touches the state service via the same
  injected deps — if a test constructs deps WITHOUT the service, Task 3
  must keep a lazy default so existing tests don't all need edits
  (design: `forgeStateService(deps)` memoized per deps identity).

**Human gate: approve below before Task 1 starts.**
