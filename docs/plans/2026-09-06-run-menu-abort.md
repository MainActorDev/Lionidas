# Run menu (watch/background) + abort everywhere — 2026-09-06

Status: **SHIPPED + browser-drilled 2026-09-06** — commits:
`65e1d23` (server events, Task 0) · `3aba128` (tracker, Task 1) ·
`7e4acc1` (menu + abort + stop-all, Tasks 2-4) · guide rows (Task 5).
Date: 2026-09-06
Decisions (user, 2026-09-06 brainstorm): sticky-preference run menu (concept C);
single-click abort (no confirm); play-all gets `■ stop all` in this round.

## Plain English summary

Two abilities, one interlock:

1. **Run menu** — clicking ▶ runs the case either *watched* (the stream
   dock opens, today's behavior) or *in the background* (no dock; you
   still see the verdict appear in the row when it finishes). The last
   mode you used becomes the button's default, and the button LABEL
   always states its mode — `▶ run · watch` or `▶ run · background`.
2. **Abort** — while a case is running, its row button becomes a red
   `■ abort`; the run panel header gets the same `■ abort`. Both are
   single-click, both hit the existing idempotent abort endpoint, and
   both stay honest about latency: abort lands between steps (≤ one
   step + watchdog), not instantly. Play-all's status message gets
   `■ stop all`.

Server truth that shapes everything: the run-readiness gate proves the
stream live BEFORE steps on every run regardless (user contract
2026-09-03) — so "background" means *don't show me the viewer*, never
"skip the stream gate". The run is byte-identical either way; only the
frontend dock behavior changes.

## Verified code facts (read 2026-09-06, this session)

- `web/src/pages/TestCasesPage.vue:87` `play()` — ALWAYS sets
  `runPanel.value` on success (the coupling to remove).
- `RunPanel.vue` — props `{runId, templateId, caseName, udid}`;
  `status` ref tracks running/passed/failed/aborted; polls
  `/api/runs/:id` + steps; WS `run.finished` unlocks. No abort UI.
- `POST /api/runs/:id/abort` (`server/src/routes/runs.ts:94`) —
  idempotent (`{already:'finished'}` on terminal), calls
  `abortRun()` (playback.ts:167) which flips the record; dispatch
  promise un-cancellable by design (record+lease guarantee only).
- WS forward list already includes `run.aborted`, `run.finished`,
  `run.started`, `queue.changed` (events-ws.ts:31-56).
- `GET /api/runs?template=<id>` exists (runs.ts:78) — active-run
  discovery per template needs only a status filter client-side.
- Queue abort: `DELETE /api/queue/:id` (409 when already dispatched).
- `playing` ref only covers fetch-in-flight (~1s), NOT run lifetime —
  today's UI has no notion of "my case is running" beyond the dock.
- Play-all (`playAll()`, :214) has no stop; batch = queue rows +
  `runBatch` sequential runner.

## Tasks

### Task 0 — server: event payloads carry what the tracker needs (TDD)

Self-review verified (2026-09-06):
- `run.started` payload is `{runId, ticketKey, udid}` — **NO template_id**
  (playback.ts:314, alloy/runner.ts:88). Both emitters have the template
  in scope (`t` / spec) — add `templateId` to both payloads.
- `run.aborted` is emitted ONLY by the queue dispatcher with `{queueId}`
  (queue/dispatcher.ts:46) — a template-run abort via
  `POST /api/runs/:id/abort` emits **NOTHING** (route calls `abortRun()`
  which only flips the record). Emit `run.aborted` from the abort route
  (or inside `abortRun`) with `{runId, templateId}` so trackers/panels
  clear. Idempotent path (`already`) emits nothing.
- RunPanel handles ONLY `run.finished` (RunPanel.vue:120) — confirmed;
  the `run.aborted` listener is REQUIRED panel work, not a maybe.
Tests: playback/queue event tests assert the new payload fields; abort
route test asserts the emit + the no-emit-on-already case.

### Task 1 — active-run tracker composable (TDD, pure)

`web/src/composables/activeRuns.ts`:
- reactive `Map<templateId, {runId, startedAt}>` of RUNNING/QUEUED runs
- `init()`: fetch `GET /api/runs?status=running` once (+ queued), seed
  the map (covers page-refresh-mid-run and runs started elsewhere)
- subscribe `/api/events` WS: `run.started` (payload has template_id —
  VERIFY in Task 1 read; if absent, join via GET) → add;
  `run.finished`/`run.aborted` → remove; `queue.changed` refresh for
  queued entries
- `isRunning(templateId)`, `activeRun(templateId)` getters
- shared singleton (both the row and the panel use the SAME source —
  the interlock)

Tests: `web/src/composables/__tests__/activeRuns.test.ts` — seed from
fetch, add on run.started, remove on run.finished + run.aborted,
refresh on queue.changed, unknown-template events ignored.
⚠ vitest fake-WS harness: reuse the pattern from an existing events
consumer (RunPanel listens on `/api/events` — extract or mimic).

### Task 2 — run menu (sticky preference) on the row button (browser-verified)

`TestCasesPage.vue`:
- state: `runMode = ref<'watch' | 'background'>('watch')`, persisted
  `localStorage['crucible.runMode']` (read at setup, write on change)
- button: split shape — main `▶ run · watch` / `▶ run · background`
  (label = current mode) + a `▾` toggle that flips the sticky mode and
  shows both options with the active one marked (menu = the two
  options + their meaning in one line each; closes on pick/outside
  click; Escape closes)
- `play()` gains `mode: 'watch' | 'background'` param:
  - watch → today's behavior (dock opens)
  - background → NO dock; `playMsg` = `running · <runId> · background`
    (existing message slot); verdict column updates via existing
    trend/verdict refresh (VERIFY: page already refetches templates on
    `run.finished` — check the events wiring; if it doesn't, refetch on
    run.finished for the started template)
- DISABLED state: row button disabled while `playing` (fetch in
  flight) OR `isRunning(t.id)` — because Task 3 replaces it with abort
  anyway, the disabled+abort states are mutually exclusive by
  construction (abort button renders INSTEAD when running)

UI conventions: menu rides the shared `.btn`/`.chip` classes +
`.status-danger` red for abort (STANDARDIZATION RULE — no new dialect);
dropdown anchored under the button, `min-width` content-sized, no
fixed widths; keyboard: Enter/Space on ▾ toggles, arrows move, Escape
closes (same as ⌘K palette patterns).

Verification (Playwright, REAL clicks): click ▶ in watch → dock opens
(observe `.run-dock` mount); flip to background via ▾ → click ▶ → NO
dock (`.run-dock` absent), playMsg shows runId; reload page → sticky
mode survived (label still `· background`); verdict column flips to
the run's verdict after finish (poll until terminal).

### Task 3 — abort on the row + in the panel (browser-verified)

Row (`TestCasesPage.vue`):
- when `activeRun(t.id)` exists → render `■ abort` button
  (`btn-danger`, title "aborts after the current step finishes")
  INSTEAD of ▶ run
- click → `POST /api/runs/:runId/abort`; brief pending state on the
  button (`aborting…`, disabled) until the map clears it (WS event);
  on `{already:'finished'}` just let the tracker clear it (idempotent
  endpoint — no error toast needed)
- queued runs: the runId may not exist yet (queue row) — if
  `activeRun` carries a queueId variant, `DELETE /api/queue/:id`
  instead. VERIFY in Task 1: how queued template runs appear in
  `/api/runs` (they may be rows with status='queued' already — then
  the same abort endpoint path applies via abortRun? NO — queue-abort
  and run-abort are different endpoints; the composable must carry
  `{kind:'run'|'queue', id}` and the row button dispatches
  accordingly)

RunPanel header:
- `■ abort` button next to close while `status === 'running'`; same
  endpoint; on success the panel shows the aborted verdict through its
  EXISTING status flow (no new state machine — the WS `run.aborted`
  event already flips it; VERIFY RunPanel handles `run.aborted`
  payload, not just `run.finished` — if it only handles finished, add
  the aborted listener)
- abort from EITHER surface clears both (same tracker)

Tests: vitest where pure (dispatch-by-kind logic); browser drill for
the interlock: start watched run → row shows ■ abort → click abort in
PANEL → row's abort disappears + panel shows aborted verdict within
one poll tick; and the reverse direction (row abort → panel follows).

### Task 4 — play-all `■ stop all` (browser-verified)

- during `playingAll` (and only then), the batch status area renders
  `■ stop all` (btn-danger): POSTs abort for every active run in the
  tracker + `DELETE /api/queue/:id` for every queued entry, then
  `playingAll=false` optimistically (the WS events confirm)
- VERIFY: does `runBatch` stop on abort of the current run, or does it
  proceed to the next queued? (Read `queue/store.ts` + runner before
  implementing — B2 says first-failure skips rest for FAILURES; abort
  semantics may differ. If aborting the current run does NOT halt the
  batch, stop-all must abort each queued row explicitly — which it
  already does by iterating. The CURRENT run is the only one needing
  run-abort.)
- message: `stopped N run(s) · M queued` — honest counts from what
  was actually aborted

### Task 5 — guide + skill + plan closure

- Guide page ("test cases" section): run menu row (watch/background,
  sticky default), abort button, stop all — the "what each control
  does" meta-row style (GUIDE-SHIPS-WITH-FEATURE rule)
- crucible skill: append the round to SKILL.md (or a reference file if
  large) — interlock pattern (shared tracker), sticky-mode design,
  abort-latency honesty, the queued-vs-dispatched dispatch-by-kind
- this plan: status flip + commit map

## Edge-case table

| Case | Behavior |
|---|---|
| Page refreshed mid-run | tracker seeds from GET → abort shows, dock may be re-opened from verdict pill (existing) |
| Run started from another surface (curl, other tab) | tracker seeds/subscribes → abort visible in this tab |
| Abort clicked twice (two surfaces) | endpoint idempotent; second gets `{already:'finished'}` → silent clear |
| Abort during readiness phase (stream gate) | run aborts; ⚠ gate loop is NOT step-bound — VERIFY abort latency during phase='stream' (B2 abort check is between steps; the 30s gate budget may need an isAborted check — read playback gate loop; if missing, note as known limit or add the check) |
| Queued (not yet dispatched) run | DELETE /api/queue/:id (not run abort) — dispatch-by-kind |
| Background run finishes while page closed | nothing to update; verdict appears on next templates fetch (existing) |
| Mode = background but user clicks verdict pill mid-run | pill opens evidence of LAST FINISHED run (existing semantics) — no change |
| playingAll + single-row abort | that case aborts; batch continues with rest (by design; stop-all is the batch control) |
| Two tabs, abort in tab A | tab B's tracker clears via WS → row flips back to ▶ |

## Out of scope (explicit)

- Abort confirmation dialogs (decided against)
- Changing play-all's sequential/queue semantics
- Stream gate changes (background ≠ gate skip — contract intact)
- Changing evidence/verdict surfaces (unchanged)

## Self-review checklist (executed 2026-09-06 — findings folded into Task 0)

- [x] run.started payload carries template_id → **NO — Task 0 adds it**
- [x] RunPanel handles run.aborted → **NO (only run.finished, :120) — Task 3 adds the listener**
- [ ] templates refetch on run.finished exists or gets added (Task 2 verify)
- [ ] queued-run representation in /api/runs settled (Task 3 kind routing)
- [ ] stream-gate abort latency checked (edge-case row; read gate loop in Task 3)
- [ ] run.aborted emitted on template-run abort → **NO — Task 0 adds it**
- [ ] menu a11y (Escape/arrows) + shared classes only
- [ ] sticky mode label always truthful (button states its mode)
