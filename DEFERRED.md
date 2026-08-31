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
via device-busy guard; **proxy lifecycle orphaning — the "no internet every
boot" defect, 2026-08-31: all-service heal at boot/close/API + launchd
dead-man watchdog + Apple/MDM bypass domains; plan + drills at
`docs/plans/2026-08-31-proxy-resilience.md`; watchdog activation is
per-machine, one command: `pnpm --dir server tsx scripts/install-watchdog.ts`**;
weak green runs — B12, via A7 expect steps: existence assertions recorded
from the live hierarchy, replayed as pass/fail with not-found vs ambiguous
reasons, optional=soft, cold-launch settle window ~8s; live-verified
green/red/ambiguous/soft/subflow/cross-device 2026-08-31, plan at
`docs/plans/2026-08-31-assertions.md` — value-equality + image-diff
assertions deliberately NOT built, trigger = first real demand).*

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

### C4. Cloud-Mac (MacStadium) routing — end-state option pending
- **What:** host-proxy routing is now watchdog-guarded and bypass-scoped
  (shipped 2026-08-31), but remains host-global by nature. Ethernet-only
  MacStadium machines work (routing resolves the default-route service, not
  Wi-Fi specifically), yet a VPN/bridge interface (`utun*`, `bridge*`) as
  default route has NO hardware-port service → `primaryNetworkService()`
  throws; an explicit `FORGE_NETWORK_SERVICE` override is not yet built.
- **Rejected permanently:** pf/transparent redirect (a bad rule eats SSH —
  the remote-access lifeline).
- **End-state if host-proxy fights the cloud:** app-level proxy in int-dev
  builds (launch arg → `connectionProxyDictionary`) — per-app, per-run, zero
  host coupling. Costs an ios-consumer change.
- **Trigger:** first MacStadium staging run — verify service resolution, sim
  inheritance after reboot, watchdog drill, before production.
