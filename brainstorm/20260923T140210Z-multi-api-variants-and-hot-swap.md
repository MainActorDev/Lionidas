# Multi-API Screens & In-Place Variant Switching

- Source prompt: "1. What if a screen have multiple APIs. What is the best strategy to handle the BE mock variant? 2. Variant now is treated as a separate lane and always reopening the app. Is there a feasible and solid way to not reopen the app, but trigger refresh on that page/feature to see other variants state (mostly API mock)"
- Created: 2026-09-23T14:02:10Z
- Status: Direction selected + round-2 answers (env model, refresh taxonomy, hot-reload verdict, priority) — pending acceptance

## Decisions (user round 1, 2026-09-23)
1. A1 multi-scenario variants: env stays per-variant — OK'd ("It's okay"), with a scalability question answered below.
2. Pull-to-refresh intuition confirmed ("I was thinking the same") — but "not all screens have pull-to-refresh"; research requested. Done, below.
3. Priority elaboration requested. Below.

## Goal and context

Two related questions about variant testing, both grounded in the current pain: the `intl drill` case is variant-only (3 country worlds), each lane pays a full app relaunch, and the variant model assumes **one network scenario = one world**, which breaks when a screen depends on several APIs.

**Interpretation (not user-confirmed):** the goal is (1) a mock-composition strategy for multi-endpoint screens and (2) cutting the relaunch tax so a 3-variant run doesn't cost 3 cold starts.

## Confirmed inputs and decisions (verified 2026-09-23)

- Variant model today: `templates.variants_json = [{id, networkScenario, env}]` — exactly **one scenario per variant**, env is flat key-values consumed via `${env.X}` in steps. `intl drill` = sg/my/empty, each → its own scenario (`countries-sg` etc.), each scenario holds the full country payload pack.
- Scenario = a set of **presets** (URL-matched fake responses, hybrid mode). Presets are per-endpoint already — scenarios are the composition unit, but a variant can only pick ONE.
- Playback per lane: TCC grant → `simctl terminate` → relaunch under DYLD env (`playback.ts:500-529`) → steps. The relaunch serves two masters: env injection (launch args / env vars) AND scenario activation (presets apply for the run's duration).
- Steps support `expect` selectors only in the drill case (`labelContains ${env.COUNTRY}`) — the flow is: launch → assert screen shows the world's data.
- Forge (proxy) supports hybrid mode with per-request matching; presets restore after the run.
- Crucible knows nothing about the app's screens/features — it drives by accessibility labels/coordinates. "Refresh this page" is an app-internal gesture Crucible can only *simulate* (pull-to-refresh tap, tab re-tap, navigate away-and-back), never *command*.

## Exploration

### Q1 — multi-API screens: composition strategy

**The problem, precisely:** a screen calling 3 APIs under a one-scenario-per-variant model forces either (a) one mega-scenario per world (3×N duplication as N worlds grow — the `countries-*` pattern already does this), or (b) can't express "API A from world sg, API B degraded" at all.

**Option A1 — variant = scenario SET (compose presets) ✅ PROPOSED**

Let a variant reference multiple scenarios; effective presets = union (match-rule conflict = validation error at save time, not silent shadowing).

- Mechanics: `variants_json[].scenarios: string[]` (back-compat: keep `networkScenario` as sugar for `[x]`); activation loop applies each set's presets; forge attribution tags which scenario served which request (already per-request).
- **Wins:** orthogonal concerns compose — `countries-sg` + `rates-degraded` + `auth-happy` are three reusable packs, not 3×2×1 mega-scenarios; the intl family collapses to `sg/my/empty × degraded?`; per-request attribution in the traffic table proves which mock answered.
- **Costs:** conflict-detection at scenario-save and variant-save; UI picker becomes multi-select.

**Option A2 — per-endpoint variants (variant overrides one API)**

Variant = `{endpoint overrides}` instead of scenario refs.

- **Rejected:** leaks HTTP URLs into the case authoring layer, duplicates what presets already are, and makes "which world am I in" unanswerable for `${env}` steps (env would need endpoint-derived composition — a mess).

**Option A3 — keep one mega-scenario per world (status quo)**

- Works today, but N worlds × M axes = N×M scenarios, each hand-maintained; already visible in `countries-*`. Fine at 3, hostile at 10.

### Q2 — no-relaunch variant switching

**The hard truth first:** relaunch exists for two reasons — env injection (`${env.COUNTRY}` needs launch-time env on iOS) and TCC/DYLD mechanics. **Only the env dependency forces it.** If the app reads world-state from what the mock serves (typical API-driven screen), and the step asserts on *rendered output*, then the variant's distinguishing input is purely the network layer — which the proxy can swap **between requests without touching the app**.

**Option B1 — hot-swap scenarios between steps ("world step") ✅ PROPOSED**

New step action `world: <scenario-set>`: mid-run, Crucible (a) activates the new presets on the proxy, (b) performs a **refresh gesture** — author-declared per case: pull-to-refresh selector, tab re-tap, back-then-forward, or an app deep link (`simctl openurl`) that re-enters the screen without a process restart, (c) steps continue asserting.

- **Wins:** 3 worlds = 1 launch + 2 swaps + 2 refresh gestures ≈ minutes saved per batch; the drill case becomes one continuous flow; run detail shows `world sg → my` transitions in the steps log.
- **Costs/risks (real):** (i) app caching — if the screen caches in memory, refresh won't re-fetch; mitigation: author picks a gesture that provably re-triggers the calls, and the traffic panel (per-request, per-scenario-attributed) verifies the second world's requests actually happened — a `world` step can *fail* if no matching request lands within a budget; (ii) client state bleed (auth, feature flags) — first world's session leaks into second; the honest answer: variants needing clean client state keep the relaunch lane, so **both modes coexist**; (iii) env-var variants (`${env.COUNTRY}` in selectors) can't hot-swap — env is process-wide. So: hot-swap covers **mock-only variants**; env-carrying variants stay lanes. The intl drill's COUNTRY env would need moving from env into the mocked payload (assert on visible country name, not on env).
- **Solidity:** the "did the swap actually take effect" check is what makes this trustworthy — B1 without the request-verification guard is theater.

**Option B2 — app-side test hook (deeplink/URL scheme per world)**

App registers `crucible://world/sg`; step = openurl; app re-fetches.

- Fastest and most deterministic refresh, but requires app-team cooperation (a debug hook in the app). Worth requesting; can't be Crucible-only. Not a blocker for B1 — B1 works with pure UI gestures; B2 is an optimization if the hook exists.

**Option B3 — keep relaunch, parallelize lanes (status quo+)**

Multiple booted sims, one lane each — wall-clock improves, cost = N booted sims and still N cold starts. Compatible with B1 later; doesn't answer the question asked.

## Round 2 — answers

### R1 — "Will env-per-variant scale?" (A1 scalability)

Yes, with one discipline. The pressure point is **axis collision**: variants multiply per *world* (sg/my/empty), env keys multiply per *concern* (COUNTRY, FEATURE_FLAG_X…). Set-union scenarios handle the mock side cleanly; env stays a flat map per variant, so the failure mode is variants-as-combinatorics — 3 worlds × degraded × flag-off = 9 hand-written variants.

Guards that keep it scaling (all cheap now):
- **Env keys must come from a declared vocabulary** (case-level `envKeys` list); `${env.X}` in steps validated against it at save. Prevents typo'd orphan keys.
- **Variant inheritance** (later, only if needed): base env + per-variant deltas, so 9 combinations aren't 9 full definitions. Don't build until a real case hurts.
- The strategy that removes most pressure: prefer **payload-derived assertions** (assert on the country name the mock served, not `${env.COUNTRY}`) — fewer env dependencies, and it's also the prerequisite for B1 hot-swap anyway. Verified pattern already exists: steps assert `labelContains`, mocks carry the payload.

### R2 — refresh without pull-to-refresh: research findings

Searched for iOS no-restart refresh strategies and real-world warm-delivery systems. The gesture menu is bigger than pull-to-refresh, and two production simulators (tapsmith PRs #174/#178) prove the model AND document its failure modes:

**Refresh gesture taxonomy** (author picks per case, stored on the `world` step):
1. Pull-to-refresh — where it exists (the classic `press + drag` coordinate gesture).
2. **Navigation re-entry** — back → forward, or tab-switch away → back (tab re-tap). Works on virtually every pushed/presented screen; triggers `viewDidAppear` re-fetch in well-behaved apps. No special UI required.
3. **Deep-link re-entry** (`simctl openurl myapp://screen/x`) — re-enters the screen without process restart; needs the app's URL scheme. Masilotti's technique for driving deep links applies.
4. (If app team cooperates) **test hook route** — a debug deep link that force-refreshes state (see B2).

**Hot reload (InjectionIII etc.) — verdict: wrong tool.** Researched: injection recompiles *app source* into the running process (interposing/swizzling), built for developer design iteration. It changes app code, not app data; requires build-flag integration (`-interposable`) in the app; and Crucible would be recompiling an app it doesn't own to fake a data refresh. Reject.

**The production lessons that shape B1's design** (from warm-delivery systems, tapsmith #174/#178):
- **Verify by hierarchy/traffic change, not "app is running"** — a warm app satisfies "running" trivially; verification must require observable change (we planned request-verification; their case adds UI-change verification).
- **Warm state accumulates**: after ~60 consecutive warm deliveries, navigation-stack state diverges from cold-launch state (a11y trees stop flattening, stale ids). Fix in the field: bound warm windows (they force cold at file boundaries). For us: cap consecutive `world` swaps per run or force relaunch every N swaps.
- **The black-display flake**: simulator intermittently stops compositing while taps still "succeed". Their fix: display-liveness screenshot gate before trusting warm success. For us: the `world` step's verification already screenshots; extend the guard to "not all-black".
- **Same-screen swaps verify falsely**: if post-swap screen ≡ pre-swap screen, "did it land?" is unanswerable from the tree. Their fix: a reset-epoch marker in the a11y tree. For us: the **traffic verification is the epoch marker** — new-world requests landing IS the proof, which is why B1 without it is theater.

**Bottom line:** B1 stands, gestures 1–3 cover screens without pull-to-refresh (navigation re-entry is the universal default), hot reload is rejected, and the field data turns the request-verification guard from "nice" to load-bearing — plus two extra guards (swap-window bound, black-display check) now baked into the proposal.

### R3 — priority elaboration (A1 vs B1)

They're separable and the order is a real choice:

**Ship A1 first (recommended).**
- **Size:** A1 = schema field + validation + apply-loop + tests. B1 = new step kind + gesture engine + swap lifecycle + 3 verification guards + playback integration + run-detail rendering. A1 is days, B1 is a real slice.
- **Value independence:** A1 pays off even if B1 never ships — mega-scenario duplication is today's cost (the `countries-*` family). B1's value is speed, and its prerequisite case-conversion (payload-derived assertions) is *easier after* A1, because set-variants make "which mocks serve this world" explicit.
- **Sequencing logic:** A1 changes how variants are *defined*; B1 changes how variants *execute*. Doing A1 after B1 would churn B1's just-shipped cases. Definition before execution.
- **Risk:** A1 is additive (back-compat sugar for single scenario); B1 touches playback, the most battle-tested path in the codebase.

**Counter-case for B1 first:** if the relaunch tax is the daily pain (3-variant drill = 3 cold starts every run), B1's payoff is felt every day while A1's is felt at authoring time. If that's you, B1-first is defensible — but then convert the drill case *before* A1, accepting one manual scenario-swap mapping.

**Recommended sequence overall:** A1 (definition) → drill-case conversion to payload assertions (no engine work, immediately halves env dependencies) → B1 (execution) with the three guards.

1. **Q1 model confirmation:** multi-scenario variants (A1) — does the env story stay per-variant (env unchanged by set-union), acceptable? (It is, if env moves to payload-derived assertions per Q2.)
2. **Q2 app behavior:** does the intl screen's refresh path survive a no-restart re-entry (no aggressive memory cache)? Determines whether the drill case can convert to B1, or stays a relaunch lane. Needs one manual experiment: boot sim, route proxy, swap scenario, pull-to-refresh, watch traffic.
3. **Priority:** A1 and B1 are separable. A1 is schema+forge work (small, contained); B1 is playback+steps+verification (bigger). Which first?

## Next step

Answer the three questions → plan the chosen slice → implement behind the existing 907-test suite (A1: variant save/validate/apply tests; B1: world-step playback tests + the request-verification guard as a hard gate).
