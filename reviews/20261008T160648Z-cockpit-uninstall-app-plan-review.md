# Review — cockpit "uninstall app" plan

- Plan reviewed: plans/20261008T160648Z-cockpit-uninstall-app-plan.md (Ready, 2026-10-08)
- Evidence: brainstorm/20261008T160648Z-cockpit-uninstall-app.md · decision log
  (operator: "Go with your recommendation…") · code read 2026-10-08:
  server/src/routes/manual.ts (install route 564, apps route 632, open-app
  route ~660, requireRole uses 396/610/855), server/src/manual/apps.ts:55,
  app-install.ts, web/src/components/cockpit/MenuBar.vue,
  web/src/pages/CockpitPage.vue (dispatch 182, run-app modal 242)
- Verdict: **Ready for implementation** — 2 findings folded, 1 disclosed low

## Traceability

All 6 decisions (D1–D6) trace to the operator's prompt or the
"go with your recommendation" closure; happy/sad/edge paths present; T1→T3
order is correct (server contract first, UI second, drill last). Guard stack
matches the verified install-route patterns (Booted check, DEVICE_BUSY runs +
manual-session query — confirmed identical SQL at manual.ts:577-579).

## Findings

### F1 [Medium — folded into plan] role gate asymmetry is bigger than stated

- Location: plan D5 note ("install is session-only").
- Evidence: manual.ts requireRole uses exist (396, 610, 855) but NOT on
  /install, /apps, or open-app (~660) — the whole app-ops family is
  session-only today. The plan's `requireRole('operator')` is stricter than
  its whole family, not just its sibling.
- Consequence: viewer-role users can install/launch but not uninstall —
  defensible, but the asymmetry should be a stated product decision, not an
  accident. Also: bots pass operator-tier (roles.ts) — a bot CAN uninstall.
- Correction (folded): D5 note updated — deviation is from the entire app-ops
  family; bot-passes-operator is recorded as accepted (bot actions are
  audited under their own identity).
- Verify: plan text updated; no code change needed.

### F2 [Medium — folded into plan] missing audit/action trail

- Location: plan T1.2 — no mention of logging the uninstall.
- Evidence: the repo's convention is an audit line for destructive ops
  (auth_log pattern; install writes app activity via installApp's result).
- Consequence: an app vanishing from a shared device would be
  unattributable.
- Correction (folded): T1.2 gains an audit INSERT (device, bundleId, operator
  identity from req.user) after success.
- Verify: server test asserts the audit row exists post-uninstall.

### F3 [Low — disclosed, nonblocking] device-shutdown race

- Location: plan Sad path (device shuts down mid-flow).
- Evidence: Booted check reads the devices table; simctl can still fail if
  the device shuts down between check and exec.
- Consequence: a 502 with simctl's honest stderr — already the plan's
  failure mapping. No correction needed; disclosed so the implementer maps
  that 502 copy sensibly ("device may have shut down").

## Questions for the operator

None — the plan's decisions are all closed; F1/F2 corrections are factual
hygiene, not new choices. (If you want uninstall to be session-only like its
family instead of operator-gated, say so before T1.)

## Necessary edits (applied to the plan by this review)

- D5 note rewritten (F1); T1.2 gains audit INSERT (F2).

## What this review cannot certify

Paper review only. Correctness of the simctl invocation, guard ordering,
modal UX, and no-regression on install must be proven by the T1 tests, T2 web
tests, and the T3 live drill (uninstall real app → gone; com.apple.* → 403;
restore). No performance claims to inspect. Security: the server-side
com.apple.* gate is the load-bearing control — its test coverage in T1
(happy, system-app 403, viewer 403, busy 409, booted 409, simctl 502) is the
right set; no further lenses applied (no privacy/compliance surface).
