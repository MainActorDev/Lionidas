# Multi-project build config: scheme/destination correctness at production grade

- Source prompt: "How is this new project registry would work accross different projects? Analyze the edge cases. Different projects might have different configuration. How do we decide that the steps in the build (only BUILD for now) process is correct? Like choosing which schema the user want and so on. This have to be a production-grade not vibes. Propose your solution"
- Created: 2026-10-07T15:37:19Z
- Status: Exploring

## Goal and context

The registry works for ONE project (ios-consumer-intl) because we drilled it
against that repo and encoded its conventions (xcodegen, scheme = xcodeproj
basename, isolated caches). The user is asking what happens when project #2
is a different shape — and, more sharply: today the generic engine GUESSES
the scheme with a heuristic. "LionParcelLogisticsINTL" was right by
convention, not by knowledge. A guess is acceptable in a drill, unacceptable
in production: wrong scheme = wrong artifact or wasted 15-minute build, and
the failure surfaces only after the compile.

Two asks:
1. Cross-project edge cases: what varies between repos and what breaks.
2. A production-grade mechanism for deciding build inputs (scheme,
   configuration, destination) — decided by evidence, not vibes.

## Confirmed inputs and decisions

- One project = one repo (brainstorm 20261005T071623Z Q1).
- Pipelines live in the repo; Lionidas never owns build config (Q5).
- Transport C: repo recipe (`scripts/build-sim.sh` > `fastlane build_sim`)
  wins; generic engine is the fallback (Q1 decision, CI brainstorm
  20261007T052303Z).
- Scheme auto-discovery was chosen (Q2, CI brainstorm) — no per-project build
  fields existed at registry design time.
- Simulator-only artifact gate (DTPlatformName re-read from the built ipa) is
  implemented and non-negotiable (device ipa = named failure).
- Verified facts from the drill: `xcodebuild -list -json` per repo is cheap
  (~7s warm); schemes include framework/module schemes (Bellwether, LP*) that
  are NOT apps; xcbuddy auto-injects isolated caches + JSON envelope; the
  intl repo has per-configuration schemes (…-Staging, …-Production).
- Auth token plumbing exists (https token-in-URL / ssh askpass), unexercised
  against a private repo.

## Exploration

### What actually varies across projects (edge-case inventory)

| Dimension | intl repo (today) | A different project could… | What breaks if hardcoded |
|---|---|---|---|
| Project generation | xcodegen (`project.yml`) | committed `.xcodeproj`, or Tuist, or nothing (SPM app) | generic path runs xcodegen wrongly / never |
| Scheme naming | scheme == xcodeproj name | scheme ≠ project name; many app schemes | heuristic picks a framework scheme or wrong app |
| Configurations | Debug/Staging/Production/Release (schemes per config) | single Debug | builds wrong flavor; config-specific schemes ignored |
| App targets | 1 app | multiple apps (watch, widget, ext) | builds the wrong app or an extension |
| Platform | iOS app | macOS/iPad-only Catalyst | destination mismatch, .app not .ipa |
| Build tool | xcodebuild + xcbuddy | Bazel, Buck, `swift build`, Android (apk) later | generic engine is iOS-only |
| Signing | simulator = unsigned ok | entitlements/macros needing a host app | compile fails late |
| Secrets | none needed for sim build | xcconfig from vault | build fails at compile with cryptic error |
| Repo layout | schemes at root | monorepo, app nested 2 levels | `-list` finds nothing at root |
| Package manager | SPM w/ stale committed lockfile | CocoaPods (workspace!) | wrong target for xcodebuild |

### Is the heuristic "correct"? No — it is a fallback, and production means EXPLICIT input with a VALIDATED default

The core question: "how do we decide which scheme". Three candidate designs:

**Option A — pure auto-discovery (status quo, hardened).**
Improve the heuristic (prefer app-type targets via `xcodebuild -list` +
pbxproj target types).
- ✅ zero UI, zero config, works day one.
- ❌ Still a guess. Cannot distinguish "LionParcelLogisticsINTL" (app) from a
  future "LionParcelApp" + "LionParcelAppDev" pair by name alone. Fails
  silently-wrong on multi-app repos. The user explicitly said: production
  grade, not vibes. **This stays only as the FIRST-RUN suggestion.**

**Option B — per-project build settings in the registry (admin-set).**
`projects` gains `build_scheme`, `build_configuration` (nullable). Admin picks
once in the project editor from a discovered list; builds use it.
- ✅ Explicit, auditable, matches "registry = source of truth". Wrong choice
  is a human decision, visible in the UI, not buried in code.
- ❌ Config can go stale when the repo renames a scheme (build fails with
  clear error — acceptable); adds UI surface.
- **This is the decision record.** Discovery proposes, human confirms.

**Option C — repo declares its build contract (a manifest).**
Repo ships e.g. `lionidas.yml`: `scheme: X, configuration: Debug, lane:
build_sim`. Lionidas reads it.
- ✅ Perfectly aligned with "pipelines live in the repo" (Q5). Versioned with
  code; per-branch build flavor possible later.
- ❌ Requires a PR to every project repo; chicken-and-egg for project #2
  before its first build. Overkill as the ONLY mechanism.

**Proposed direction (B, with A as proposer and C as override):**
1. **Build-input resolution order** (deterministic, logged at build start):
   `repo manifest (lionidas.yml, if present)` → `registry setting (admin-set)`
   → `discovery suggestion` — and the resolved value is written into the
   build row (`scheme`, `configuration`, `resolution: manifest|registry|discovered`).
   Every build records WHERE its inputs came from. No silent guessing in the
   log — the first log line states the provenance.
2. **Discovery is target-type-aware, not name-based**: use
   `xcodebuild -list -json` + parse target types from the generated project
   (`xcodebuild -showBuildSettings` or pbxproj productType) — only
   `com.apple.product-type.application` targets are candidates; module/
   framework/test schemes are excluded by TYPE. Ties (multiple app schemes)
   are NOT auto-resolved — the build fails fast with
   `SCHEME_AMBIGUOUS` listing candidates, prompting admin selection.
3. **Validate before compiling (fail in seconds, not minutes)**: a preflight
   step runs `xcodebuild -showBuildSettings -scheme X -sdk iphonesimulator`
   and asserts: scheme exists, app-type target, SDK supported. A wrong input
   costs one `-list` round-trip (~seconds), never a 15-minute compile.
4. **First-run UX**: starting a build with no setting → discovery proposes
   (single app scheme: proceed + persist suggestion as the default;
   ambiguous: modal listing app schemes, admin picks, persisted). The
   projects page shows the resolved scheme/config per project with its
   provenance chip (`manifest` / `set` / `auto`).
5. **Cross-project correctness beyond scheme**: generic engine gets an
   explicit **repo-shape probe** at clone time (project.yml? .xcodeproj?
   .xcworkspace? Package.swift? nested?) recorded on the project row —
   drives whether xcodegen runs, whether `-workspace` is passed, root
   directory for `-list`. Unknown shapes fail fast with
   `UNSUPPORTED_REPO_SHAPE` naming what was found.
6. **Configurations**: default `Debug`; per-project override in the registry
   (needed for intl: Debug vs Staging/Production schemes). Simulator gate
   stays: whatever config is chosen, the artifact must be a simulator slice.

### Industry evidence (how Jenkins / Bitrise / Codemagic actually do it)

| Platform | Mechanism | Discovery? | Who decides | Ambiguity handling |
|---|---|---|---|---|
| **Jenkins** (Xcode plugin) | Job config fields: `xcodeSchema`, `xcodeWorkspaceFile`, `xcodeProjectFile`, `configuration` — all explicit, admin-typed; workspace takes precedence over project, scheme over target; multiple projects = one build step each | **None.** Zero magic | Human, per job | Human picks; wrong value = build fails |
| **Bitrise** | Onboarding **project scanner**: finds `.xcodeproj`/`.xcworkspace`, checks `SDKROOT=iphoneos`, lists **shared schemes only** (user schemes invisible), proposes default workflow (options/configs/warnings model) | Yes — once, at app registration | Scanner **proposes**, human **confirms** in wizard (project path, scheme, distribution method) | **Validation fails hard** if no shared scheme; user must point manually |
| **Codemagic** | Two modes: (a) `codemagic.yaml` committed at repo root — fully explicit (`XCODE_SCHEME`, `xcode:` version pinned, JSON schema validates in IDE); auto-used when detected; (b) UI workflow editor with auto-detect | Yes for UI mode; none for yaml mode | Repo (yaml) or human (UI) | yaml = no ambiguity possible; UI mode = human confirms |

The convergence: **nobody production-grade guesses at build time.** Bitrise discovers once at onboarding and freezes the choice (shared-schemes-only is their trust boundary — only schemes committed to the repo count); Codemagic's production answer is config-in-repo; Jenkins is fully explicit. All three decide inputs BEFORE the build and record them.

Direct implications for our proposal:
- The **resolution order (manifest → registry → discovery)** is exactly Bitrise-onboarding + Codemagic-manifest + Jenkins-explicit — validated.
- Adopt Bitrise's **shared-schemes-only** rule: `xcodebuild -list` on a clone already returns only shared schemes (that's why it works on the intl repo — xcodegen emits shared schemes), so our discovery inherits the right trust boundary for free. Document it.
- Adopt Bitrise's **fail-hard-on-ambiguity** (our `SCHEME_AMBIGUOUS`) — same behavior, same justification.
- Codemagic's simulator recipe is byte-for-byte ours (`-sdk iphonesimulator`, `CODE_SIGNING_ALLOWED=NO`…) — no change.
- Jenkins' precedence note (workspace > project, scheme > target) belongs in the repo-shape probe design.


### Risks / validation

- Preflight adds ~5–10s per build — negligible vs minutes of compile.
- Parsing pbxproj productType is stable text; but xcodegen regeneration is
  required before probing (already the case in the engine).
- The manifest (C) introduced NOW would be speculative for a single-project
  system — build the resolution order so a manifest slot exists, ship the
  reader when project #2 exists. Do not build ahead of demand.

## Decisions (2026-10-07, user)

- **Q1 — multi-app repos: ONE APP PER PROJECT ROW** (confirmed). A second
  installable app in the same repo = register the repo again pinned to its
  scheme. Jenkins' grain; keeps claims/pickers unambiguous; builds table
  records scheme per row so the other model isn't precluded.
- **Q2 — scheme + build configuration**: both go into the resolution order
  from day one (two nullable registry columns, two dropdowns fed by
  discovery). A Debug build is not what testers install; intl needs
  Staging/Production.
- **Q3 — manifest: IMPLEMENT NOW** (user overrode deferral).

### Manifest spec v1 (`lionidas.yml`, repo root)

```yaml
build:
  scheme: LionParcelLogisticsINTL   # optional
  configuration: Staging            # optional
```

- **Precedence**: manifest > registry > discovery. Per-build provenance
  recorded (`resolution` column: `manifest|registry|discovered`).
- **Strict schema**: unknown keys (top-level or under `build`) → build fails
  `MANIFEST_INVALID` naming the key. A repo that speaks must be heard —
  typos never silently fall through to guessing. Same for malformed YAML /
  wrong value types.
- **Absent file** → normal path (registry → discovery).
- **Stale values** (renamed scheme) → caught by preflight, error lists both
  the manifest value and available app schemes.
- **Transport note**: inputs apply to the generic engine; when a repo lane
  (`build-sim.sh`/`fastlane build_sim`) runs, the lane owns the steps and
  manifest inputs are informational (logged, not enforced).
- **Platform-neutral by design**: `build.scheme` maps to a Gradle
  module/flavor later, `build.configuration` to a variant; future
  `android:`/`web:` sections extend the same file. Codemagic's
  `codemagic.yaml` pattern, namespaced.
- **Trust model**: repo content is trusted (same trust as the lane script
  the repo could ship); the manifest is data, never executed.

- **Scale constraint (new input)**: the system will later support **Android
  and Web** projects. Consequences adopted now: (a) registry/build fields
  stay platform-neutral in naming — `build_scheme` maps to a Gradle
  module/flavor later, `build_configuration` to a variant; (b) the
  repo-shape probe (not hardcoded Xcode assumptions) is what becomes
  platform-aware; (c) the artifact gate stays per-platform: `.ipa` →
  DTPlatformName simulator check now; `.apk`/web bundles get their own
  gates later; (d) the manifest slot (repo-declared build config) is the
  platform-neutral escape hatch — same file shape serves Android/Web.

## Open questions

None — all closed. Ready for plan → review → build.


## Next step

Plan round (hms-plan-from-brainstorm) for: build-input resolution order +
target-type-aware discovery + preflight validation + repo-shape probe +
schema/registry/UI fields. Then build on this branch (small, surgical —
builds.ts + projects store/schema + BuildsPage picker + projects page chip).
