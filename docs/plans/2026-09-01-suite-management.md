# Batch 4 Implementation Plan — the management backbone (B2 + history/trends, plans, build anchoring, blocked verdicts, rename)

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

**Goal:** turn the verified test corpus into a managed suite with a trustworthy board:
runs can't wedge forever (B2, last P0), every test case shows its history and
trend, saved plans replay the suite in one click, runs anchor to an app build,
and infrastructure failures stop masquerading as app failures (blocked ≠ failed).
Plus the user-facing rename: "templates" → "test cases".

**Positioning context (2026-08-31 discussion):** TestRail has case lifecycle,
plans, trends, verdict honesty, coverage. Our structural win: case = executor =
evidence (one artifact). Batch 4 builds the management *bones* TestRail has,
on top of execution truth it never had. Explicitly NOT built: assignment,
milestones, manager reports (ceremony, poison for a local-first tool).

**Tech:** TypeScript, better-sqlite3 (guarded ALTERs only — no CHECK-constraint
table rebuilds), vitest, Vue 3. No new dependencies.

**Verified integration points (live code, this session):**
- `playback.ts:126-128` — runs INSERT stamps `note = 'template:<id> <name>'`; kind='manual'; NO template_id column, NO app-version stamping (grep confirmed). All runs rows: `SELECT *` served free via `/api/runs` (RunsPage reads id/status/started_at).
- `db/schema.ts:14` — runs.status CHECK `('queued','running','passed','failed','aborted')` → adding a 'blocked' STATUS means a table rebuild; instead blocked is a separate dimension (see Task 5 design note).
- `queue/store.ts:51` — device-busy logic already reads `runs.status IN ('queued','running')`; any new terminal status must not appear there.
- `routes/templates.ts` — play-all (`POST /api/templates/play-all`) takes `{tags, app, udid, scenarioId, env}`; selectTemplates filter is AND-semantics. Plans = remembered invocation of exactly this.
- `runs.ts:71-79` — list route: plain SELECT, supports `?ticket=`; template provenance only via note-parsing (fragile — Task 1 replaces).
- B5 guard (`playback.ts:117-123`) blocks on `status IN ('queued','running')` — abort must terminate runs out of those states or the device stays locked (Task 2 correctness core).
- A7 settle window uses env-injectable polling — the abort flag checks between steps (Task 2 rides the same loop seams).
- `manual/apps.ts listSimulatorApps` — returns `{bundleId, name, version}` — the app-version source for build anchoring.
- TemplatesPage/RunsPage/WallPage — no last-verdict, no trend, no plan UI anywhere yet (grep confirmed).
- Cross-device session binding: `agent-device close --session alloy` recovery is manual — Task 5 classifies its failure signature as blocked.

---

### Task 0 (folded into 1): schema — `runs.template_id`, `runs.app_version`, `runs.blocked`

Guarded ALTERs (mirror tags_json precedent):

```sql
ALTER TABLE runs ADD COLUMN template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN app_version TEXT;
ALTER TABLE runs ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
```

**Design note — why a `blocked` column, not a status value:** the status CHECK
constraint would need a table rebuild (SQLite can't ALTER a CHECK), and every
consumer (queue busy-logic, B5 guard, roll-ups, UI color maps) matches on the
existing five. A separate boolean keeps status=failed's semantics ("run did not
pass") while giving the honest dimension ("was it the app or the world?").
`blocked=1` ⇒ infrastructure failure (open failed, session binding, device
busy, engine errors); `blocked=0` ⇒ genuine app/test failure.

Playback stamps `template_id` at INSERT (replaces note-parsing; note stays for
display) and `app_version` at open time (from listSimulatorApps — best-effort
null). `blocked` set at failure classification (Task 5).

**Verify:** schema test — fresh db migrates; existing db idempotent. Commit:
`suite: runs carry template_id/app_version/blocked (guarded ALTERs)`.

---

### Task 1: per-case history + last verdict (server)

**Objective:** one query surface for "every case's latest verdict + recent
trend" and "one case's run history".

**Files:** Modify `server/src/routes/templates.ts` (list join), `server/src/routes/runs.ts` (`?template=` filter).

1. Templates list gains per-template last-run subquery:
   `last_run_id, last_status, last_blocked, last_finished_at, last_app_version`
   + trend = last 10 statuses string ('pppfp p' style, pass=p fail=f skip=s
   aborted=a, blocked rendered uppercase F).
2. `GET /api/runs?template=<id>` — history for one case (uses the new column,
   drops note-parsing).
3. TDD: `test/suite-history.test.ts` — seed templates + runs, assert join
   shape, trend string, blocked coloring input, empty case (no runs yet →
   `never run` state, NOT zero-filled).

**Verify:** vitest green + live: curl templates list shows last verdicts for
the A7-era runs (real data exists). Commit: `suite: last-verdict + trend on templates list, ?template= history`.

---

### Task 2: B2 — per-step watchdog + abort endpoint

**Objective:** a wedged run can no longer hold a device forever, and QA can
kill a stuck run from the UI.

**Design:**
- `AbortRegistry` (module map runId → {aborted: boolean}) in playback.ts.
- The exec loop checks `registry.isAborted(runId)` between steps → marks
  remaining steps skip 'aborted by operator', run status 'aborted', releases.
- **Per-step watchdog:** wrap each `alloy.dispatch` in `Promise.race` with a
  90s timer (env `CRUCIBLE_STEP_TIMEOUT_MS`) → on timeout mark step fail
  `step timeout after 90s`, run failed + blocked=1 (infra), continue to
  cleanup. The dispatch promise itself is un-cancellable (documented
  limitation — alloy has no abort), but the RUN record unblocks and the B5
  guard frees the device; a zombie dispatch process is the engine's problem.
- `POST /api/runs/:id/abort` → sets the flag; 404 unknown run; no-op (200
  `{already: 'finished'}`) if terminal — idempotent by design.
- In-flight expect settle-wait ALSO checks the abort flag each poll iteration.
- Queue runs (kind=automated) keep their existing abort path — this route is
  for manual/template runs; both marked aborted release the B5 guard.

**Files:** Modify `playback.ts` (registry + loop seams), `routes/runs.ts` (abort route).

**Verify (TDD):** `test/playback-abort.test.ts` — (a) abort mid-run between
steps → remaining skip, status aborted; (b) wedged-dispatch fake (never
resolves) + short timeout env → step fail timeout, run failed+blocked, done
resolves; (c) abort after finish → `{already}`. Live drill: start play with a
fake-wedge via a paused sim, abort from curl, device frees. Commit:
`suite: B2 closed — step watchdog + abort endpoint`.

---

### Task 3: plans — remembered suite invocations

**Objective:** "regression-rc1" as a saved object: tag filter + device + app +
scenario + env; one click replays it.

**Schema:** `plans(id TEXT PK, name TEXT UNIQUE NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', udid TEXT, app_bundle_id TEXT, scenario_id TEXT, env_json TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at INTEGER, updated_at INTEGER)` (guarded CREATE IF NOT EXISTS).

**Routes (CRUD + run):**
- `GET /api/plans` / `POST /api/plans` / `PATCH /api/plans/:id` / `DELETE /api/plans/:id`
  (name required; tags validated with the same trim/dedupe/max-8 normalizer).
- `POST /api/plans/:id/run` → resolves plan → invokes the SAME play-all code
  path (refactor play-all body into `runBatch(params)` shared by both routes —
  no parallel mechanism) → `{runIds, count}`. DEVICE_BUSY semantics inherited.

**UI (TemplatesPage header):** plan bar — existing plans as chips (`▶ regression-rc1`), `+ plan` saves the CURRENT filter+device+scenario+env as a named plan (prompt). Editing = PATCH from the chip's context menu; keep it minimal — no dedicated plan page.

**Verify:** TDD route test (create/validate/run-refactor delegation), live:
create plan from current tag filter, run it, watch sequential runs appear;
delete. Commit: `suite: plans — saved suite invocations (tag+device+app+scenario+env)`.

---

### Task 4: build anchoring

**Objective:** runs answer "what build was this against" and the suite view
groups by it — "what broke between 233 and 234".

- Playback already stamps `app_version` (Task 0/1). Templates list trend
  tooltip + RunsPage gain an app-version badge (`v<version>` or `unknown`).
- `GET /api/runs?app_version=` filter (index on `runs(app_version,
  started_at DESC)` — guarded CREATE INDEX IF NOT EXISTS).
- Run detail header shows build next to device.
- NOT built: build entity/registry — the version string from the installed
  bundle is the anchor. Trigger for more: multiple artifacts per bundle id.

**Verify:** live — two runs against differing builds (reinstall older int-dev
build if available, else spot-check null/unknown rendering is honest). Commit:
`suite: build anchoring — app_version on runs, filter + badges`.

---

### Task 5: blocked verdict classification + honest board

**Objective:** infrastructure failures render distinctly; the board stops
lying.

- Classification at playback failure sites — blocked=1 when the error message
  matches infra signatures: `open failed`, `Session "alloy" is already bound`,
  `device busy`, `DEVICE_BUSY`, `engine error`, step-timeout (Task 2), lease
  lost. One helper `classifyBlocked(reason): boolean` (pure, TDD'd with the
  real message strings harvested this week — the cross-device binding message
  verbatim included).
- UI: blocked runs render `◆` + amber in RunsPage + case trend; run detail
  shows `blocked — infrastructure, not an app failure` banner; last-verdict on
  templates list distinguishes them from red.
- The play-all batch abort (B5 DEVICE_BUSY mid-batch) marks the aborted run
  blocked=1.

**Verify:** TDD classifier; live — trigger the session-binding failure (play
on second device without release) → run renders blocked, not red. Commit:
`suite: blocked ≠ failed — infra-failure classification + honest rendering`.

---

### Task 6: rename + spine breadcrumbs (UI-only)

- User-facing chrome: sidebar `templates` → `test cases`, page title
  `test cases`, empty states, guide references. Routes/tables/API unchanged
  (`/templates` still serves — deep links survive; naming directive
  precedent from the wall→drive pass).
- Authoring-loop breadcrumb on the test-cases page header:
  `record → assert → save → replay → verdict` (static hint line linking each
  word to its surface: recorder = devices sidebar, assert = recorder assert
  box, save = save-as-template, replay = ▶, verdict = run detail) — the
  journey made visible without a wizard.
- RunsPage row shows case NAME (template_id join) — runs currently show
  nothing human.

**Verify:** vue-tsc + browser pass over renamed surfaces; grep no stale
"templates" in user-visible strings (code identifiers exempt). Commit:
`suite: "test cases" rename + authoring breadcrumb + case names on runs`.

---

### Task 7: live verification round

1. Fresh case run → last-verdict green on list, trend `p`.
2. Break it (bogus expect) → red verdict + trend updates; fix → green.
3. Wedge drill: play with stopped sim → step timeout fires, run failed+blocked,
   device freed (B5 guard accepts next run) — B2's money test.
4. Abort drill: start long case, POST abort mid-run → status aborted, steps
   skipped, device freed immediately.
5. Plan drill: save plan from filter, run plan → sequential runs; edit tags →
   next run honors.
6. Build badge drill: runs show app_version; filter by it.
7. Blocked drill: cross-device without session release → blocked verdict
   (not red) + recovery hint surfaced in run detail note.
8. Cleanup verification artifacts.

### Task 8: docs close-out

- DEFERRED: B2 removed to fixed-list (watchdog + abort); blocked≠failed noted
  as shipped; plans/build-anchoring noted; remaining backlog re-listed (B1,
  B4, B6-B9, B11 — now genuinely small).
- Skill: batch-4 section + `references/suite-management.md` (plan semantics,
  blocked signatures list, watchdog limits incl. un-cancellable dispatch
  honesty, rename map).
- Commit: `docs: batch 4 shipped — management backbone`.

---

## Self-review (executed at draft — findings folded in)

- [x] **Blocked-as-column, not status** — verified the CHECK constraint makes
  a status value a table rebuild; every consumer (queue.ts:51, B5 guard,
  roll-ups) matches on the five existing values; a 6th would need touching
  all of them for zero semantic gain over the boolean.
- [x] **Both ends of every link** (lesson b): template_id written by playback
  AND read by the templates-list join + runs filter (Task 1 names both);
  app_version written at open AND rendered in three places; abort flag set by
  route AND consumed at three loop seams (between steps, settle poll, batch).
- [x] **Factual re-checks** (lesson c): play-all body refactored not
  duplicated (Task 3); listSimulatorApps signature confirmed `{bundleId,
  name, version}`; queue abort path exists for automated runs — manual abort
  route is additive, no collision (`/api/runs/:id/abort` not taken).
- [x] **Trend string**: 10-run window, distinct glyphs p/f/s/a + uppercase for
  blocked — single source of truth in SQL concat, rendered as-is (no second
  derivation in JS).
- [x] **Never-run state explicit** (`never run`), never zero-fill — the
  loading-state honesty rule generalized to history.
- [x] **B2 honesty**: dispatch promises are un-cancellable — the plan says so
  and scopes the guarantee to run-record + device-release, not zombie
  processes. No pretending.
- [x] Plans don't grow a page/editor — chips + current-filter save only; the
  moment plans need managing, they've become TestRail milestones (rejected).
- [x] Rename touches strings only; route `/templates` serves forever (deep
  links); identifier churn = zero diff noise.

## Risks / open questions

- **Watchdog vs slow legitimate steps** (video encode, big settle): 90s
  default is generous; env-tunable. If real flows exceed it we raise, not
  special-case.
- **Trend window 10** — arbitrary; fine for v1, constant in one place.
- **Blocked signatures are string-matching** — honest limitation; harvested
  from this week's real failures; misses unknown infra modes = they render red
  (fail-safe direction: red is investigated, blocked is shrugged at — missing
  a blocked is safer than missing a red).
- app_version null for non-bundle runs (Settings fallback) — renders
  `unknown`, filters exclude on explicit value only.

**Human gate: approve below before Task 1 starts.**
