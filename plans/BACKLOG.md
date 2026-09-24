# Crucible — Deferred Work Backlog

Living list of parked features/fixes, captured when discovered so they
resurface deliberately instead of by luck. Entry format: what, why deferred,
where the evidence lives. Move an entry to `plans/` (via a brainstorm → plan
pass) when it graduates to active work; strike it here.

## Entries

### 1. Screen registry web UI (parked 2026-09-24, R2 follow-up)
The `app_screens` registry is API-only (`/api/apps/:bundle/screens[.yaml]`).
A registry editor page (per-app screen list, entry/refresh/states editing,
yaml import/export) is the natural next UI slice. Without it, screens are
managed by curl.
- Evidence: S3 shipped API-only; S6 drill registered the home screen via raw
  PUT.

### 2. maxSwaps tuning from data (parked 2026-09-24, R2 F5)
GUARD 2's swap-window bound is provisional at 8. Tune from real world-case
usage once several have run. Also revisit GUARD 3's 10KB black-frame
threshold against varied real screenshots.
- Evidence: screen-runner.ts budgets; plan F5 note "provisional — tuned
  from S6 data".

### 3. World transitions in run detail UI (parked 2026-09-24)
World swap steps render as plain log lines today. Stronger visual treatment
(world timeline markers, per-world step grouping) is a design call pending
more real runs to look at.
- Evidence: run_b2ea9023 — first worlds run; step log shows
  `world my active (1 presets)` lines.

### 4. Forge `FORGE_IN_USE` exclusivity (parked from R2 plan; F1)
Concurrent scenario activation across runs/devices on one proxy: the forge
serializes today via device-busy + enqueue, but an explicit exclusivity
error (`world:` swap racing a lane activation on another device) is not
implemented. Becomes load-bearing with multi-device world runs.
- Evidence: R2 plan S5 notes; deferred there as "S5 where world: makes it
  load-bearing" — check whether S5's implementation already covers it via
  the enqueue serialization (it does serialize; the explicit 409 was not
  added).

### 5. DeviceAdapter extraction (parked 2026-09-23, code-quality backlog #1)
Android-prep gate: move raw simctl/xcrun call sites behind a DeviceAdapter
interface. The device-boundary tripwire test pins the current allowlist
(17 files); extraction shrinks it.
- Evidence: brainstorm/20260923T133742Z-code-quality-assessment.md;
  test/device-boundary.test.ts.

### 6. Web UI test harness (parked 2026-09-23, code-quality backlog #2)
Component/unit tests for the web package (pure logic first, then critical
components). Ships after DeviceAdapter per the ranked backlog.
- Evidence: brainstorm/20260923T133742Z-code-quality-assessment.md.

### 7. Drill residue cleanup (parked 2026-09-24, pending user decision)
Live DB holds failed drill attempts (`run_7ba3fd12`, `run_e5794302`,
`run_95f90b07`, `run_2cc65d96` etc.), `batch_afddb3c0` rows, manual-session
`ms_*` rows from experiments, and the sg scenario is still ACTIVE on the
proxy. Keep-as-evidence vs purge is the user's call.
- Evidence: `SELECT id FROM runs WHERE template_id='tpl_4d7b6b27'`.

### 8. Warm re-runs: skip the readiness relaunch (parked 2026-09-24)
The readiness gate always terminate+reopens the app per run (clean-state
contract). For back-to-back runs of the SAME app (e.g. dev iterating one
case, or suites of cases on one bundle), a "warm" mode — reuse the resident
app, reset only scenario state — could remove the cold start from every run
after the first. Risks: client-state bleed (auth, flags, in-memory caches)
is exactly what the gate exists to kill; needs an explicit opt-in (per-play
flag or case declaration) and probably a "state reset gesture" story
(relaunch-once-per-N-runs). Not in R2 scope; revisit when run frequency
makes cold starts a measured cost.
- Evidence: playback.ts readiness gate, phase 2 ("ALWAYS reopen"); the R2
  plan eliminated per-WORLD relaunches (3→1 per case), not per-run ones.

### 9. Guard 2 forced-relaunch clause (parked 2026-09-24, R2 plan S5)
Plan S5 says past maxSwaps: "force a relaunch lane note and reset the
counter". Shipped behavior: SWAP_LIMIT fails the run honestly (author splits
the case or raises the limit) — the auto-relaunch-and-continue path was not
built. Both modes coexist per the plan (line 70): world-cases that need clean
client state convert back to relaunch lanes. Implement auto-relaunch only if
real cases start hitting the limit.
- Evidence: screen-runner.ts world() SWAP_LIMIT branch; plan
  20260923T141446Z S5 notes.

### 10. Recorder → swap cases (parked 2026-09-24, user-directed)
Teach the manual recorder to emit R2 verbs (arrive/swap/refresh/expect
screen) or add a "convert recording to worlds" flow. Genuinely open design:
a recording has no natural moment where it *knows* a world swapped or a
screen was entered — needs its own brainstorm (candidate ideas: a "mark
world" hotkey during recording; post-recording conversion wizard that maps
network-observed scenario changes to swap steps). Not part of the registry-UI
arc (plans/20260924T052218Z-screen-registry-ui-plan.md lists it out of scope).
- Evidence: session 2026-09-24 — user asked "what if I want to create a new
  test case?"; recorder today emits v1 steps only.

