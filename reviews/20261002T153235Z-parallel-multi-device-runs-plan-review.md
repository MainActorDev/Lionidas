# Review — Multi-device control + parallel runs plan

- Plan reviewed: `plans/20261002T153235Z-parallel-multi-device-runs-plan.md` (Ready, commit `e749904`)
- Evidence: plan + source brainstorm (`54fac6a`) + live code grounding on `feat/device-cockpit` @ `7a5f491` + the live two-device drill (same session)
- Verdict: **Ready for implementation after applying F1 (rev 2)**

## Findings

### F1 — R2's premise is wrong (in our favor): the prune guard ALREADY exists — plan must be corrected
**Severity: High (changes scope/stages, not direction).**
The plan states `prunePreviousRunArtifacts` "currently keys on ticketKey only … B's prune [deletes] A's in-flight artifacts" and stages a code fix (R2/Stage 1). Grounding shows `server/src/evidence/retention.ts:29-31` already filters `finished_at IS NOT NULL` — a still-running previous run is NEVER pruned — and `server/test/evidence-retention.test.ts:60` explicitly tests "never prunes a still-running previous run". Same-ticket parallel runs are therefore already evidence-safe.
Correction: delete R2/Stage 1 as a code change; keep one drill assertion (both runs' evidence intact) folded into Stage 3. Stage renumbering: R1 (session map) becomes Stage 1 — it is also the operator's immediate pain, so this correction improves sequencing.

### F2 — Plan cites the wrong route for fan-out
**Severity: Medium (would mislead the implementer).**
R4 says "`POST /api/queue` accepts `udids[]`". No such POST route exists: queue insertion happens at `POST /api/runs` (`server/src/routes/runs.ts:24`, `requireRole('operator')`, single validated `udid`, returns `{queueId}` 202). The fan-out belongs there (or a sibling route). Correction: R4 targets `POST /api/runs` with `udids?: string[] | allBooted?: true` → N specs, N `enqueue` calls, response `{queueIds: [...]}`; pre-flight validation (flowsDir/artifact/device) runs once, device existence per-udid. Note the operator-gated preHandler carries over.

### F3 — Same-template parallel guard blocks a legit fan-out path
**Severity: Medium (functional gap in R4).**
`server/src/manual/playback.ts:423` refuses a second queued/running run of the same `template_id`. Template-driven plays (the cockpit picker uses `/api/templates/:id/play` → runBatch) would reject the second device of a same-case fan-out even though devices differ. Correction: scope that guard per-device (`AND device_udid = ?`) — different devices running the same template concurrently is exactly the feature. Check its test for intent before changing.

### F4 — No API lists open manual sessions; R1 needs one (small)
**Severity: Medium.**
The session map's "live dot + honest expiry" needs per-device session state on (re)load, but no route lists open `manual_sessions` (grounding: only internal `finished_at IS NULL` checks exist; `devices.lease_holder` exists on the devices table but the cockpit doesn't consume it for sessions). The heartbeat route exists (`/api/manual/:id/heartbeat`, manual.ts:233) for keeping a session alive. Correction (add to R1): server gains `GET /api/manual/sessions` → `{sessions: [{id, udid, operator, startedAt, lastActivity}]}` (operator-gated); the cockpit hydrates the map from it on mount and on device-list refresh. Expiry honesty: the 5-min idle watchdog (`startIdleWatchdog`, session.ts:438) finishes stale sessions; a revisited tab whose session was reaped shows the existing session-lost state — probe on tab activation via the sessions list, no per-switch ping.

### F5 — Heartbeat must run per active session, not per visible stage
**Severity: Low.**
The watchdog reaps sessions idle > 5 min; today the wall pings the heartbeat only while driving the visible device. With background sessions (the whole point of R1), a background tab's session must stay alive: either the page heartbeats every entry in the map on an interval, or the operator accepts 5-min background expiry. Plan says "watchdog honesty" but not which. Recommendation (plan should state it): page-level heartbeat loop (30s) for all map entries while the cockpit is open — that is the "control persists across tab switches" semantics the operator asked for; tab-close of a device releases its entry (already planned).

### F6 — StageBezel statelessness is understated (implementation risk, not design flaw)
**Severity: Low.**
R1 says the stage "becomes stateless rebinder". Grounding: StageBezel currently owns stream lifecycle, tap chain, fast-path frames, bezel chrome, inspect bridge, zoom — all keyed off its own `sessionId`. Rewriting it to full statelessness in one stage is the riskiest edit in the plan. Mitigation (add to R1 acceptance): the stage may keep per-mount local state IF the page re-mounts it per udid via `<StageBezel :key="activeUdid">` — switching tabs then reconstructs cheap local state while the PAGE map owns the durable session handle. That preserves all existing stage behavior and shrinks the diff dramatically. Acceptance stays behavior-level (chip live after switch, taps dispatch).

### F7 — Minor factual corrections
- Plan says watchdog is "5-min idle" ✓ (IDLE_TIMEOUT_MS, startIdleWatchdog session.ts:438) — verified.
- Dispatcher parallelism claim ✓ (overlapping ticks, per-device busy set) — verified.
- R4's "Wall/runs view already renders per-device rows; no change" — plausible, unverified; low risk either way.

## Questions
None blocking — F1's correction is direction-preserving and F2–F6 have concrete corrections the plan revision should adopt.

## Verdict
**Ready for implementation as rev 2** — apply: drop R2 as code work (keep drill assertion), renumber R1 first, retarget R4 to `POST /api/runs`, per-device same-template guard, add `GET /api/manual/sessions` + page-level heartbeat decision (F5 recommendation), and permit the `:key`-remount implementation shape (F6).
