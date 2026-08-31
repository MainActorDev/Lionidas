# DEFERRED — parked work, so we don't forget

Live index of everything intentionally deferred. Each entry: what, why deferred,
trigger to revive, and where it slots in when revived. Update when reviving or
killing an entry — this file is the contract with future-us.

**Rule:** an entry leaves this file only by being built or explicitly rejected.

---

## A. Maestro adoption — templating upgrades

*Source: Maestro study 2026-08-31 (`/tmp/maestro-study` clone, `~/.maestro` local
flows). User-approved direction; batch 1 was greenlit in discussion, pending
final confirmation.*

### A1. `env` + `${...}` substitution in playback — batch 1, item 1
- **What:** run API accepts `env` map; step fields resolve `${env.KEY}`;
  recorder masks typed secrets at save (plaintext-password flaw).
- **Why deferred:** batch not yet started; design agreed.
- **Trigger:** next work session on templates.
- **Slots:** `server/src/manual/playback.ts` (resolution pass before dispatch),
  `routes/manual.ts` play route (`env` in body), recorder save path (masking).
- **Verify:** template with `${env.USER}` replays typed `env.USER` value;
  steps_json contains no literal secret.

### A2. `tags` on templates + filtered regression runs — batch 1, item 2
- **What:** `tags` column (JSON array); `?tags=smoke&app=<bundleId>` selection
  on list + a play-all endpoint; UI tag chips + filter.
- **Why deferred:** same batch.
- **Trigger:** with A1.
- **Slots:** `db/schema.ts` (guarded ALTER), `routes/templates.ts`, TemplatesPage.
- **Verify:** tag filter returns subset; play-all runs each, one run row each.

### A3. `optional: true` on steps — batch 1, item 3
- **What:** step flag; failed optional step records `skipped_optional`, run passes.
- **Trigger:** with A1/A2 (same playback-pass).
- **Slots:** step schema in recorder + `playback.ts` step loop.
- **Verify:** run with an optional step that misses → run still green, step
  marked skipped.

### A4. Evaluated-step logging — batch 1, item 4
- **What:** run detail stores post-substitution step (what actually executed)
  alongside the template step — Maestro's `evaluatedCommand` pattern.
- **Trigger:** with A1 (shares the resolution pass).
- **Slots:** `playback.ts` step loop (write both forms to run_steps).
- **Verify:** run detail shows template step + evaluated step for `${...}` steps.

### A5. Subflows (`runFlow`) + `when:` conditionals — batch 2
- **What:** step type referencing another template by id (login once, reuse);
  conditional execution on env/output expressions.
- **Why deferred:** real machinery; only worth it past ~10 templates.
- **Trigger:** template count > 10 OR third duplicate of the same login prefix.
- **Slots:** step schema, playback step loop (recursion, cycle guard), UI
  step editor.

### A6. Resilient selectors via view-hierarchy capture — batch 2
- **What:** recorder captures element text/id at tap point from the alloy
  snapshot; playback resolves selector first, coordinates as fallback. Fixes
  cross-device replay (flaw #6).
- **Why deferred:** needs snapshot-at-record-time plumbing; biggest item.
- **Trigger:** first cross-device replay failure reported by QA.
- **Slots:** recorder step capture (`manual/session.ts`), playback target
  resolution, step schema (selector field).

---

## B. QA automation flaw review — accepted, unfixed

*Source: flaw review 2026-08-31 (verified against code, P0–P2 + conceptual).
Items below were identified and NOT yet fixed. Fixed items are NOT listed
(fixed: OS-proxy orphaning; app binding/settings hijack; iPad exclusion).*

### B1. Traffic attribution to runs is structurally dead — P0
- **What:** `addon.py:208` always writes `run_id: None`; the Python addon has
  no channel to learn the active run. Run-detail traffic tab is always empty.
- **Fix sketch:** write `activeRunId` into the mitm state file (or sidecar)
  the addon already tails; addon stamps rows on ingest.
- **Trigger:** before promising per-run network audit to anyone.

### B2. Playback has no timeout/abort — P0
- **What:** a hung dispatch leaves the run `running` and scenario presets
  active forever (restore never fires). No cancel endpoint.
- **Fix sketch:** per-step + per-run watchdog; `POST /api/templates/:id/runs/:rid/abort`
  → mark aborted, restore state, release lease.
- **Trigger:** first wedged run in real use.

### B3. Cross-device replay taps blind — P1
- **What:** `udid` override accepted, but raw `x,y` replayed unscaled (logical
  dims recorded, never used). Different device = every tap offset.
- **Fix sketch:** scale by `target.logical / recorded.logical`; full fix is A6.
- **Trigger:** with A6, or first cross-device replay.

### B4. State file: non-atomic writes, four writers, two models — P1
- **What:** `writeFileSync` onto the live path (addon can read torn JSON);
  UI-sync vs scenario-activate write different shapes (full list vs subset) —
  preset creation during an active scenario clobbers the override.
- **Fix sketch:** temp-file+rename; single owner of "what's active".
- **Trigger:** before scenarios see any real use.

### B5. No playback concurrency guard — P1
- **What:** two plays race on `activeRunId` and restore snapshots; playback
  bypasses the device lease system.
- **Fix sketch:** serialize playback per device through the lease manager.
- **Trigger:** with B2 (same watchdog pass).

### B6. Frozen preset bodies in /tmp — P2
- **What:** `/tmp/forge-mitm/preset-bodies/` is purged by macOS; DB rows
  survive, presets silently serve nothing.
- **Fix sketch:** move under server data dir; migration copies existing.
- **Trigger:** next session touching presets.

### B7. `traffic_bodies` unbounded growth — P2
- **Fix sketch:** retention GC (age + count caps) — same pattern as evidence GC.

### B8. Three drifted row→spec mappers — P2
- **What:** playback's `rowToPresetSpec` drops `throttleKbps` (routes keeps it)
  — throttling scenarios silently lose throttling in runs.
- **Fix sketch:** one shared mapper in `forge/matcher.ts`.
- **Trigger:** with B4 (state-owner pass).

### B9. Freeze matches exact query string — P2
- **What:** volatile query params (timestamps, nonces) never re-match.
- **Fix sketch:** match on path + sorted stable params, ignore volatile keys.

### B10. Recorded `type` steps store literal text — P2
- **What:** passwords plaintext in `steps_json`, served by unauthenticated API.
  (Superseded by A1's env masking — same fix.)

### B11. Unauthenticated API — conceptual, accepted
- **What:** any local process can drive devices / read captured bodies
  (including auth tokens). Accepted for single-QA localhost tool.
- **Trigger:** if Crucible ever leaves localhost.

### B12. No image assertions = weak green runs — conceptual, accepted
- **What:** a replay tapping where a button *used to be* still passes.
  Optional mitigation: post-step element-existence checks at recorded points
  (rides A6's selector capture).
- **Trigger:** with A6.

---

## C. Older deferred items (pre-Maestro)

### C1. iPad exclusion is model-based — revisit toggle
- **What:** poller filters `/^iPad/` on simctl model (commit 2026-08-31).
  One-line removal if iPad testing is ever wanted.

### C2. Settings fallback in session start
- **What:** `startManualSession` falls back to `com.apple.Preferences` when no
  app is guessed/picked. Alloy `open` needs an explicit bundle id — true
  foreground detection is chicken-and-egg without a session.
- **Trigger:** if alloy gains open-current-app, drop the fallback.

### C3. Maestro docs repo not studied
- **What:** studied main repo + local flows; `maestro-docs` repo (guides,
  config reference) unexplored.
- **Trigger:** before A5 (subflows) — their composition docs live there.
