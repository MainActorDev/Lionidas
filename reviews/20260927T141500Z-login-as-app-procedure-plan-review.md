# Review — login as an app-level procedure plan

- Reviewed plan: `plans/20260927T141500Z-login-as-app-procedure-plan.md` (Status: Ready, 2026-09-27T14:15:00Z)
- Evidence sources: plan + brainstorm `brainstorm/20260927T140000Z-login-as-app-procedure.md`; code read 2026-09-27 — `server/src/manual/playback.ts` (ensure-login handler :1240-1330 incl. the v2 entry join, settleFind entry consumption :1330, sessionHolds), `shared/src/case-yaml.ts:42,47` (screen? on step+ensureLogin), `server/src/routes/app-screens.ts` (routes incl. screen-level login GET/PUT/DELETE, replaceRegistry), `web/src/pages/ScreensPage.vue` + `web/src/components/ScreenDocPanel.vue` (login chrome inventory).
- Reviewer scope: paper audit; no implementation executed.

## Verdict: **Needs revision** — one confirmed Critical (F1: the plan's entry claim is false against the code it cites), one High (F2: D2 promised in the grammar is deferred without saying what `ensure login` remains), two Medium. The architecture (procedure table + own surface + non-destructive bridge) is right and directly answers the operator's three complaints.

## Traceability

D1 → model + Stage 1 ✔ · D2 → **out of scope'd** (screen precondition reference deferred) — acceptable as phasing but see F2 · D3 → Stage 2 legacy fallback + Stage 3 remove-only-on-login-surface ✔ · D4 → Stage 3 ✔.

## Findings

### F1 — CRITICAL (confirmed defect) — "entry via existing arrive machinery" is not what the code does; multi-step procedure entries are LATENT BROKEN today

**Location:** plan §Stage 2 ("entry via existing arrive machinery") + §Model (entry as full entry object).

**Evidence:** the current ensure-login handler consumes `cfg.entry` as ONE selector via `settleFind(cfgResolved.entry)` (playback.ts:1330) — a single identifier/label, one tap. My earlier v2 implementation did NOT route through arrive: it joins multi-step navigate entries with `'>'` into one string (playback.ts:1248: `e.navigate.map(st => st['on']).join('>')`) — a string no AX tree will ever match. The drill passed ONLY because `auth`'s entry is a single step.

**Consequence:** the first app-procedure whose entry is genuinely multi-hop (the whole point of D1-era work) fails at the entry tap with "selector a>b never appeared". The plan ships a second latent bug of the same species as the one being fixed.

**Correction:** Stage 2 must specify a real entry player: when the procedure's entry is a `navigate` list, play each step through the SAME resolver the screen-runner's navigate branch uses (poll + unique-match, already battle-tested in run_32a8ff19), inside the ensure-login handler; `tab`/`deepLink` keep the single-selector path. Acceptance: a procedure entry of ≥2 steps reaches the form (fixture test asserting per-step resolution, plus the live drill).

**Verify:** unit test with a 2-step navigate entry asserting two distinct tap dispatches (not one join).

### F2 — HIGH (spec gap) — after this change, what does a CASE write? The grammar's story is incomplete

**Location:** plan §Stage 2 (screen: arg deprecated) vs §Out of scope (screen precondition reference deferred).

**Evidence:** the plan says cases keep "env refs" and `screen:` is ignored — but never shows the resulting case grammar. Two possibilities: `ensure login: {phone: …, password: …}` (screen-less) or the old form with a deprecation note. Also D2's own promise ("screens reference it as their steps") has NO representation in this change at all — fine as phasing, but the plan should say explicitly that after this change the ONLY reference form is the case's `ensure login` (screenless), and the screen-precondition grammar is a future card with its own brainstorm.

**Consequence:** an implementer must invent the case-side grammar mid-build; validators (case-yaml parse: screen XOR inline) currently REQUIRE `screen:` or the 5 inline selectors — a screenless, selector-less step with only phone/password fails validation today (`needs entry/phoneField/…`).

**Correction:** Stage 1 grammar work includes case-yaml: the screenless form `ensure login: {phone: '${env…}', password: '${env…}'}` becomes VALID (resolves the app procedure); the `screen:` form keeps parsing with the deprecation note; inline 5-field stays for legacy. Pin with parse tests.

**Verify:** parse test for the screenless form; validator error for a step with neither form.

### F3 — MEDIUM — Stage 3's "ALL login chrome removed" understates the blast radius

`ScreenDocPanel`'s login section, `showLoginSection`, `appHasLogin`, and `loginOf/hasLogin/loginTitle/login-block/login-chip` in ScreensPage all reference screen-level login; the screens validator (Stage 1) will REJECT any yaml still carrying it, so the panel must stop emitting it in the same change or every screen save 422s after an edit touches a stale doc. Specify: panel docToForm/formToDoc drop the login section entirely in this change (the procedure panel owns it), and the emitter stops emitting screen-level `login:` (legacy rows still READ via fallback per Stage 2). One sweep test: save every existing screen through the panel after the change → no 422.

### F4 — MEDIUM — `app_login` revision/concurrency under-specified

The table has `revision` but the plan doesn't say what it guards. The login panel save should follow the registry pattern (read revision → PUT with revision → 409 on drift), and `verify.screen` referencing a screen DELETED later must not cascade — the cross-field validation happens at save; playback already errors named-ly when the state is missing. State both in Stage 1/2.

## What was inspected vs needs execution

Inspected on paper: resolution code paths (the F1 join hack verified by reading), route surface collisions (none — new path distinct), validator grammar interplay, UI chrome inventory. Requires execution: the F1 two-step entry drill, panel save/no-422 sweep (F3), 409 drift (F4), and the standing VPN gate.

## Required plan edits

- F1: real multi-step entry playback spec + fixture/live acceptance.
- F2: screenless case grammar in Stage 1 with parse tests; explicit note that screen-precondition is a future card.
- F3: panel/emitter de-scope of screen-level login in the same change + no-422 sweep.
- F4: revision-guarded save + no-cascade statement.
