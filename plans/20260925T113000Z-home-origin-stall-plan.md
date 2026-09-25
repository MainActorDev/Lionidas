# PLAN (Rejected) — Kill the 3-second location stall in Home country fetch

- Source: measured drill autopsy `run_dd9addfc` (Crucible, 2026-09-25) + user question "why the country fetch like delay for 1-2 seconds"
- Plan status: **Rejected** — operator decision 2026-09-25: "They're not worth it. We're not implementing it" (all directions D1/D2/D3/D1+D2 declined after side-effect review; the 3s location stall is accepted as-is). Do not implement from this artifact.

## Decision log

- 2026-09-25 (operator, chat): after reviewing each direction's behavior-change audit (origin frozen per session / slow-GPS regression on shared Tariff timeout / drill-only pinning), the operator rejected all four. Root cause stands documented; no app-side change.
- Repo: ios-consumer-intl, branch from `develop` (no Jira ticket, per arc convention)

## Confirmed facts (sources)

1. **The stall**: `Core/Location/CurrentLocationRouteResolver.swift:268-275` — `currentLocationIfAuthorized()` calls `locationManager.requestLocation()`, waits on a checked continuation, and a `DispatchWorkItem` fires `finish(with: nil)` at **3.0s hard-coded** (`asyncAfter(deadline: .now() + 3)`). No GPS fix on simulator → every call eats the full 3s, then falls back to the Kuala Lumpur default (`HomeFeature.resolveOriginCity` maps `.unauthorized/.fallbackToDefault` → `defaultOriginCity`).
2. **Who pays it**: `HomeFeature.execute(.loadRecommendedCountries)` (Modules/LPHome/Sources/LPHome/Runtime/HomeFeature.swift:145) — `resolveOriginCity()` runs BEFORE the fetch, serially. So the initial launch load AND every `.bellwetherRefreshRequested` refresh both stall 3s before the request even starts.
3. **Measured**: signal→traffic-row = 3,072–3,257ms across 5 timed probes (3 at 10s spacing, deterministic); proxy latency 0–2ms; simctl spawn ~440ms (parallel path, not the stall); app fetch+render ~200-400ms.
4. **Production impact**: real users with no/weak location fix wait the same 3s on Home first paint of shipping rates. The drill exposes a production latency bug, not a harness inefficiency.
5. **The resolver is already a DI seam**: `HomeCurrentLocationOriginResolving` protocol in LPHome Interfaces; app wires `HomeCurrentLocationOriginAdapter` (wrapping `TariffCurrentLocationOriginService`) in App/Composition/HomeAdapters.swift:110-130.
6. **HomeFeature/HomeStoreAdapter are pristine vs develop** (Option C, merged PR #385) — the user's hard constraint from this arc. Any fix must not reintroduce seam residue.

## Proposed directions (NOT accepted — pick one)

**D1 — Cache resolved origin in Home state (production fix; recommended)**
After the first successful `resolveOriginCity`, store `(originCity, route)` in `HomeFeature.State`. `.loadData` and `.bellwetherRefreshRequested` reuse the cached origin and skip the resolver entirely on subsequent loads. Origin is static for a session; expiry concerns are negligible (user flying between countries mid-session is not a Home-screen scenario).
- Where it lives: `HomeFeature` reducer + state (a `cachedOrigin: (city: String, route: String)?` field) — small domain change, ON PURPOSE (it's a product decision about behavior, and once-per-creation fetch already lives there).
- Cost: ~15 lines + tests. Real users: 3s → 0s on every subsequent Home appearance. Drill: refresh ~3.5s → ~0.6s.
- Risk: if the user's location legitimately changes (e.g., auth triggers locale change), stale origin until next app launch — acceptable; the existing once-per-creation fetch has the same freshness model.

**D2 — Shorten the timeout (3s → 1s)**
One-line change in `CurrentLocationRouteResolver`. Still stalls 1s on every fetch that lacks a fix. Does not help users WITH a fix (they resolve in ms). Cheap but leaves the fundamental wait.

**D3 — Seam-scoped instant-fallback resolver (test-only speedup)**
A `HomeCurrentLocationOriginResolving` adapter that returns the fallback immediately when the uitest launch arg is armed — wired at the composition root only, domain untouched. Drill gets fast; production users keep the 3s bug.
- Matches the land-then-refactor discipline: fastest possible drill, zero production risk, no domain change.
- Does NOT fix the user-facing bug — the 3s remains for real users.

**D1+D2 combined** is also coherent: D1 removes repeat stalls, D2 softens the first stall.

## Blocking question

**Q1: Which direction?** D1 (fix production + drill, small domain change), D3 (drill-only, zero domain change), D2 (mitigation only), or D1+D2? *This decides whether HomeFeature's state changes (D1) — the file the user fought to keep pristine — vs. staying byte-identical (D3).*

Secondary (answer only if D1 or D1+D2): the cache invalidates on... app relaunch only (recommended, matches once-per-creation freshness), or a TTL?

## Out of scope (filed to Crucible BACKLOG separately)

- 440ms `simctl spawn` per signal post → persistent Darwin observer in the device daemon
- AX-snapshot cost per expect step (~1.1s residual) → AX-diff subscription (stage 4 of the latency plan)

## Next step

Operator picks D1 / D3 / D2 / D1+D2 (+ TTL answer if D1) → plan becomes Ready with implementation stages, tests, and a verification drill (expect refresh steps ≈0.6s, chips still flip correctly through all 3 worlds).
