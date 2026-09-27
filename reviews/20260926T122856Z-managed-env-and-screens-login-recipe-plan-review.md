# Review — managed env values + screens-held login recipe plan

- Reviewed plan: `plans/20260926T122856Z-managed-env-and-screens-login-recipe-plan.md` (Status: Ready, 2026-09-26T12:32:45Z, incl. the 5.0 sketch-gate amendment)
- Evidence sources: plan + brainstorm `brainstorm/20260926T122856Z-managed-env-and-screens-login-recipe.md`; code read 2026-09-26 — `shared/src/yaml-variants.ts:131`, `server/src/manual/playback.ts:641,761,1139`, `server/src/routes/manual.ts:457-510,613-712,849-905`, `server/src/db/schema.ts`, `server/src/db/client.ts:14`, `server/src/index.ts:66-84`, `server/src/auth/roles.ts:85-102`, `shared/src/case-yaml.ts:392-412`, sqlite `.schema app_screens/plans/suites/runs`
- Reviewer scope: paper audit of the plan against current code; no implementation executed.

## Verdict: **Needs revision**

> **POST-REVIEW UPDATE (2026-09-26, later):** the two human questions were answered —
> F5: "New" (full `auth` screen row); F1: variant stays narrowest ("Of course, keeping
> variant wins"). Plan rev 2 applies F1–F8. With the owner decisions resolved and the
> confirmed High defect corrected in the plan text, the revision gate is satisfied:
> **rev 2 is ready for implementation**, contingent on the F1 fix landing as the Stage-2
> unit tests (not prose) and F5's full-row seed passing the NOT NULL columns.

One confirmed High defect (F1) — the plan's own code-level claims are wrong in two ways — plus four Medium findings. The architecture (env_vars scopes + login_json on screens + screen: grammar) is sound and traces cleanly to D1–D5; the defects are all in merge semantics, API edges, and one NOT NULL constraint the plan misses.

## Traceability summary

D1/D2 (split + managed env) → Stages 1–4, 6 ✔. D3 (global+app+plan) → 1.1, 2.1 ✔. D4 (masked write-only; plaintext-at-rest accepted) → 3.1, 5.2–5.3, acceptance #3 ✔. D5 (dedicated /env page) → Stage 5 ✔ + sketch gate (user-requested amendment) ✔. No extra un-approved commitments found beyond the ScreensPage login-form note (F7).

## Findings

### F1 — HIGH (confirmed defect) — Stage 2.2's "leave :1139 unchanged" destroys managed env on world swaps, and the stated chain contradicts existing tested precedence

**Location:** plan §Stage 2 (2.2 and the "Wait —" paragraph).

**Evidence:** `mergeVariantEnv(variant, invocationEnv)` = `{ ...invocationEnv, ...variant.env }` (`yaml-variants.ts:131`) — variant env WINS over request body today, and playback.ts:761 documents "variant > invocation (narrowest scope wins… tested in phase B T1)". On a swap step, `activeEnv = mergeVariantEnv(w, opts.env ?? {})` (`playback.ts:1139`) rebuilds from `opts.env` — the request body — only.

**Consequences:**
1. If Stage 2.2 seeds `activeEnv` with the resolver output but leaves :1139 untouched (exactly what the plan prescribes), the first `swap:` step resets `activeEnv` to variant+request-body only — every global/app/plan managed value silently vanishes mid-run. The plan's "Wait —" paragraph concludes ":1139 … already does this if seeded correctly", which is false.
2. The plan's stated chain `global < app < plan < variant < request body` puts the request body ABOVE variant — the reverse of current, pinned behavior. Implementing it silently flips variant-vs-request precedence and breaks the phase-B T1 contract.

**Correction:** restate the chain as `global < app < plan < request body < variant` (variant narrowest — matches today) OR explicitly decide to demote variants and update the pinned tests; and rewrite :1139's assignment to re-merge over the *resolver base* (e.g. keep `resolvedBase` from Stage 2.1; `activeEnv = mergeVariantEnv(w, resolvedBase)`), never over bare `opts.env`. Delete the "Wait —" paragraph from the plan.

**Verify:** unit test — global+app vars set, case with a `swap:` step whose variant defines one overlapping key; assert post-swap env = managed values with variant override, and that non-overlapping managed keys survive the swap.

### F2 — MEDIUM — PUT "empty secret value = leave unchanged" is ambiguous on create and can't intentionally clear

**Location:** plan §3.1.

**Consequence:** creating a NEW secret with an empty value stores an empty credential (which later fails as an odd login error, not a named one); and there is no way to clear a secret back to empty intentionally; non-secret keys that legitimately hold `''` collide with the sentinel if the rule is applied blanket-style.

**Correction:** scope the sentinel — empty value + row exists + `secret=1` → keep; empty value on create, or on a non-secret row → `422` with a named error. Clearing a secret = DELETE (document in the /env page).

**Verify:** route tests for the three cases.

### F3 — MEDIUM — no auth/role gating specified for the new write surface

**Location:** plan §3.1; code: global gate in `index.ts:78` only requires sign-in; role pattern exists (`requireRole('operator')` on baselines approve/reject).

**Consequence:** any signed-in viewer could edit env vars (and thus inject credentials into runs) — inconsistent with how approvals are gated.

**Correction:** `PUT`/`DELETE` behind `requireRole('operator')`; `GET` for any signed-in user (values masked for secrets anyway). One line in the plan; matches house precedent.

**Verify:** route test — viewer-role session gets 403 on PUT.

### F4 — MEDIUM — `planId` threading path unspecified

**Location:** plan §2.1. `runTemplatePlayback` opts (`playback.ts:274`) have no `planId`; plan plays go through `runBatch` → `runOne(templateId, udid, o, variantId)` where `o` is lane opts built inside the batch runner.

**Consequence:** an implementer following only "added to playback opts where suites/plans call runTemplatePlayback" won't find a direct call site to add it — plan-scope env silently never resolves for plan plays.

**Correction:** state the actual path: `runBatch` receives `planId`, threads it into each lane's `o`, `runOne` forwards it into `runTemplatePlayback` opts; resolver reads it there. Acceptance #2 already exercises this end-to-end (empty-body play of a plan-owned case would catch a miss) — add "via a PLAN play" to acceptance #2 so the threading is actually gated.

**Verify:** acceptance #2 run from the plan-play route, not just template-play.

### F5 — MEDIUM — Stage 6.1 seeds `login_json` on screen `auth`, but `app_screens` rows require NOT NULL `entry_json`/`states_json`

**Location:** plan §6.1 vs `.schema app_screens` (`entry_json TEXT NOT NULL, states_json TEXT NOT NULL`).

**Consequence:** there is no half-row: either screen `auth` already exists as a full registry row (it does not — current registry has only `home` for this bundle) or the seed must author a complete screen (entry recipe + states) — extra content the plan neither specifies nor got approval for.

**Correction:** decide the owner: (a) attach `login_json` to the existing `home` screen row (login is reachable from home; zero new registry content), or (b) author a full `auth` screen row (entry: tap the login bar; states: logged_in/logged_out — which the screen-state runner may actually want anyway). (a) is the smaller change; (b) is the cleaner registry. Operator pick.

**Verify:** seed script runs without NOT NULL violations; GET /api/app-screens shows the recipe.

### F6 — LOW — draft residue and schema self-contradiction in Stage 1/2 text

The "Wait —" paragraph (fold into F1's deletion); the CREATE TABLE snippet still shows table-level `UNIQUE(...)` that the following paragraph overrides — ship only the `COALESCE` unique index, drop the table-level clause from the snippet so an implementer can't cargo-cult both.

### F7 — LOW — ScreensPage login-recipe form has no owning stage

§3.2 says "Screens UI gets a small form (Stage 5)" but Stage 5 is the /env page only. Either add a bullet to Stage 5 or explicitly defer the form to a follow-up (seed via API in 6.1 regardless).

### F8 — LOW — acceptance #2 hygiene

"Unsetting makes the play fail with `missing env: DRILL_PHONE`" — only true if no same-key GLOBAL var shadows. The test must assert in a clean state (or delete the global twin if one exists).

## What was inspected vs what needs execution

Inspected on paper: decision trace, schema shape vs sqlite reality, merge-chain semantics against actual `mergeVariantEnv`/playback code, route-surface auth model, grammar validation rule vs case-yaml.ts parse block, acceptance coverage. Requires execution to validate: migration idempotency on the live DB, masking in real HTTP responses, sketch→pick flow, and the 6.4 drill (VPN-gated). This review cannot certify implementation correctness — F1's fix in particular must land as tests, not prose.

## Human questions

1. **F5:** login recipe owner — existing `home` row (smaller) or a newly authored full `auth` screen row (cleaner, adds entry/states content)?
2. **F1 (only if you disagree with keeping today's precedence):** should request-body env override variant env (behavior change + test updates), or does variant-stays-narrowest stand? Recommendation: keep variant narrowest.

## Required plan edits before implementation

- Rewrite Stage 2.2 per F1 (chain statement, :1139 re-merge over resolver base, delete "Wait —" paragraph), plus the F1 unit test in Stage 2's deliverable list.
- F2 sentinel scoping in §3.1 + tests.
- F3 role gating line in §3.1.
- F4 threading path + acceptance #2 "via plan play" amendment.
- F5 owner decision applied to §6.1.
- F6/F7/F8 editorial fixes.
