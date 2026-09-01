# Batch 5 Implementation Plan — the spine: suite home + traffic attribution (B1) + engine self-heal

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

---

## What this plan is about (plain English)

Crucible today is a **toolbox with no front door**. Open it and you land on the
devices wall — an infrastructure view — while the person opening it (QA, first
thing in the morning) is asking one question: **"is the app OK?"** Every piece
needed to answer that question now exists (cases with assertions, verdicts,
trends, plans — batches 3+4), but the answer is scattered across three pages.

This plan builds the missing spine, plus the two loose ends that make the spine
trustworthy:

1. **Suite home** — the new landing page: the whole test suite's health in one
   glance (verdicts, trends, red/blocked first), with "run the suite" one click
   away. Devices stop being the front door; nothing is lost, it moves one click
   deeper.
2. **B1 — traffic attribution (the last P0)** — today the run-detail "network"
   tab is always empty because the mitm addon never learns which run is active.
   With this, every run's HTTP traffic lands on its run row automatically:
   QA sees exactly which endpoints a failed case talked to, per run. That
   completes the evidence story (video + screenshots + steps + NOW network).
3. **Engine self-heal** — the two recurring engine failures (stream
   `fetch failed`, `Session "alloy" already bound`) currently require killing
   and restarting the Crucible server by hand. This adds automatic detection
   + recovery, so the tool stops needing its operator babysat.

By the end: open Crucible → see suite health → run the suite → click a red
case → step evidence INCLUDING its network traffic → fix or report. One
continuous journey — the thing that was missing when this thread started.

**Non-goals:** scheduled/cron runs (nice-to-have, separate), test-case
coverage maps (needs a grouping concept beyond tags first), any Jira
re-integration, multi-suite support (one suite per install, for now).

**Tech:** TypeScript, better-sqlite3, vitest, Vue 3, Python addon (6 lines
changed). No new dependencies, no schema migration.

**Verified integration points (live code, this session):**
- `web/src/router.ts:16` — `'/'` currently routes to WallPage; swap target to the new SuiteHomePage (route stays `/`, deep links unaffected; devices move to `/devices` — NEW route path, sidebar link update).
- `server/src/db/suite.ts` — `suiteVerdicts(db)` already returns per-case verdict+trend; home reuses it verbatim (no new query for the board's core).
- `server/src/forge/proxy.ts:58-59` — the in-process proxy ALREADY stamps `state.activeRunId` into traffic rows; **only the addon path is dead** (`addon.py:208` hardcodes `"run_id": None`).
- `addon.py:30-48` — addon tails `forge-mitm-state.json` on mtime and reads `mode` + `presets`; adding `activeRunId` to that file is the zero-new-transport fix (B1's sketch confirmed against code).
- `writeStateFile (manager.ts:28)` — writes `{mode, presets, hash}`; gains `activeRunId` field. Playback already sets/clears `forgeState.activeRunId` around runs (`playback.ts:184,360`) — the sync seam is one call.
- `server/src/alloy/client.ts:23-29` — module-level `cached` + existing `__setAlloyForTest` prove the reset seam: clearing `cached` forces full re-require (fresh engine-B client → fresh tool-server).
- `routes/devices.ts:70` — stream route 503s on engine error: the self-heal hook point (signature match + one retry after re-init).

---

### Task 1: B1 — activeRunId flows to the addon (TDD)

**Objective:** run-scoped traffic rows in the ndjson the addon writes; the
run-detail network tab comes alive with zero UI changes.

**Files:**
- Modify `server/src/forge/mitm/manager.ts` — `writeStateFile(stateDir, mode, presets, activeRunId?)` adds `"activeRunId"` to the JSON payload. ALL existing call sites updated (grep: routes sync, scenario activate, playback restore).
- Modify `server/src/forge/mitm/addon.py` — `reload_if_changed` also reads `self.active_run_id = data.get("activeRunId")`; row at line ~208 writes `"run_id": self.state.active_run_id`.
- Modify `server/src/manual/playback.ts` — after setting `deps.forgeState.activeRunId = runId` (line 184), ALSO `writeStateFile(stateDir, mode, presets, runId)` (find stateDir the same way the scenario-activate path does); clear with `null` in the finally (line ~360, next to the existing restore write).

**TDD:** `test/forge.attribution.test.ts` — fake addon behavior in TS is not possible (Python), so test BOTH ends we own: (a) `writeStateFile` output JSON contains `activeRunId` when passed / omits-or-nulls when cleared; (b) end-to-end: with mitm running, play a template that makes one HTTP call → poll `/api/forge/traffic?runId=<runId>` → row arrives with that run_id. (b) is the live gate, run in Task 6.

**Verify:** unit green; live drill in Task 6 proves (b).
**Commit:** `forge: B1 — activeRunId reaches the addon; run-scoped traffic`.

### Task 2: B1 — UI surfaces what it already queries

**Objective:** nothing new server-side; the run-detail traffic tab (which
queries `?runId=` today and gets nothing) starts showing rows — verify only.

- RunDetailPage traffic section: confirm it renders rows once attributed (it was built for this in M2); if it hides the tab when empty, keep the empty-state text honest: "no traffic captured — was the proxy running?"
- Add a one-line hint when run has zero traffic AND proxy is down: link to network page (the self-teaching rule).

**Verify:** manual + live drill. **Commit (if touched):** `ui/runs: traffic tab alive under B1`.

### Task 3: engine self-heal — detect + re-init + retry

**Objective:** the two known engine-staleness signatures stop requiring a
server restart.

**Design:**
- `server/src/alloy/client.ts` gains `resetEngineCache(): void` (clears `cached`; NOT exported to tests-only — it's the production seam).
- New `server/src/alloy/heal.ts`: `withEngineHeal<T>(fn: () => Promise<T>): Promise<T>` — catches errors whose message matches `/fetch failed|already bound|ECONNREFUSED|COMMAND_FAILED/`, calls `resetEngineCache()`, waits 250ms, retries ONCE; second failure propagates unchanged (honesty: we heal known staleness, not unknown breakage).
- Wrap the stream route's `alloy_stream` dispatch (`routes/devices.ts:67`) and playback's `alloy_apps` open (`playback.ts` outer try) with `withEngineHeal`.
- Log every heal at warn level with the triggering signature — silent recovery is a lie when it papers over a real problem.

**TDD:** `test/engine-heal.test.ts` — fake alloy: first call rejects with `fetch failed`, `resetEngineCache` called (spy via `__setAlloyForTest` re-registration), second call succeeds → result returned, warn logged; unknown error (`boom`) → propagates, NO retry; second failure → propagates.

**Verify:** unit green. **Commit:** `alloy: engine self-heal — stale client detection, single retry, logged`.

### Task 4: suite home page

**Objective:** `/` answers "is the app OK?" in one screen.

**Files:**
- Create `web/src/pages/SuiteHomePage.vue` — reuses the SAME data sources as TemplatesPage (`/api/templates` with verdicts, `/api/plans`) but a DIFFERENT layout:
  - **Header:** `suite health` + stat summary (recomputed: cases, ✓/✕/◆/◌ counts) + `▶ run suite` (plays ALL cases via play-all) + plan chips (reuse plan-bar logic — extract shared composable `web/src/composables/suite.ts` so both pages share load/run logic, no duplication).
  - **Attention first:** failed and blocked cases at top (sorted red > blocked > never-run > green, then by last-run age).
  - **Board rows** = compact case cards: name, verdict pill, trend, last run time, app+build; click → run detail of the last run (or the case editor if never run).
  - **Empty state** (no cases): the authoring journey hint, verbatim from TemplatesPage empty state.
  - Live updates: subscribe to `run.finished` via the existing live-events store — verdicts refresh without reload (RunsPage pattern).
- Modify `web/src/router.ts` — `/` → SuiteHomePage (title `suite`); ADD `/devices` route for WallPage (sidebar link updated in App.vue; existing `/?watch=<udid>` deep links keep working — they resolve on the wall page, now at `/devices`; ⌘K palette updated to push `/devices`).
- WallPage: no changes beyond living at `/devices`.

**Verify:** vue-tsc; Playwright pass — `/` shows board with real data, attention ordering correct, run-suite button works, watch deep-link still lands on the wall. **Commit:** `ui: suite home — health board as front door; devices moves to /devices`.

### Task 5: guide — the journey documented

- GuidePage: new first section `your day` (group: basics) — the three-paragraph version of the journey: morning check (home board), authoring (devices → record → assert → save), investigating (run detail: steps + evidence + NOW network traffic). Rename `quick start` content if redundant.
- Sidebar order: suite home is `/` — ensure nav shows `suite` first under TESTING, devices second.

**Verify:** guide renders new section. **Commit:** `docs(ui): guide gains the-day section; nav ordering`.

### Task 6: live verification round

1. **B1 money test:** mitm running + sims routed → play a case that hits the LP API → run detail network tab shows rows attributed to THAT run; a second run's traffic lands separately.
2. **No-proxy honesty:** run with proxy down → tab shows the honest empty-state with the network-page hint.
3. **Self-heal — stream:** kill the tool-server process (`pkill -f tool-server.cjs`) → request watch → first attempt heals (warn in server log), stream URL resolves WITHOUT server restart.
4. **Self-heal — session bound:** hold the alloy session (play on device A), request on device B → heal retries once → if still bound, honest error (unchanged semantics, but now logged as heal-attempted).
5. **Home board:** fresh server → `/` shows the real suite state; attention order correct; run-suite from home works; verdicts update live after a run finishes.
6. **Deep links:** `/?watch=<udid>` still reaches the wall; ⌘K devices entry works.
7. Cleanup: verification runs/cases removed; sessions closed.

### Task 7: docs + DEFERRED close-out

- DEFERRED: B1 removed to fixed-list (activeRunId in state file, addon stamps rows, run tab live). Engine self-heal noted (signatures list + single-retry honesty).
- Skill: batch-5 section + `references/suite-home.md` (home semantics, attention ordering, heal signatures, B1 mechanism diagram: playback → writeStateFile → addon mtime-tail → row.run_id).
- Commit: `docs: batch 5 shipped — the spine (home + B1 + self-heal)`.

---

## Self-review (executed at draft — findings folded in)

- [x] **B1 mechanism verified against BOTH ends** (lesson b): addon
  `reload_if_changed` reads the state file every mtime change (addon.py:30-48
  confirmed) — adding a field is transport-complete; proxy.ts already stamps
  `activeRunId` on ITS rows (line 58) so in-process + addon paths will AGREE.
- [x] **Home reuses `suiteVerdicts` verbatim** — no parallel verdict query to
  drift (B8's lesson about duplicated mappers).
- [x] **Route swap preserves deep links:** `/?watch=` params live on the WALL
  page — moving it to `/devices` and keeping query-param handling means old
  links still work IF we also keep a redirect: **correction** — old
  `/?watch=x` links would land on home with an ignored param. Mitigation:
  SuiteHomePage mounts, sees `watch` param, forwards to `/devices?watch=x`
  (3 lines, documented).
- [x] **Self-heal retried ONCE, signatures enumerable, always logged** — no
  infinite retry loops papering over hard failures; unknown errors untouched.
- [x] **`resetEngineCache` does not fight `__setAlloyForTest`** — test
  override wins (checked first in `crucibleAlloy()`), reset only clears the
  real cache.
- [x] **writeStateFile call sites enumerated** (grep: routes.ts sync ~20/~119,
  playback restore ~356) — all updated in Task 1, none left writing the old
  shape (two-shape drift is exactly flaw B4's disease; we don't add a third).
- [x] Empty-suite home is the authoring journey (a front door that dead-ends
  on "no data" is worse than the wall).
- [x] Attention ordering is a SORT, not a filter — green cases stay visible
  (the board must show the whole suite's shape, not just problems).

## Risks / open questions

- **Addon write amplification:** playback now writes the state file at run
  start + end. Two extra small writes per run — negligible vs the addon's
  mtime-tail cost. Non-issue, noted for completeness.
- **Race: run ends while addon mid-request** — last request(s) of a run may
  attribute to null run_id (cleared before response). Accepted: attribution
  window = run wall-clock, off-by-one-request is honest enough; the in-process
  proxy has the same boundary today.
- **Home + plans duplication** — mitigated by the shared composable; if plans
  grow settings, home shows run buttons only (no plan management on the front
  door).
- **`/devices` is a new public path** — internal tool, no external links;
  ⌘K + sidebar updated same commit.

**Human gate: approve below before Task 1 starts.**
