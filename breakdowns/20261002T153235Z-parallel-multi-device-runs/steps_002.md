# Step 2 — Parallel-runs drill + dispatcher regression test

- **Status:** Ready
- **Plan:** rev 2, R3 (+ R2's drill assertion: both runs' evidence survives)
- **Repo:** after Step 1 · **Depends on:** Step 1 (two controllable devices help the drill; code-wise independent) · **Handoff:** Step 3

## Goal

Two automated runs execute on two devices with overlapping `running` windows; both finish honestly; both runs' evidence rows/files remain (same ticket AND different ticket cases).

## 1. Dispatcher regression test (no live devices needed)

`server/test/queue-parallel.test.ts` (new; reuse the fake-runner pattern from existing queue tests — find them via `grep -rl nextDispatchable server/test/`):

- Seed two waiting entries with DIFFERENT udids; stub `executeRun` to return a promise that resolves only when the test lets it (deferred).
- Call `dispatchTick` twice WITHOUT awaiting the first. Assert both entries reach `dispatched` and both `executeRun` stubs were invoked (overlapping dispatch = per-device parallelism).
- Contrast case: same udid twice → second tick must NOT dispatch while the first run row is `running` (busy set).

## 2. Live drill (two booted sims, same ticket twice + once different-ticket)

Using the PAT from `server/.env` and the existing smoke template (the `tpl_*` from the record drill, or the cockpit-drill template `tpl_8d98c7ec`; find a passing one via `lionidas case list` or `/api/templates`):

a. POST `/api/runs` twice — SAME `ticketKey`, different `udid` (device A + B), same flowsDir/artifact.
b. Poll `/api/runs?status=active`: capture a moment where BOTH rows are `running` simultaneously (timestamp it — that's the overlap proof).
c. After both finish: `sqlite3 server/crucible.db "SELECT id, status FROM runs WHERE ticket_key='<T>' ORDER BY started_at DESC LIMIT 2"` → both present; `SELECT COUNT(*) FROM evidence WHERE bundle_id IN (<runA>,<runB>)` → evidence for BOTH non-zero (R2 net).
d. Repeat once with different tickets if time allows (sanity).

If (b) never overlaps — STOP and report the observed serialization (engine or dispatcher); do not "fix" without a finding. The taps drill already proved dispatch-layer concurrency; runs add install+flow.

## 3. Record + commit

Drill transcript (commands + timestamps + query outputs) into the commit message. No product code changes expected in this step unless the drill exposes a defect — then fix at cause with a test and note it.

## Gates

server vitest green (new test included) · no web changes · commit `test(server): parallel dispatch regression + live two-device drill (steps_002)`.
