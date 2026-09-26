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
### 11. [DONE 2026-09-25]  Launch-arg live-refresh pattern (parked 2026-09-24, design agreed)
App-side change (ios-consumer, NOT Crucible): move home's country-recommendation
fetch from willAppear to viewDidLoad-once (user's long-standing intent — fewer
redundant fetches). Crucible-side consequence: the registry's back-forward
refresh gesture dies (home VC stays alive; guard 1 correctly fails
SWAP_NOT_CONFIRMED), and the deep-link gesture is DEAD for this app — verified
live 2026-09-24: lionparcel://home and lio://home open the app but iOS shows
the "Open in Lion Parcel?" confirmation dialog and NO fetch fires (router
reuses the live instance; the dialog also blocks automation). Agreed design:
production keeps viewDidLoad-once; when launched with a test launch-arg (e.g.
-uitest-live-refresh, exact name TBD by the app team) home ALSO refetches on
appear. Crucible then: playback passes the arg at launch (runs.launch_args_json
already carries launch args); registry refresh gesture becomes a new
launchArg kind OR the arg is implied by swap runs (design note: prefer making
playback always pass it — zero registry surface change, no per-screen
deep-link registrations needed, which the user explicitly rejected as
tail-wagging-dog). Until the app ships the arg: back-forward keeps working
(willAppear still fetches today).

### 12. [NOTE 2026-09-25] signal gesture superseded back-forward for home
Plan 20260925T002337Z shipped; home's registry refresh is now `signal`
(revision 9). back-forward remains valid grammar for screens with real
navigation refresh paths. Known gap (review F5): YAML exporter drops
`back:` anchors and selector `point:` — back-forward registries lose the
return leg on YAML round-trip; fix before relying on YAML export for such
registries.

### 13. [ACCEPTED 2026-09-26] iPhone 17 Pro Max disclaimer AX lateness — accepted floor
Measured (same server, same template, same minute — runs c1db84f7 vs
fabfff2f): Privacy Policy tap settle = 2.27s on iPhone 16 (A2102153) vs
5.31s on iPhone 17 Pro Max (984FF244). Engine-side gates verified fast
(loop exits within ~2 reads once the target exists; runner logs: 4.2s of
the 5.3s is the app's text-kit layout latency before the disclaimer
UITextView/Links enter the AX tree — target lateness, not gate slowness).
Count-stability gate shipped in e88be1b.

Accepted decision (operator, 2026-09-26: "C"): treat ~5.3s as the 17PM
floor; no app-side change (replacing the UITextView disclaimer with
discrete link buttons was considered and rejected — production UI change
for a test-speed gain). Drills should prefer the pinned sim (A2102153).
If this ever blocks a hard timeout: revisit via option (b) as a last
resort.
