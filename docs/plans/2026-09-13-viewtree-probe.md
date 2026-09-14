# View-Layer Probe (Tier 4) — Xcode-view-debugger-grade tree for the inspector

> **For Hermes:** time-boxed, decision-gated, numeric exit criteria. Produces
> evidence + fixtures + (gated) an experimental inspector mode. NOT part of
> the AX-depth spike (different seam, different risks — its P3 may land
> before or after this). Supersedes the "DYLD-injection probe (Tier 3)"
> deferred line in `2026-09-12-inspector-figma-parity.md:566` for the
> view-tree payload; the exact-layout-values payload stays coupled to this
> plan's findings.

**Goal:** Give the inspector a SECOND tree source — the UIView/UIViewController
hierarchy (exact classes, frames, hidden/alpha-0 views, Auto Layout
constraints) approaching Xcode's view debugger where reachable — and decide
by numbers whether it becomes a product surface, stays an evidence tool, or
dies at the spike.

**Architecture:** Two mechanisms, strictly ordered. **A (spike first):**
scripted `lldb` attach to the simulator app process — the same mechanism
Xcode's debugger uses; zero fork changes, zero injection, works on the
already-running app. **B (gated):** a probe dylib riding the wrapped
engine's EXISTING launch-time injection machinery (the camera/motion
pattern), exposing an in-process endpoint — built only if A proves value but
its pause/latency blocks a real workflow. AX tree stays the PRIMARY tree;
the view tree is structural corroboration, never a silent replacement.

**Tech Stack:** `xcrun lldb --batch` (host-side subprocess), pure TS parsers
in `shared/src/`, existing manual-session routes + inspector components,
vitest golden/property tests. Mechanism B (if reached): Swift dylib in the
fork (`ai/Baguette`), SPM release build, binary-swap ritual.

---

## Positioning (what this is and isn't)

- Xcode's view debugger is: lldb + `recursiveDescription` +
  `[_printHierarchy]` + `[_autolayoutTrace]` + a debugger UI. We can have the
  DATA all of it is built on, on demand, from Crucible.
- The honest ceiling — **SwiftUI**: its real view tree and layout values are
  opaque to lldb too; SwiftUI screens show UIKit wrappers + hosting views,
  exactly as in Xcode. P0 MEASURES this on a real screen instead of trusting
  the claim. For SwiftUI screens the AX tree (AX-depth spike) remains the
  deeper source; for UIKit-hosted screens this plan is strictly richer.
- Not built, ever: 3D exploded view, live continuous tree (Xcode pauses the
  app to snapshot; we poll — same honesty as the AX tree).

## What it will solve (mapped to real complaints)

| Complaint / failure class | Mechanism | Confidence |
|---|---|---|
| "Is this a real UIButton or a SwiftUI wrapper?" — class guessing | exact view classes from `recursiveDescription` | high |
| Hidden / alpha-0 views invisible to AX (tap-lands-wrong forensics) | view dump includes them | high |
| Padding/spacing DESIGN VALUES wrong in inspector | constraint constants = the actual numbers — **UIKit screens only**; SwiftUI keeps the P2.5 geometric ceiling | high (UIKit), none (SwiftUI) |
| VC structure (nav stack, presented-modals) invisible in AX tree | `_printHierarchy` | high |
| Selector misses where AX is blind but views exist | view tree as corroboration source for humans + future match tier | medium |
| Hierarchy rows show SwiftUI containers as opaque `Other` (no class, no hidden views, wrong nesting) — `InspectTree.vue` (5af2b2d/bae3458) renders AX nodes only | structural tree feeds the EXISTING row format (`type "label" (x y; w×h)`) with exact classes; toggle semantic ⟷ structural reuses the component | high |

## What it will NOT solve

- SwiftUI view tree / its padding+spacing values (opaque to lldb as well).
- Continuous live tree — every dump is a snapshot; mechanism A additionally
  PAUSES the app for the dump duration (budgeted, measured, badge-shown).
- Replacing the AX tree as the selector source (lexical classes ≠ semantic
  labels; matching stays AX-first).

## Verified facts this plan is built on (2026-09-13)

1. **Injection machinery already exists in the wrapped engine** — camera +
   motion features inject vendored dylibs into sim apps at exec time; an env
   var can share the insert-libraries list across features (their
   `camera.md` "Sharing the variable" section). Apps must be launched AFTER
   arming (their `motion.md`). Mechanism B rides this; exact env-var name
   pinned from their source in P3, not from memory.
2. **The fork is ours** — `ai/Baguette` (MainActorDev/Baguette); child-side
   work happens there, non-main branches get pushed + PR'd same session
   (skill rule); binary-swap = rm-before-cp + `--version` + `codesign -dv`
   ritual; supervisor execs the repo-root copy.
3. **Prior art in-repo**: `references/sweep-tier1-2026-09-05.md` (engine
   survey, devtools injection) — READ in P0 before designing anything; this
   plan does not assume its conclusions.
4. **DYLD probe was already deferred once** (figma-parity plan, out of
   scope: "DYLD-injection probe (Tier 3)") — this plan re-opens it WITH a
   cheaper mechanism-A front door and numeric gates.
5. **Verification gates** (repo standard): server `pnpm typecheck && pnpm
   lint && vitest run --maxWorkers=2`; web `vue-tsc --noEmit && vite build`.
6. **Simulator app processes are attachable host processes** (same user
   session; Xcode does exactly this). P0 must still PROVE it headless
   (`xcrun lldb --batch`) — lesson (l)/(p): exercise the wire before
   writing adapters.

---

## Phases

### P0 — Reachability + ground truth (live, half-session, no production code)

1. Boot a sim, launch the LP app (fallback drill app: Foodiary
   `com.his.foodiary.app`). Resolve the app PID via
   `xcrun simctl spawn <udid> launchctl list` (label
   `UIKitApplication:<bundle>[pid]`) — never `ps` guessing.
2. Headless dump, committed verbatim as fixtures per screen:
   - `po [[UIApplication sharedApplication] _printHierarchy]`
   - `po [[UIWindow keyWindow] recursiveDescription]` (resolve keyWindow the
     modern way; fallback: walk windows)
   - `po [[UIWindow keyWindow] _autolayoutTrace]`
3. **Measure and record**: attach time, dump time per command, TOTAL app
   pause duration, detach cleanliness (app alive + responsive after).
4. **SwiftUI ceiling check**: dump one pure-SwiftUI screen; record exactly
   what's visible (expect hosting wrappers). This number/shape becomes the
   plan's honesty contract with the UI.
5. **Failure-mode sweep**: SpringBoard foreground (no app), app killed
   mid-attach, attach timeout, lldb absent. Record each error shape.
6. Exit: fixtures + reachability note in
   `docs/research/2026-09-13-viewtree-reachability.md`. **No viable attach →
   honest reject, stop here.**

**P0 RESULT (2026-09-13, executed live): VIABLE — P1 cleared to start.**
- Recipe pinned (KVC `connectedScenes→anyObject→keyWindow` +
  `recursiveDescription`); `keyWindow` direct and `_printHierarchy` both
  FAIL headless (documented — VC hierarchy needs a different route or
  stays out).
- Cost: cold 17–23s, **warm 6.6s** — on-demand inspection class, never
  polling, never during playback.
- LP home: 338 framed views, real UITabBar+buttons (frame-exact), **41
  hidden/alpha-0 views incl. app-class reused cells** — the forensics
  payload no AX tree has.
- Foodiary (pure SwiftUI): **7 UIKit views total** — the ceiling is now
  a measured fact; AX tree stays the only meaningful tree there.
- Fixtures: `server/test/fixtures/viewtree/*/recdesc.txt`; failed-variant
  logs kept in the research note (not as files).

### P1 — Parsers + cross-check (pure code, no device)

**P1 DONE (2026-09-13, commit eee2bb8):** `shared/src/view-tree.ts` +
exports entry; 8 tests green incl. the ≥90% AX↔view agreement cross-check
(passes on the LP fixture). Real-format traps handled: trailing attrs
after `>` (UIStackView), layer-only echo lines, pipe-indent depth via
leading-prefix pipe count. SwiftUI ceiling asserted as fixture (Foodiary
= 7 views, zero content classes).

### P2 — Experimental wiring (manual sessions ONLY)

**P2 DONE (2026-09-13, commit eee2bb8):** route + 6 tests; live-verified
2× (446/445 nodes, tab bar + 4 buttons, 45 hidden views, pausedMs honest).
Guard semantics live: automated-run 409 (manual sessions carry
kind='manual' parents — excluded, matching session-start), sim-only 422,
per-device mutex, fresh PID per call. lldb hardening found the hard way:
argv PAIRS (flag in the command string is rejected), cwd MUST be neutral
(repo cwd breaks lldb's clang category import, 3/3), 45s budget (cold
attach 17–23s), err.stdout (not err.message) carries lldb's real error,
SIGCONT on timeout kill, one retry on the cold-attach category signature
(attach right after app relaunch = categories not yet registered).
Inspector UI toggle (P2.3/T6) NOT built — API-only until demand exists.
P3 (dylib) remains gated: pausedMs 20–25s is within tolerance for a
manual, user-invoked inspection.

1. `parseRecursiveDescription(text) → VNode[]` (class, frame, viewID,
   hidden/alpha markers) and `parsePrintHierarchy(text) → VCNode[]` in
   `shared/src/view-tree.ts`. Flat + parentIndex, SAME SHAPE CONVENTIONS as
   `AxNode` (lesson (p): pin the shape before consumers exist).
2. Golden-file tests on P0 fixtures; determinism test; **unknown format →
   throw (parsed null only for honest empty), never best-effort mush**.
3. **Cross-check test (machine-checkable richness claim):** on the same
   screen, every AX-hittable labeled node must have a geometric counterpart
   in the view tree; report agreement %. A low number = our parser is wrong
   or the claim is wrong — both are findings.
4. Frame sanity: view-tree frames vs AX rects within tolerance (±2pt where
   overlapping) — disagreement shape recorded.
5. Exit: parsers + tests green; agreement table appended to the research
   note.

### P2 — Experimental wiring (manual sessions ONLY)

1. Server: `POST /api/manual/:id/viewtree` — resolve PID fresh per call
   (stale-pid guard: PID must live in the session's sim container;
   wrong-process attach is a hard error), serialize per-device (mutex),
   timeout budget (attach+dump+detach ≤ 8s, else abort + honest error),
   parse, return trees. Route carries the evidence note "app paused N ms".
2. **⛔ Never during playback**: lldb pause trips run watchdogs / settle
   detectors — route refuses if the device has an active run (same 409
   busy-guard class as the power route).
3. Inspector UI (experimental flag): tree-mode toggle semantic ⟷ structural;
   structural rows render through the EXISTING `InspectTree.vue` row format
   (`type "label" (x y; w×h)`, 5af2b2d/bae3458) — exact class replaces the
   AX `type` chalk, hidden/alpha-0 views render dimmed with a visibility
   marker. SwiftUI screens show the honest hosting-wrapper shape from
   P0.4, not a fake tree.
4. Honesty contract: paused-duration badge, `—` for unknowables, no silent
   AX fallback on failure.
5. Exit: live-verified on one UIKit-ish + one SwiftUI screen; gates (repo
   standard) pass; edge-case table below walked.

### P3 — Mechanism B decision (dylib via existing injection) — GATED

Build ONLY if P2 shows the pause/latency blocks a workflow QA actually runs
(evidence: which drill broke, recorded pause budget vs need), AND the
viewtree earns adoption signals in P4. Design if reached:
- Probe dylib in the fork, armed by the same insert-libraries list camera/
  motion use (pin exact env var from fork source); in-process endpoint
  serving the SAME JSON the parsers emit (parse-at-source).
- Costs on the record: fork PR same session; arming requires app RELAUNCH
  (drill scripts must relaunch-after-arm); injected-code badge in evidence;
  full binary-swap + wall re-verify ritual.
- Exit: it either removes the pause at product cost, or stays unbuilt —
  write which and why.

### P4 — Numeric decision gate (then stop)

| Gate | Adopt (product surface) | Experimental (keep, flag-gated) | Reject |
|---|---|---|---|
| P0 attach viable + pause ≤ 8s | ✅ | ✅ | — |
| P1 parser agreement (AX↔view) | ≥ 90% | 70–90% | < 70% |
| UIKit screens: constraint values extracted | yes | partial | none |
| Live drill: forensics value (hidden-view / class case closed) | ≥ 1 real case | — | 0 |

Adopt → normal implementation plan + DEFERRED update. Experimental → stays
behind the flag with the pause badge. Reject → record why, remove route.
Either way DEFERRED.md updated (skill rule).

---

## Edge-case table (walked at P2 exit)

| # | Case | Behavior |
|---|---|---|
| 1 | App relaunched since last dump | PID re-resolved per call; stale PID → re-resolve, not attach |
| 2 | PID exists but outside the session's sim | hard 422 (never attach to a host process) |
| 3 | SpringBoard foreground | honest "no app target" null + hint |
| 4 | Active run on device | 409 busy-guard (pause would poison the run) |
| 5 | Two dumps same device concurrently | per-device mutex; second waits |
| 6 | App dies mid-dump | abort + honest error; app state NOT masked as tree-empty |
| 7 | Huge tree (table views, 1000s of cells) | depth/cell cap + explicit truncation marker, never silent cut |
| 8 | lldb missing / Xcode CLT mismatch | honest 503-style "tool unavailable", never AX fallback |
| 9 | Dump during app animation | frames captured mid-flight; badge notes snapshot semantics |
| 10 | SwiftUI-only screen | P0.4 wrapper shape shown honestly; no fabricated depth |

## Deliverables

| Deliverable | Where | Machine-checkable? |
|---|---|---|
| Raw lldb fixtures + reachability numbers | `docs/research/` + `server/test/fixtures/viewtree/` | ✅ committed |
| Parsers + golden/determinism/agreement tests | `shared/src/view-tree.ts` | ✅ vitest |
| Experimental route + inspector toggle (P2) | `server/src/routes/manual.ts` area + inspector components | ✅ live drill + gates |
| Decision + DEFERRED entry | this file + `DEFERRED.md` | ✅ numeric gate |

Time-box: P0 half session; P1 one session; P2 one session; P3 only if
gated in; P4 is a write-up.

## Risks

- **lldb headless quirks** (batch mode output wrapping, prompt noise) — P0
  exists to surface them before any adapter is written.
- **Pause duration on big apps** may exceed budget → that IS the P3 gate
  input, not a failure of the spike.
- **SwiftUI share of LP screens** may be high → honest outcome "forensics +
  UIKit-only values"; still closes real cases (gate row 4).
- **Fork churn** (mechanism B) colliding with simdeck wrap work — P3 is
  sequenced after the wrap settles; never both at once.
- **Corpus rot**: fixtures pin app build + screen route, same convention as
  the AX-depth spike.
