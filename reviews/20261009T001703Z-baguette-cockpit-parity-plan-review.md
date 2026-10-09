# Review — Input verbs Stage-1 plan

- Plan reviewed: `plans/20261009T001703Z-baguette-cockpit-parity-plan.md` (Ready, 2026-10-09)
- Evidence: baguette source (`../baguette/Sources/...`), agent-device source
  (`../agent-device/src/...`), alloy source, Lionidas source — all read
  2026-10-09. Brainstorm `20261009T001703Z-baguette-cockpit-parity.md` + its
  decision log.
- Verdict: **Needs revision** — one High finding (paste path disproven from
  source) requires a plan edit before implementation. Everything else is
  sound; findings F2–F6 are disclosures or T0 hardening, not blockers.

## What was verified against source (this review, not the plan's claims)

- Child = baguette binary, spawned by supervisor (`supervisor.ts:16`), wire
  dialect + `/input` HTTP route in daily use by manual drive. ✓
- Shake HTTP route exists: `Server.swift:224` (`POST /simulators/:udid/shake`). ✓
- `Key` gesture registered for the HTTP path (`GestureRegistry.swift:57`),
  accepts W3C `code` + `modifiers:["command"]` (`Key.swift:9-19`). ✓
- `touch1` phased gestures registered (`GestureRegistry.swift:59`) and already
  in Lionidas `POSITIONAL_KINDS` (`engine-input.ts:60`). ✓
- Engine A `press` carries `doubleTap` flag through the daemon interaction
  route (`interaction-touch-press.ts:211`, admission `:135`, safe-flag spec
  `session-event-action.ts:376`). ✓ (MCP tool schema acceptance still T0/T3.)
- Alloy `longpress` + `durationMs` already registered
  (`registrations.ts:209-213`, `adapter-a.ts:49`). ✓

## Findings

### F1 — HIGH — paste over the HTTP `/input` route cannot work (plan §Verified-facts 3, §T0(b), §Architecture table)

**Evidence**: the HTTP input route dispatches straight to
`GestureDispatcher.dispatch` (`ServerPluginRoutes.swift:270-284`) — no
`PasteDispatch` interception. `Paste` is not a registered gesture
(`GestureRegistry.standard`, `GestureRegistry.swift:51-60` — no Paste), and
`Paste.swift:20-26` states paste "is not a Gesture" precisely because the
sync registry can't reach the async pasteboard. `PasteDispatch` runs only on
the WS path (`Server.swift:2600`) and stdin (`InputCommand.swift:60`).
Sending `{"type":"paste"}` over HTTP returns a parse error, not a paste.

**Consequence**: the plan's primary paste path fails; T0 would discover it,
but the plan's stated fallback (exec the baguette binary per paste) spawns a
process per keystroke-class action (~150–300 ms startup per baguette's own
double-tap.md analysis) and depends on the sibling repo checkout at runtime.

**Required correction** (all primitives verified this review): compose paste
in Lionidas from two proven pieces —
1. `execFile('xcrun', ['simctl','pbcopy',udid])` with text on stdin (same
   host-exec pattern as the existing uninstall route + its test shim; this is
   baguette's own `SimctlPasteboard.swift:32` recipe), then
2. `{"type":"key","code":"KeyV","modifiers":["command"]}` over the existing
   child HTTP input route (Key is registered; this is baguette's own
   paste.md:43 server-side recipe).
   `press:false` variant = step 1 only. Replace the T1 paste helper and the
   architecture table row; drop the binary-exec fallback.

**Verify**: T0 probe = pbcopy + KeyV lands non-ASCII text in a focused field.

### F2 — MEDIUM — busy-ack is mislabeled as INPUT_TIMEOUT

**Evidence**: child returns HTTP 200 with `{"ok":false,"error":"device
busy…"}` when the per-sim input gate is held (`ServerPluginRoutes.swift:261,
274`); Lionidas `assertAck` (`engine-input.ts:117-119`) throws INPUT_TIMEOUT
for any `ok:false`.

**Consequence**: a gate collision during the timed touch1 sequence (or the
paste keystroke racing a straggler) surfaces as a timeout lie; drills
mislead. Correction: `assertAck`/engineInput should surface the child's
error text (new error kind or message passthrough) — fold into T1. Verify:
unit test feeding a busy ack expects a "device busy" error, not INPUT_TIMEOUT.

### F3 — MEDIUM — double-tap cadence claim needs a T0 measurement gate

**Evidence**: plan asserts loopback RTT ≪ 250 ms recognizer window; each HTTP
POST executes its HID dispatch synchronously before the ack
(`ServerPluginRoutes.swift:278-283`, MainActor hop). Cadence = sleep + real
dispatch time; nothing measures the per-event dispatch cost.

**Consequence**: if dispatch costs approach ~40+ ms/event, four POSTs can
crowd the window on slow frames and the recognizer misses. Correction: T0(c)
must RECORD the observed tap-1-up→tap-2-down gap from the ack timestamps and
fail the probe if the measured gap exceeds ~120 ms (leaves recognizer
headroom); keep the plan's WS fallback if it fails. This is a probe-criteria
addition, not a redesign.

### F4 — MEDIUM — alloy `doubleTap` plumbing is schema-dependent, order is right but check early

**Evidence**: alloy adapter `press` type lacks `doubleTap`
(`adapter-a.ts:48`); whether engine A's MCP tool input schema accepts the
field is unverified; plan defers the strictness check to T3.
**Consequence**: if the tool schema is closed, the alloy PR is more than
"2-line" (type + tool input schema + fixtures). Correction: move the
schema-strictness check (`defineToolFromRow` + engine A tool schema) into T0
as a read-only inspection — cheap, and it sizes T3 honestly.

### F5 — LOW — shake is iOS-only by design

**Evidence**: `shake.md` "Platform scope": watch/tv/CarPlay fail cleanly.
**Consequence**: none for Stage 1 (iOS sims only in the fleet); note in the
case-DSL docs so a future multi-platform fleet isn't surprised.

### F6 — LOW — paste requires a focused first-responder

**Evidence**: Cmd+V pastes into whatever is first-responder (`paste.md`,
`Paste.swift` docs). Plan documents the tap-field-first authoring rule —
keep it; add a playback-time note in the step `reason` when paste acks ok
but no field was tapped this run (cheap guard, optional).

## Coverage / traceability

Every brainstorm Stage-1 verb traces to a plan task and an acceptance check
(double-tap→T0(c)/T1/T4, long-press→T1/T4, shake→T0(a)/T1, paste→T0(b)/T1);
boundary-safety traced to the existing child-spawn + allowlist facts;
Stage-2 exclusion matches the decision log. The one untraced claim was the
paste HTTP path — F1.

## What this review could not certify on paper

Cadence feasibility (F3) and engine-A schema acceptance (F4) are execution
properties — both are correctly placed in T0 probes by the plan (with F3's
criteria sharpened). The verdict is a plan-quality verdict, not a
certificate that the implementation will pass its drills.

## Required plan edits before implementation

1. F1: replace paste dispatch with the pbcopy + Cmd+V composition (T1
   helper, architecture table, T0(b) probe); drop binary-exec fallback.
2. F2: add busy-ack passthrough to the T1 helper contract + test.
3. F3: add the ≤120 ms measured-gap criterion to T0(c).
4. F4: move the alloy/engine-A schema inspection into T0.

**APPLIED to the plan 2026-10-09** — all four edits are in
`plans/20261009T001703Z-baguette-cockpit-parity-plan.md` (verified-facts §3
rewritten, architecture paste row + busy-ack paragraph, T0(b)/(c)/(e)
criteria, T3 sizing, edge-case additions). With F1–F4 resolved, no open
findings block implementation; verdict for the revised plan: **Ready for
implementation**.

## Questions for the operator

None blocking — the edits above follow from verified source. Confirm and
I'll apply them to the plan, then implementation can start at T0.
