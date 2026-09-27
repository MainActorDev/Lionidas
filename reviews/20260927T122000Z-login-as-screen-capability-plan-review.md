# Review — login as a screen capability plan

- Reviewed plan: `plans/20260927T122000Z-login-as-screen-capability-plan.md` (rev 2, Status: Ready)
- Evidence sources: plan + brainstorm `brainstorm/20260927T120443Z-login-as-screen-capability.md`; code read 2026-09-27 — `shared/src/app-screens.ts:76-100` (validateScreen login block), `server/src/manual/playback.ts` ensure-login handler (:1195+, cfg resolution incl. screen-form branch), `server/src/manual/screen-runner.ts` (arrive/stateHolds machinery), `server/src/routes/app-screens.ts` (replaceRegistry login preservation + emitter), `web/src/pages/ScreensPage.vue` (login-block render), DB row (`auth.login_json`).
- Reviewer scope: paper audit; no implementation executed.

## Verdict: **Needs revision** — one confirmed High defect (F1, data loss in the migration), one High acceptance hole (F2); the architecture itself is right and D4 is cleanly folded.

## Traceability

D1 (capability model) → grammar+storage+playback stages ✔ · D2 (entry dedup) → handler reads screen.entry ✔ · D3 (session dedup) → handler reads states[pointer] ✔ · D4 (explicit pointer always) → validator cross-field + 4-field block + named play-time error ✔. No unapproved commitments.

## Findings

### F1 — HIGH (confirmed defect) — the boot migration can DROP the legacy `entry` while legacy playback still needs it

**Location:** plan §Staged work 1–2 (normalize 5-field → 4-field at boot; legacy `entry` dropped).

**Evidence:** the plan keeps old stored shapes "working (read-time fallback to legacy fields)" — but if the boot migration REWRITES login_json to 4-field, the legacy `entry` field is destroyed and any code path still expecting it (the CURRENT handler reads `cfgRaw.entry` for the inline path; more importantly the twins' runs between server restart and code deploy) breaks. Two writers, one column, no version marker on the READ side.

**Consequence:** a run between migration and new-code deployment resolves entry → empty → entry-tap failure; worse, the rewrite is irreversible (data dropped).

**Correction:** migrate at READ time, not boot time — the playback handler and the GET serializer accept BOTH shapes indefinitely (5-field: entry+session honored as today; 4-field: entry from screen.entry, session via pointer). A one-time REWRITE may happen only when the screen is next SAVED through the new validator (which emits 4-field). No boot migration, no dropped data, no deploy-order coupling. The `login_v2` marker becomes unnecessary.

**Verify:** unit test — a stored 5-field login_json plays through the new handler unchanged; GET round-trips it; saving the screen re-emits 4-field.

### F2 — HIGH (acceptance hole) — no acceptance check that the SESSION check actually derives from the state

**Location:** plan §Staged work 5–6.

**Evidence:** the plan's drill re-runs the twins (fill proven; login VPN-blocked) — none of those exercises the new session-from-state path. The pointer resolution (`states[login.session]` → stateHolds) ships untested against a real run.

**Consequence:** the one behavior that changed semantically (session detection) has no live proof; a wrong resolution would only surface during the first VPN-on login drill, far from the change.

**Correction:** pin an acceptance step that exercises it WITHOUT login: a throwaway case `ensure login (screen: auth)` against a sim state where `logged_in` ALREADY holds (pre-logged session or… none available without VPN) — or, simpler and honest: a unit/integration test constructing the screen-runner with a fixture tree where the state holds, asserting the session poll short-circuits pass. Live-VPN drill stays listed as the eventual end-to-end gate.

**Verify:** the named test exists and pins: state-holds → step passes without fills; state-absent-pointer (pointing at a state the screen lacks) → named validator/play error.

### F3 — MEDIUM — validator cross-field rule needs an ordering statement

`login.session must name one of this screen's states` requires `states` parsed before `login` validation and must not double-error when states itself is malformed. Specify: run the login cross-check only if `states` validated as a mapping (skip with a single "login.session cannot be checked — states invalid" note otherwise). One test for each branch.

### F4 — MEDIUM — UI stage under-specified for the 4th field

The plan renames the block "form controls" with three fields; with D4 it is FOUR fields (session pointer included). The ScreensPage expanded block must render 4 rows (phone/password/submit/session-pointer) — and the pointer's value is a STATE NAME, not an identifier; the label should say so (e.g. `session state`). Panel likewise. Otherwise users will type an identifier into it.

### F5 — LOW — emitter/emitter-tests for the 4-field shape

The yaml emitter (routes/app-screens.ts toYaml login block) must emit the new shape and the round-trip test updated; also its import path (validateScreen) covers both shapes per F1.

## Required plan edits

- F1: replace the boot migration with read-time dual-shape support + save-time re-emit.
- F2: add the fixture-based session-path acceptance (unit) and keep the VPN drill as end-to-end.
- F3/F4/F5: fold into stages 1/4/5 text.

With F1/F2 applied, this is Ready for implementation.
