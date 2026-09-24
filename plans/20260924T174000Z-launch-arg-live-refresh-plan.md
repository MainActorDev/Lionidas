# Plan — Launch-arg live refresh (app viewDidLoad-once + Crucible seam)

- Source: brainstorm `20260924T172332Z-launch-arg-live-refresh.md` (direction selected, no open questions)
- Created: 2026-09-24T17:40Z
- Status: Ready
- Repos: `ios-consumer-intl` (branch `cust/uitest-live-refresh-lioclaw` from `develop` @ `1b12768a`) + `crucible` (branch `feat/screen-state-runner`, unmerged PR #1 gated on this)

## Objective

Home's country-recommendation fetch fires once per screen creation (production), while automated runs keep appear-refetch via the `-uitest-live-refresh` launch arg — so Crucible's world swaps stay single-launch and traffic-verified. Both changes verifiable end-to-end: manual drill (no arg → no refetch on return; arg → refetch), then the Crucible swap drill passes 8/8.

## Stage A — ios-consumer-intl

**A1. Reducer once-guard** (`Modules/LPHome/Sources/LPHome/Runtime/HomeFeature.swift`):
- `State` gains `hasLoadedCountries: Bool = false`.
- `.loadData`: if `state.hasLoadedCountries && !state.liveRefreshOnAppear` → set `isLoadingCountries = false`, return `.none`; else → effect as today, and set `hasLoadedCountries = true` **in the `recommendedCountriesLoaded` handler** (success marks loaded; failures stay reloadable — intentional: error recovery beats once-semantics).
- `State` gains `liveRefreshOnAppear: Bool = false` — set at store construction, NOT read from ProcessInfo inside the module.
- Init/dependency: `HomeFeature`'s runtime construction site (find where `FeatureStore<HomeFeature>` is built — `App/Composition/HomeAdapters.swift` is the likely seam) passes `liveRefreshOnAppear: ProcessInfo.processInfo.arguments.contains("-uitest-live-refresh")`.
- The module itself never imports ProcessInfo (composition root only) — testability law.
- Review F2 note: `.task` cancels on disappear — a fetch cancelled mid-flight never marks `hasLoadedCountries`, so the next appear refetches. Intended (incomplete = not loaded); do not "fix".

**A2. Unit tests** (`Tests/Home/HomeFeatureTests.swift` style):
- `.loadData` twice → second returns no effect (once-guard).
- `.loadData` twice with `liveRefreshOnAppear: true` → both fire effects.
- failure path: `.loadData` → failure intent (e.g. countriesFailed if it exists, else simulate by dispatching loadData again before success) → guard NOT set → reload possible.
- acceptance: feature tests pass via the repo's test target (verify command from AGENTS.md build rules — `make` test target or xcbuddy; use cached build flags exactly as `.agents/rules/build.md` prescribes).

**A3. Sweep + docs:** confirm no other `.loadData` dispatch sites (verified 2026-09-24: exactly one, `HomeSwiftUIView.swift:105`); brief code comment on the arg at the composition seam. No UI copy, no L10n (intl law: English code comments).

**Branch/PR:** `cust/uitest-live-refresh-lioclaw` from `develop`; PR created (create-only per house law; human merges). Build + tests run locally before PR (Scipio/Xcode cache rules honored — `xcode-select -p` check first).

## Stage B — Crucible

**B1. Playback passes the arg:** in `server/src/manual/playback.ts` where the app opens (`alloy_apps { action: 'open', launchArgs }`), default `launchArgs` to include `'-uitest-live-refresh'` when the case has swap steps (minimal blast radius) — exact site: the `open` call builds `spec.launchArgs`-equivalent; merge the arg there. Old builds ignore it (inert).

**B2. Drill re-run (acceptance):** with the NEW app build installed on the drill sim: play the intl drill case → expect 8/8 passed, both swaps traffic-verified (`SWAP_NOT_CONFIRMED` absent), single launch. Additionally the negative: launch WITHOUT the arg (manual simctl launch) → back-forward produces NO fetch (validates the production once-semantics actually shipped).

**B3. Tests:** unit test that playback's open payload includes the arg for swap cases (and not for plain cases — decide: always-pass is simpler and harmless; if always, test asserts presence always). Preference: **always pass** (one behavior, no case introspection); test pins it.

**B4. BACKLOG #11 closes**; commit message references it.

## Validation

- App: repo test suite subset (Home feature + mirror tests) green; manual sim drill as A2/A3 describe.
- Crucible: `pnpm run check` (981 tests baseline + new arg test); live drill 8/8; CI green on the PR branch.
- Rollout safety: arg inert on old app builds; old Crucible + new app only affects local dev drills (documented).

## Out of scope

- Pull-to-refresh as a product feature (separate UX decision).
- Registry gesture changes (back-forward stays the gesture; the arg preserves its semantics).
- Any L10n, analytics, or MetricKit touchpoints.
