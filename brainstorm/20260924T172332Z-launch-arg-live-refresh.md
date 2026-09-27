# Launch-arg live refresh: viewDidLoad-once fetch + test seam

- Source prompt: "I really had something in mind since a long ago to move the fetch country recommendation from willAppear into viewDidLoad equivalent. So it will only be fetched once… explore the launch-arg pattern" (operator, 2026-09-24); scope confirmed: BOTH repos, no Jira, ios-consumer-intl branch from develop, arg name "whatever you choose"
- Created: 2026-09-24T17:23:32Z
- Status: Direction selected

## Goal and context

The operator wants home's country-recommendation fetch (`/v1/algo-shipment/route/tariff/destination-recommendation`) to fire **once per screen creation** (viewDidLoad-equivalent) instead of on every appearance — a production-efficiency change held back because Crucible's world-swap mechanism depends on re-fetch on return (back-forward gesture; verified live: tab-retap and pull do nothing, deep links open with an iOS confirmation dialog and never refetch — evidence in Crucible `plans/BACKLOG.md` #11).

The agreed design (operator, this session): production fetches once; a **test launch argument** restores appear-refetch behavior when present. Crucible passes the arg on every launch.

## Confirmed inputs and decisions

- Operator decisions: both repos implemented (no Jira ticket); app work on a new branch from `develop` in `ios-consumer-intl`; launch-arg name at my discretion.
- App architecture (verified in repo, 2026-09-24):
  - Fetch lives in `Modules/LPHome/Sources/LPHome/Runtime/HomeFeature.swift` — intent `.loadData` → effect `.loadRecommendedCountries`; **no once-guard in the reducer**.
  - Trigger: `HomeSwiftUIView.swift` `.task { adapter.dispatch(.loadData) }` (line ~104) — SwiftUI `.task` re-fires on identity reappearance ⇒ today's willAppear behavior.
  - No existing UITest-launch-arg infrastructure anywhere in App/Core/Modules (grep clean).
  - `HomeFeatureTests.swift`, `HomeStoreAdapterMirrorTests.swift` exist — test seams for the feature.
- Crucible side (verified): playback launches the app via `alloy_apps open` with `launchArgs` (`runs.launch_args_json`); the play path accepts `launchArgs` end-to-end (routes/runs.ts QueueSpec).
- Crucible CI is green; PR #1 is NOT merged until this lands (operator: "not merging until that implemented").

## Exploration

### The seam options for the once-per-creation change

- **A. Guard in the view** (`.task(id:)` keyed on a once-token): minimal diff, but view-layer state; adapter re-creation resets it — survives navigation today, fragile to future view restructuring.
- **B. Guard in the feature reducer** (chosen): `State.hasLoadedCountries: Bool`; `.loadData` returns `.none` (clears loading flag) when already loaded. Once-semantics live with the data owner; unit-testable in `HomeFeatureTests`; view diff is zero.
- **C. Move to explicit init-time dispatch only**: cleanest conceptually but changes who commands loading (composition root) — larger blast radius than the operator asked for.

B is the recommendation: the reducer owns once-per-store-lifetime, which in this architecture equals per-screen-creation (store is created with the screen; verified pattern: adapters take `store:` at init).

### The launch-arg seam

- Read once at composition: `ProcessInfo.processInfo.arguments.contains("-uitest-live-refresh")`.
- Injection point: `App/Composition/HomeAdapters.swift` (already builds the feature deps) — thread a `liveRefreshOnAppear: Bool` into the adapter/view, OR simpler: keep the guard but make the *guard condition* `!hasLoadedCountries || ProcessInfo…liveRefresh`. Feature stays ProcessInfo-free if the flag arrives via init parameter (testable; no singleton smell inside modules).
- Name: **`-uitest-live-refresh`** (flags-style, uitest-prefix is the iOS ecosystem convention).

### Crucible side

- Playback always passes `-uitest-live-refresh` at launch (one line where `launchArgs` defaults). No registry changes, no per-screen anything (operator rejected per-screen deep links).
- The registry's `back-forward` gesture keeps working **unchanged**: with the arg present the app refetches on appear — exactly today's behavior.
- Detection (nice-to-have, cheap): none needed — the arg is inert on old builds (ignored), and on new builds it restores current behavior. No flag day, no probing.

### Ordering

App first or Crucible first are BOTH safe (arg inert in either direction), but the operator's merge gate wants the app change shipped with the Crucible change in the same review window. Implementation order: app branch → verify on sim (manual drill) → Crucible one-liner → full drill → both PRs ready.

## Open questions

None material. (Launch-arg name chosen: `-uitest-live-refresh`. Branch naming per repo law: `cust/…-lioclaw` suffix? AGENTS.md says pre-push hook requires `-lioclaw` ending — will use `cust/uitest-live-refresh-lioclaw` from `develop`.)

## Next step

Plan (`hms-plan-from-brainstorm`): two-stage plan — Stage A app (reducer once-guard + composition-level arg read + unit tests), Stage B Crucible (playback launch arg + drill re-run proving swaps still traffic-verified).

## Risks / edge cases

- Home chips refresh on **login state change** or **origin change**: verify no other `.loadData` dispatch path (e.g. pull-to-trigger on balance/login) relies on appear-refetch; if found, gate those dispatchers by the same conditions — plan stage A includes a usage sweep of `.loadData` dispatch sites.
- SwiftUI `.task` cancellation semantics: reducer-side guard is independent of task lifecycle — no interaction.
- Old Crucible + new app (operator's local dev): world-swap drills would fail SWAP_NOT_CONFIRMED *until* Crucible passes the arg — acceptable, same-window rollout covers it; noted explicitly so it isn't a surprise.
