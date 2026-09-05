# Research Notes — Stealing from Baguette (tddworks/baguette @ v0.1.97)

Source: `../baguette` (cloned 2026-09-05, shallow-50). Baguette is a Swift
CLI + web UI for headless iOS simulator control — same genre as our engine
chain, single-binary. These notes record what Crucible should adopt, ranked
in tiers, with pointers into their docs/source for whoever implements.

Context for why these matter: one week of live drills against Crucible
produced a specific failure taxonomy — invisible-but-visible AX elements
(RUNNER_BUSY wedges aside), single-source snapshot lies, MJPEG weight, raw
evidence videos without tap context. Each tier item below attacks a named
member of that taxonomy.

---

## Tier 1 — steal the ideas (cheap, immediate payoff)

### 1.1 AX hit-test grid sweep — attacks "selector says not found, eyes say it's there"

Their doc: `baguette/docs/features/ax-hit-test-sweep.md`. Their problem:
SwiftUI tab bars / nav bars / toolbars render as *childless* AXGroups — a
recursive accessibility walk structurally cannot see their buttons.

Their fix (the pipeline):

```
① recursive walk (frontmost app, precise + deep)
        +
② grid hit-test sweep (whole screen, 32pt sampling; skip points inside
   CONTENT-leaf frames the walk already covered; keep points inside empty
   containers)
        ↓
merge — de-dup spray hits against walk nodes, graft survivors into the tree
```

Crucible's version of the disease: `ic_tabbar_account_inactive` needed
selector-recentre safety work; "label not found" fired on screens where the
label was visibly present (documented in selector.ts's recentre comments).
Implementation shape for us: a **grid-sweep fallback in the selector layer** —
when `resolveSelector` misses AND the hierarchy came back shallow/childless
near the target region, spray hit-test probes (engine `describe-ui --x --y`
equivalent) and merge. Pure Domain logic; our 400+ test suite is the net.
ADR-0001 compliant: lives in the platform-blind core, dispatch through the
existing engine seam.

**IMPLEMENTED 2026-09-05** (`crucible` 02db2a6 + e03ab59, alloy 1793e38):
`server/src/manual/sweep.ts` + `alloy/probe.ts`, wired in playback behind a
walk-blindness trigger (childless ≥200pt container at the recorded point, no
labeled cover — never fires on healthy trees). 5-point stencil, not
baguette's whole-screen 32pt grid: our probes return the *interactable* view
at a point (~27ms each), so a tight stencil around the blind container beats
spray-and-dedupe. Probe verb = `alloy_native_tree interactable-at` (engine B
injected devtools). Feature doc: `docs/features/sweep.md`. Live-drill caveat:
the LP consumer app's tab bar is UIKit-walkable — no walk-blind surface
exercised the sweep path live yet; verified at engine + unit level.

### 1.2 Two-source truth, merged — never trust one traversal

The principle under 1.1. Our snapshots come from ONE XCTest query; every
time it lied this week, a step failed. Baguette's walk+grid merge is the
pattern: primary traversal + positional verification, merged. Our minimal
version: on selector miss, one hit-test probe at the recorded coordinate —
if it returns a node with the expected label, the tree was wrong, not the
screen. Cheaper than a full grid; catches the common case.

**IMPLEMENTED 2026-09-05** (same commits): both halves — the expect
single-point probe (miss → probe at recorded/scaled coordinate → pass with
reason `expect via point-probe (walk-blind)`) and the tap/type stencil sweep
above. Recording side captures `at: {x,y}` on expects; YAML round-trips it
as `at: [x, y]`.

### 1.3 Docs-as-feature-file structure

29 focused docs in `baguette/docs/features/` — one per mechanism
(`double-tap.md`, `touches.md`, `ax-hit-test-sweep.md`), each pinning
non-obvious decisions with live-learned rationale ("each learned the hard
way" — device-twin.md). Our equivalents live scattered in code comments and
plan docs. Proposal: `crucible/docs/features/` with one file per mechanism —
evidence.md, alerts-policy.md, retention.md, stream-pause.md, ci.md (exists).
Migration is copy-paste from comments/plans; do it when touching each area.

---

## Tier 2 — steal the approach (medium effort, kills known pain)

### 2.1 Host-side input as the iOS adapter's future engine

The deepest lesson of our week: every wedge (RUNNER_BUSY, watchdog timeouts,
capture storms) lived in the *in-app XCTest runner*. Baguette injects HID
events host-side via private SimulatorKit symbols + `IOHIDDigitizerDispatch`
— no app-embedded runner, no watchdog to wedge, no session/lease machinery.
System gestures (home-indicator swipe, app-switcher, notification pull-down)
fire real iOS recognizers.

Decision (per ADR-0001): NOT now — iOS-first means no engine churn
mid-flight. But record that host-side injection is the answer to "why did
the wedges hurt," and a future iOS PlatformAdapter should evaluate
Baguette-style HID (or Baguette itself, MIT-licensed) as the engine.
Caveats: private-API surface pinned to iOS-26 calling conventions; their
AX tree comes from `AccessibilityPlatformTranslation` (different shape
from ours — an adapter is real work, not drop-in).

### 2.2 Tap-overlay composited recordings

Their browser recorder composites bezel + screen + **gesture-overlay dots
into the MP4** — recorded runs show where fingers tapped. Our evidence
videos are raw framebuffer; failure review requires cross-referencing the
step table. We already emit `step.tap` bus events with coordinates — a
canvas-composite pass (or client-side MediaRecorder overlay) would put tap
circles into run videos. No codec change required to start; their H.264
stream (order of magnitude lighter than our MJPEG) is the follow-on if
bandwidth ever matters.

### 2.3 Capability pipes they have that we lack

- **Webcam → sim camera** (`docs/features/camera.md`): one vendored dylib +
  shared-memory ring buffer; apps see real frames through
  AVCapturePhotoOutput et al. Relevant when a test case needs camera input.
- **Location spoofing** (`location.md`): our only tool is `simctl privacy
  grant location` — broken on this Xcode (verified live, writes no TCC
  row). Their approach is the working alternative for location-dependent
  flows.
- **Motion/gyro injection** (`motion.md`), **network condition** shaping,
  **status-bar customization** — future feature notes; no current Crucible
  need.

---

## Tier 3 — steal the discipline (free, cultural)

### 3.1 The uncompromising TDD gate

Their AGENTS.md makes TDD non-negotiable with a literal pre-implementation
gate: (1) state the behavior in domain language, (2) write the failing
test, (3) **observe it fail** (run it, see red), (4) report the red result,
(5) only then write code. Compile errors count as red only when the failing
symbol is the one the test names. Our workflow is TDD but lacks the
"observed red + reported" requirement — the difference between TDD-as-intent
and TDD-as-verification. Adopt the gate language in our working agreements.

### 3.2 In-repo agent skills + evals

They ship `skills/baguette/SKILL.md` (trigger conditions, the agent's
happy path, exact command shapes) plus `skills/baguette/evals/`. If other
agents ever work in Crucible, in-repo agent docs are the multiplier — our
current skills live in the Hermes layer, invisible to repo-local agents
(Claude Code, Codex). Cheap to add when a second consumer appears.

### 3.3 Their plugin system's capability-grant pattern (for later)

`docs/features/plugins.md`: plugins declare capabilities (e.g.
`describe-ui`); the HOST enforces the grant; manifests are untrusted text
(icon *names* resolved against a fixed list; unknown → fallback glyph,
never failure); install never runs code; `when:` activation gates are
declarative. If Crucible ever grows an extension point, steal the
capability-enforcement + declarative-gate shape — NOT the machinery
(single-owner today; speculative generality per ADR-0001).

---

## Explicitly NOT stealing

- Their web UI (ours serves the wall; theirs is a different product)
- The plugin runtime (above)
- Baguette-as-dependency now (private-API churn risk; our engine works)
- Device-twin (physical-device mirroring — impressive, not our problem)

## Pointer index

| Idea | Their source |
|---|---|
| Grid sweep | `docs/features/ax-hit-test-sweep.md` |
| AX wire surface | `docs/features/accessibility.md` |
| Recording/compositing | `docs/features/recording.md`, `capture-size.md` |
| Camera bridge | `docs/features/camera.md` |
| HID input architecture | `README.md` "Host-HID input", `ARCHITECTURE.md` |
| TDD gate | `AGENTS.md` |
| Plugins/capabilities | `docs/features/plugins.md` |
| Device farm | `docs/features/device-farm.md` |
