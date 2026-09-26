# INVESTIGATION BRIEF — Dispatch cost: the ~0.9s tap round-trip (lever C)

- Source: sub-second taps plan `plans/20260926T062210Z-subsecond-taps-plan.md` (rev 2) — C deferred to this brief
- Status: Brief for the device-daemon repo's own workflow — no code here
- Context: Crucible taps cost ~0.9s in the dispatch itself (accepted→completed in runner logs) even with zero pre-tap wait. Sub-1s steps are gated on this.

## Verified facts (2026-09-26, runner logs + source)

- `AGENT[_]DEVICE_RUNNER_COMMAND_ACCEPTED command=tap` → `COMMAND_COMPLETED` measures **~0.73-0.94s** per tap on both sims (16 and 17PM; e.g. 12:57:38.44→39.11, 13:12:19.65→20.58).
- Every act re-checks `AGENT[_]DEVICE_RUNNER_FAST_APP_GUARD` (app foreground state) before executing.
- The runner is an XCUITest UI test session (`xcodebuild test-without-building … testCommand`); taps go through XCUIElement coordinate APIs.
- Snapshots on a warm runner: 60-120ms — so the transport/session is capable of sub-100ms round-trips; the tap path specifically is ~8-10× a snapshot.
- Crucible already sends `settle: false`.

## Hypotheses to test (ranked)

1. **The app-guard re-check** runs a foreground query (SpringBoard/frontmost app) before every act — a separate IPC round-trip that could be cached or skipped when the previous command just succeeded on the same app.
2. **XCUICoordinate tap ceremony** — coordinate resolution + synthesis through the XCTest accessibility bridge is heavier than a synthetic touch event at the HID layer. A raw touch path (if the runner supports one) could be ~100ms.
3. **Per-command response building** — response assembly/serialization overhead in the runner's command loop (check whether `ok=1` completion is emitted before or after result serialization).

## Benchmark protocol

1. Instrument: timestamp at ACCEPTED, at guard-pass, at element-resolve, at event-delivery, at COMPLETED. One run of 50 taps on a static screen (Settings or app home), report p50/p95 per phase.
2. A/B the guard: guard-on vs guard-skipped (env-gated), same 50 taps.
3. A/B the primitive: XCUICoordinate tap vs the cheapest available alternative (synthetic event / HID), same screen, assert the tap still lands (screen changes).
4. Regression bar: the full Crucible privacy-policy template passes 7/7 with the faster path, both sims.

## Constraints

- The runner is shared infrastructure (alloy + other consumers): changes must be behind contract tests; the interaction-guarantees taxonomy applies (`packages/contracts/src/interaction-guarantees.ts` — classify any new fast path).
- Fast paths that succeed where the shared rules would refuse are the known failure class (AGENTS.md: "Delegation on error proves no success-path parity") — the fast path must be provably same-semantics, not just faster.
- No behavior change for failures: timeout/error surfaces identical.

## Handoff

Implement in the device-daemon repo (runner under `packages/platform-apple/src/runner/`, start at `runner-contract.ts`). Acceptance: tap p50 ≤300ms on the benchmark, Crucible template green on both sims, guarantees taxonomy updated for any new path.
