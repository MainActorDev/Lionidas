# Network conditioner — user-settable network conditions

- Source prompt: "As a user, I want to be able to set my network condition (network conditioner). Can you check if baguette support it. Anyway, find a way" (invoked with /hms-brainstorm-rough-ideas)
- Created: 2026-09-28T15:36:08Z
- Status: Direction selected (all open questions answered 2026-09-28)

## Goal and context

The operator wants to condition the network of a simulator under test from Lionidas — set latency/bandwidth/loss/offline ("network conditioner"), presumably from the network page alongside the existing proxy/mode controls. The prompt asks first whether Baguette supports it, then to find a way regardless.

Interpretation (not user-confirmed): the control lives in Lionidas UI (the network page's control strip is the natural home), applies to a chosen simulator, and likely wants to ride along runs or at least be settable while preparing a scenario.

## Confirmed inputs and decisions

- User-confirmed: the capability ask; check Baguette first; find a way anyway.
- Verified facts (2026-09-28):
  - **Baguette HAS network conditioning** — `docs/features/network.md`: `baguette network set --udid <UDID> --profile 3g | --latency/--bandwidth/--loss | --offline`, `network clear`, `network status`; HTTP `POST/GET/DELETE /simulators/:udid/network` when `baguette serve` runs; a serve-UI Network card. Presets: wifi / dsl / lte / 3g / edge / very-bad-network / 100-loss (Network Link Conditioner vocabulary).
  - Mechanism: injects `VirtualNetwork.dylib` into apps — conditions **URLSession-shaped traffic only** (no WKWebView page loads, no raw sockets); **only apps launched AFTER `network set`** are conditioned (dyld insert-at-exec; changing the condition later needs no relaunch, ~100ms pickup).
  - There is NO simctl verb for this; NLC/dnctl+pfctl are system-wide (would degrade the whole Mac + all sims).
  - **alloy has NO shaping verb** — `alloy_network` is a request-dump reader, not a conditioner (routing.ts:299).
  - **the device daemon has no throttle/condition surface** (source grep; only preset `throttle_kbps` on Forge presets — a different, response-level feature).
  - Lionidas today: Forge presets already fake per-endpoint responses incl. delay/throttle/failure — complementary (server-side canned behavior), not link conditioning.

## Exploration

### Option A — call Baguette from Lionidas (recommended)
Lionidas server shells out to `baguette network set/clear/status --udid` (or POSTs to a running `baguette serve`). UI: the network page's control strip gains a **conditioner** control (device picker + preset/custom + offline + clear + status readback), scoped per simulator.
- Strong: the conditioning engine already exists and is tested (NetworkProfileTests); per-app (other sims + Mac unaffected); presets speak the iOS-native vocabulary.
- Weak: introduces a Baguette dependency in Lionidas (bin on PATH or config path); relaunch requirement must be surfaced honestly (set BEFORE launching the app — Lionidas controls app launch at run start, so a run-scoped condition can be applied pre-launch cleanly); URLSession-only coverage must be disclosed.
- Run integration: a case/plan could pin a condition (e.g. variant `network: 3g`) — applied at run start pre-launch, cleared at run end, mirroring the scenario activation lifecycle.

### Option B — alloy verb wrapping Baguette (engine-boundary purity)
Add `alloy_condition_network` (or extend engine A) that shells to Baguette; Lionidas dispatches like any other alloy verb.
- Strong: keeps Lionidas engine-agnostic; the keyboardDismiss precedent (the device-daemon PR → the alloy PR → Lionidas) is exactly this shape.
- Weak: another cross-repo PR chain for what is a local tool call; Baguette is OUR tool, not a remote engine.

### Option C — Forge preset abuse (rejected)
The presets' `throttle_kbps`/`failure` shape responses, not the link. No latency, no offline, wrong layer. Documented as complement, not competitor.

### Recommended direction (proposal)
**A, with B as a later refactor if a second consumer appears.** Pragmatic: Lionidas owns device orchestration already; Baguette is present in the workspace; the UI surface is small. If run-scoped conditions land (variant pins), revisit routing through alloy only if another tool needs the same verb.

## Open questions

None — all answered 2026-09-28 (operator, chat):
1. **Scope: manual + RUN-SCOPED** — a variant/case can pin a condition; applied pre-launch, cleared after the run.
2. **Transport: shell out to the `baguette` CLI** (no long-lived serve dependency).
3. **Presets only, "but make it vary"** — the full preset vocabulary ships (wifi/dsl/lte/3g/edge/very-bad-network/100-loss), no custom number inputs; variety comes from the preset set.

## Decisions log

- 2026-09-28 operator (chat): answers 1–3 above, verbatim "1. Also run-scoped / 2. OK / 3. Presets only. But make it vary".
- Direction A (Lionidas calls Baguette CLI directly) accepted by proceeding; alloy verb deferred unless a second consumer appears.

## Next step

`/hms-plan-from-brainstorm` on this artifact: network-page conditioner control (device + preset + status + clear), run-scoped condition pinning in the case/variant grammar (applied pre-launch per Baguette's dyld constraint, cleared in the run's finally path), preset vocabulary surfaced end-to-end (UI picker, yaml grammar + autocomplete, run stamping for provenance).
