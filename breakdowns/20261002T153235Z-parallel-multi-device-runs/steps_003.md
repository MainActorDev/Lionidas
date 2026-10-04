# Step 3 — Multi-device fan-out: API + per-device template guard + cockpit action

- **Status:** Ready
- **Plan:** rev 2, R4 (route corrected per review F2/F3)
- **Repo:** after Step 2 · **Depends on:** Step 2 (parallelism proven) · **Handoff:** PR

## Goal

One action queues a case on every booted device; same template may run on different devices concurrently.

## 1. `POST /api/runs` fan-out

`server/src/routes/runs.ts:24` (operator preHandler already there):

- Accept additionally: `udids?: string[]` or `allBooted?: true` (mutually exclusive with each other; `udid` remains the single-device form — all three at once → 400).
- `allBooted` → resolve from the devices table: `SELECT udid FROM devices WHERE state='Booted'` (empty → 400 "no booted devices").
- Pre-flight validation (flowsDir scan, artifact existence) runs ONCE; per-udid: device-exists check; then N `enqueue` calls with identical specs except udid.
- Response: `{ queueIds: string[] }` (202). Single-udid path unchanged (still `{ queueId }`).

Test (`server/test/runs-fanout.test.ts`): single-udid backward compat; `udids:[a,b]` → 2 queue rows, 2 queueIds; `allBooted` with 2 booted seeds → 2 entries; unknown udid in list → 400 with the offending udid named; both-fields → 400.

## 2. Per-device template guard

`server/src/manual/playback.ts:423`: add `AND device_udid = ?` to the `SELECT 1 FROM runs WHERE template_id = ...` guard (param = the target udid). First READ its existing test (`grep -rn "already" server/test/*.ts | grep -i template` style) and update intent: same template + SAME device still blocked; same template + different device now allowed.

## 3. Cockpit picker action

`CockpitPage.vue` play-case modal: add a checkbox row "run on all booted devices (N)" (N = booted count from the switcher's source list — the full booted list, not just open tabs). When checked, POST the fan-out body (find what the single play posts today — it uses `/api/templates/:id/play`; for fan-out prefer the queue route with the template's spec if the play route is template-only — INSPECT `/api/templates/:id/play` handler first and choose: extend the play route with `udids[]` mirroring Step 1's shape if the picker flows through it. Whichever route the picker actually uses gets the fan-out param; do not build both). Toast "queued on N devices".

## 4. Live drill

Two booted sims → picker → "all booted" → both runs queue + run (overlap per Step 2 semantics) → toast correct count. Same-template guard: while run on A is running, template-play same case targeting A errors (unchanged), targeting B proceeds (new).

## Gates

server vitest + web tests + builds · commit `feat: multi-device fan-out (steps_003)` · then the standard PR flow (create-only).
