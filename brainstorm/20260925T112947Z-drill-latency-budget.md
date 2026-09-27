# Why a mocked-API drill still takes seconds per swap — and the path to fast + precise

- Source prompt: "If we were using proxy for the mocked API response why the loading time still significant? Why not like blink of an eye?" → follow-up: "The end goal is I want for the test runner to be really fast and precise. I've seen AI-driven UI testing doing it fast, but I don't think it's because of the LLM at all"
- Created: 2026-09-25T11:29:47Z (revised 11:40Z — source-verified budget; goal sharpened to fast+precise)
- Status: Direction selected (event-driven observation; staged ladder below)

## Goal and context

First question answered by autopsy: the proxy is NOT the cost. Second question sets the goal: the runner should be **fast and precise**, and the user hypothesizes fast AI-driven UI testing is fast because of the driver's synchronization primitive, not the LLM. This revision confirms that against Crucible's own source and lays the migration path.

## Confirmed inputs and decisions

Measured facts from `run_b5207d00` (crucible.db, 2026-09-25):

- Step durations: `refresh home` **3.93s / 3.99s**; `expect screen` **2.19–2.34s**; `arrive home` 0.56s; `swap my` ~0ms (DB write only).
- Traffic rows for the SAME steps: proxy latency_ms = **0, 1, 2ms**; status 200. The mock answers in single-digit milliseconds.
- App's real signal→fetch latency: a few hundred ms (traffic rows land ~0.5–1s after the Darwin post).

Source-verified budget (server/src/manual/*, 2026-09-25) — every wait is a sleep-poll loop with coarse granularity:

- `screen-runner.ts:55` `worldConfirmPollMs: 500` — GUARD 1 polls SQLite for the confirming traffic row every 500ms (budget 10s)
- `screen-runner.ts:56` `statePollMs: 1000` — waitBack/arrive poll declared states every 1000ms
- `playback.ts:754` `CRUCIBLE_EXPECT_POLL_MS ?? 2000` — expect's settle loop polls every **2 seconds**
- `playback.ts:856` step settle poll 60ms (fine) with 8s budget; `awaitUiStable` 60ms ticks capped at `CRUCIBLE_UI_STABLE_MS ?? 1500`
- So `refresh home` ≈ signal post + app fetch (~0.5s) + **half a worldConfirm tick of quantization** + follow-on stability/evidence waits; `expect screen` ≈ up to 2s of pure poll granularity before the (already-correct) predicate is even evaluated.

User-confirmed: end goal = fast AND precise; skeptical that LLM is what makes other AI-driven UI tests fast.

## Exploration

### Why fast drivers are fast (user's hypothesis, confirmed)

XCUITtest-class speed comes from synchronization primitives, not intelligence: AX-tree change notifications, idling-resource callbacks (the APP tells the harness when it's idle), pushed diffs instead of re-polled snapshots. AI agents riding those drivers inherit the speed; the LLM only picks actions. Crucible currently uses NONE of these — it sleeps and re-checks, so every wait is quantized by tick size and pays worst-case alignment.

### The migration ladder (cheapest first)

1. **Tune the poll constants (hours, zero risk).** expect 2000→250ms, state 1000→250ms, worldConfirm 500→150ms. Same predicates, finer granularity; worst case is a few extra SQLite/AX reads. Expected: expect steps 2.2s→~0.5s; drill ~15s→~7–8s.
2. **Push-based GUARD 1 (small, Crucible-only).** mitm writes the traffic row synchronously on response (manager.ts insert) — the refresh verb should await an EventEmitter emit instead of polling the table. Confirmation latency drops to the app's true fetch time (~0.3s). No app change.
3. **App-ack channel (structural; uses the seam we just shipped).** Bellwether posts Darwin signals INTO the app; the same channel can carry an ACK BACK (e.g. `com.crucible.refresh.<screen>.done` posted by the modifier's handler after the store drains). Runner flow becomes: post-signal → await ack → screenshot — no polling at all. Refresh+expect pair drops from ~6.2s to well under 1s. Needs Bellwether 0.4 (ack post), a sim-side listener (the device daemon notifyutil observe), runner wiring.
4. **AX-diff subscription (driver-level).** the device daemon pushes hierarchy changes instead of the runner re-snapshotting; generalizes awaitUiStable's 60ms tick into a stream. Benefits every template, not just screen-state ones. Biggest lift; belongs with the alloy runtime work.
5. **Keep deliberate slowness where it's correctness**: launch readiness gate (terminate+reopen), alert/dialog drains, the 250ms abort-latency floor (B2). Event-driven is faster BECAUSE it waits for the exact event, not despite waiting — fast never means racing animations.

Risks: (3) couples speed to seam coverage (screens without the ack fall back to polling — tiered, fine); (4) touches the shared alloy/the device daemon surface; every stage keeps env-var budgets as ceilings so worst case degrades to today's behavior, never hangs.

## Open questions

1. Approve stage 1+2 (constants + push-based guard) as one Crucible-only PR now, or go straight to designing the ack channel?
2. Stage 3 ack semantics: posted by the modifier's handler after `sendAndDrain` of the refresh intent (precise, seam-scoped — recommended) vs after next render pass (more SwiftUI-coupled)?
3. Land step-timing telemetry (wait-vs-work split) first so speedups are provable in the run report? Recommended: yes — tiny, makes every stage measurable.

## Next step

Pick the stage boundary (recommend 1+2 immediately, 3 designed next); implement behind the existing env-var budget pattern with tests; measure against run_b5207d00 as the baseline drill.
