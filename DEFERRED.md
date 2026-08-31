# DEFERRED — parked work, so we don't forget

Live index of everything intentionally deferred. Each entry: what, why deferred,
trigger to revive, and where it slots in when revived. Update when reviving or
killing an entry — this file is the contract with future-us.

**Rule:** an entry leaves this file only by being built or explicitly rejected.

---

## A. Maestro adoption — templating upgrades

*Source: Maestro study 2026-08-31. **Batch 1 (A1–A4) SHIPPED 2026-08-31** —
env substitution, tags + play-all, optional steps, evaluated logging. Plan +
self-review at `docs/plans/2026-08-31-maestro-batch1.md`. Entries removed per
this file's rule. Remaining:*

*Batch 2 shipped 2026-08-31 — subflows (`runFlow`, cycle-guarded, flow-name
provenance), resilient selectors (label/type/identifier captured at record,
resolved against the live hierarchy at playback, coordinate + scaling
fallbacks), cross-device scaling for selector-less steps, B5 device-busy
guard (409). Live-verified same-device, cross-device (iPhone 16 Pro → SE),
broken-selector fallback, subflow run, 409 guard. Plan + self-review at
`docs/plans/2026-08-31-maestro-batch2.md`. Entries removed per this file's
rule. Remaining:*

---

## B. QA automation flaw review — accepted, unfixed

*Source: flaw review 2026-08-31 (verified against code, P0–P2 + conceptual).
Items below were identified and NOT yet fixed. Fixed items are NOT listed
(fixed: OS-proxy orphaning; app binding/settings hijack; iPad exclusion;
template plaintext secrets — B10, via A1 env substitution; cross-device
blind replay — B3, via A6 selectors + scaling; playback concurrency — B5,
via device-busy guard).*

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

### B4. State file: non-atomic writes, four writers, two models — P1
- **What:** `writeFileSync` onto the live path (addon can read torn JSON);
  UI-sync vs scenario-activate write different shapes (full list vs subset) —
  preset creation during an active scenario clobbers the override.
- **Fix sketch:** temp-file+rename; single owner of "what's active".
- **Trigger:** before scenarios see any real use.

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

### B11. Unauthenticated API — conceptual, accepted
- **What:** any local process can drive devices / read captured bodies
  (including auth tokens). Accepted for single-QA localhost tool.
- **Trigger:** if Crucible ever leaves localhost.

### B12. No image assertions = weak green runs — conceptual, accepted
- **What:** a replay tapping where a button *used to be* still passes.
  Mitigation now available (A6 shipped): selectors must RESOLVE for
  `resolvedBy:"selector"` — a vanished element degrades to
  `coordinate-fallback`, visible in evaluated_json. Optional hardening:
  post-step element-existence checks from stored selectors.
- **Trigger:** next pass on run assertions.

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
- **Trigger:** before extending subflow semantics (conditionals, outputs) —
  their composition docs live there.
