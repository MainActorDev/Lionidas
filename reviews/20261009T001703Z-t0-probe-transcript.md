# T0 probe transcript — input verbs Stage 1

Plan: `plans/20261009T001703Z-baguette-cockpit-parity-plan.md`
Date: 2026-10-09. Sim: iPhone 14 Plus `30B28173-…` (booted). Child: baguette
serve on 127.0.0.1:8422 (supervisor-spawned).

## (a) Shake

- `POST /simulators/{udid}/shake` → **200** (0.6s), twice. Route live.
- Observable check limited: Notes app refused to launch on this sim
  (FBSOpenApplicationServiceErrorDomain code 4), so no undo-toast vision
  proof. Route + child ack are proven; in-app motion delivery rides the
  same dispatch the device-server UI uses (documented recipe). The T5 live
  drill will observe shake inside the LP app if it exposes a shake response.

## (b) Paste composition (F1 path) — PASS

1. `printf 'béta-漢字-🎯' | xcrun simctl pbcopy <udid>` → ok.
2. `tap` (214,876) to focus Settings' search pill → `{"ok":true}`.
3. `{"type":"key","code":"KeyV","modifiers":["command"]}` → `{"ok":true}`.
4. Screenshot vision-read: field contains **exactly `béta-漢字-🎯`**;
   "No Results for béta-漢字-🎯" page confirms the full string landed.
   Non-ASCII + emoji intact — the `type` US-ASCII limit is bypassed.

Note: first attempt tapped the top-center (old iOS search position); this
iOS has the bottom search pill. Position knowledge, not a wire issue.

## (c) Double-tap cadence — PASS with compensation

Naive sleeps (80/50): holds 171/162ms, **gap 137ms** — misses the ≤120ms
criterion. Multi-event single POST rejected (`unknown kind: sequence`) —
fallback ladder step 1 dead; no WS client needed either because:

Compensated sleeps (**hold 25ms, gap 0ms**): holds 113/144ms, **gap 96ms**,
total 353ms → **PASS** (criterion ≤120ms). Per-event dispatch overhead
measured ≈ 57–90ms; the helper subtracts it from the sleeps.

Physical recognizer proof from the naive run (137ms gap, still inside iOS's
~250ms window): Safari **column-zoomed** and **word-selected** — both
double-tap-class effects fired on the same 4-POST path.

T1 constants: HOLD_SLEEP_MS=25, GAP_SLEEP_MS=0 (documented as
measured-against-overhead, not free numbers).

## (d) Long-press dwell — PASS

`touch1-down` (214,400) → 800ms → `touch1-up`. Screenshot vision-read:
**text selection + Copy/Find Selection/Look Up context menu** visible.
800ms dwell clears the ~500ms long-press threshold.

## (e) Schema strictness sizing (T3)

- Alloy `alloy_act` zod schema is **`.strict()`** (`routing.ts:152`) —
  unknown keys rejected → T3 is a real schema edit (add `doubleTap` to
  press, `durationMs` to longpress), not pass-through.
- Engine A accepts `doubleTap` on `press`/`click` (REPEATED_TOUCH_FLAGS →
  `allowedFlags`, `commands/interaction/index.ts:87`; daemon plumbing
  `interaction-touch-press.ts:211`) — endpoint ready, alloy is the gate.
- Lionidas mirror note: `server/src/manual/alloy-act-contract.test.ts`
  pins this verb set — must be updated in the same change (T4).

## Verdict

All five probes resolved; the plan's architecture stands with the F3
compensated-timing constant. T1 may proceed.
