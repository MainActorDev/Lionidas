# Review — logout recipe registry plan (20260929T080249Z)

- Reviewed: `plans/20260929T080249Z-logout-recipe-registry-plan.md` (status Ready, 2026-09-29) — against main `b00220a` (PR #10 merged, so `back:` is on main)
- Sources: brainstorm `20260929T080249Z-logout-recipe-registry.md` + Decisions log; live code survey 2026-09-29 (`app-screens.ts` routes incl. per-screen login triple, playback.ts login resolution :1230-1300, shared/app-screens.ts validateAppLogin, schema.ts, LoginFlowPanel.vue, better-sqlite3 3.49.2)
- Verdict: **Needs revision** (2026-09-29) → **plan rev 2 applies F1-F6; Ready for implementation** (operator: "Apply the six edits then proceed")

## Traceability

Decisions 1–6 all trace to plan work: app-level table (Stage 2), settle-now (Stage 2.2), migrate 2 cases (Stage 5.2), panel (Stage 4), bare-verb + inline-wins (Stage 1/3), back stays case-owned (verified fact + Stage 3). No extra commitments beyond the review findings below.

## Findings

### F1 (High) — the login settlement is HALF-DONE in the wild already; the plan redoes the done half and misses the actual remaining half

Code reality (surveyed 2026-09-29):
- `shared/src/app-screens.ts:80-86` — the registry yaml schema ALREADY rejects `login` on screens ("login is app-level now — edit it via the app's login flow"). The shared contract is settled.
- `playback.ts:1251-1271` — `app_login` already WINS; the `screen:` branch (:1272-1290) is already a fallback.
- BUT three remnants keep the duality alive, and the plan names only one of them:
  1. playback `screen:` fallback read (:1272-1290) — plan covers ✓
  2. **per-screen login routes** `/api/apps/:bundle/screens/:id/login` GET/PUT/DELETE (app-screens.ts:200-238) — an EDITING surface still writing the doomed column; nothing in the plan removes them, and web/src grep shows no consumer, so they are dead-but-live writes
  3. **registry replace snapshot/re-apply** (app-screens.ts:47-51) — preserves login_json across yaml registry replaces; harmless post-drop but references the column and must be updated when it drops, else the import route 500s (INSERT names login_json — the dropped column)

**Correction:** Stage 2.2 becomes: (a) migrate data (as planned); (b) remove playback fallback; (c) DELETE the per-screen login routes (no consumers verified); (d) update the replace-snapshot block to stop reading/writing login_json (drop the snapshot entirely — app-level recipes no longer ride registry yaml); THEN (e) drop the column. Add acceptance: registry yaml import/export round-trip test still passes post-drop.

### F2 (Medium) — bare-form save-time validation has a threading problem the plan hand-waves

`parseCaseYaml(text)` takes NO options today (case-yaml.ts:96); three call sites (templates.ts:445, :805, :865) plus the import route. The plan says "validation hook accepts a hasAppLogout predicate (parse opts)" without specifying the signature change or all call sites. Risk: predicate threaded at PUT but not at the validate endpoint → editor saves a case the validate endpoint rejects, or vice versa.

**Correction:** Stage 1 specifies: `parseCaseYaml(text, opts?: { hasLogoutRecipe?: (appBundleId: string | null | undefined) => boolean })`; ALL FOUR call sites thread it (PUT :865, validate :805, import :445, and the editor preview if separate); default when absent = skip the bare-no-recipe error (back-compat for tests/other callers). Acceptance: contract test hitting validate + PUT with and without a recipe.

### F3 (Medium) — `app_screens.login_json` DROP timing vs the snapshot block: order matters

F1's item 3 makes the DROP a breaking change for the import route unless the snapshot block is edited in the same commit. The plan sequences "strip login_json from the import/export route" but doesn't bind it to the DROP as an atomic unit. One server restart with a dropped column + un-updated INSERT = every registry import 500s.

**Correction:** Stage 2.2 ordering is atomic: routes+snapshot edits ship together with the guarded DROP in the same migration block; a test imports registry yaml post-migration (covered by F1 acceptance).

### F4 (Low) — `validateAppLogout` should mirror `validateAppLogin`, plan is silent

Login has a real validator in shared (`validateAppLogin` — entry/verify shape + cross-checks against registry screens). Logout recipe (button/stay/confirm/via) deserves the same: non-empty strings, via optional, unknown keys rejected. Plan Stage 2.3 says "CRUD routes" only.

**Correction:** Stage 2.3 + shared module: add `validateAppLogout` beside `validateAppLogin`; PUT runs it; tests cover 422 paths.

### F5 (Low) — panel parity gaps

LoginFlowPanel has revision-guard (409 on stale) + doc/form yaml sync. Plan says "clone-and-trim" but doesn't name revision guarding for logout. The login routes carry it (PUT 409); the cloned logout routes should too (trivially: same revision column).

**Correction:** Stage 4 explicitly includes revision-guard behavior + the 409 reload message, matching login.

### F6 (Low) — SQLite DROP COLUMN confirmed fine, plan's hedge can tighten

better-sqlite3 here bundles SQLite 3.49.2 (verified live) — DROP COLUMN is safe. Keep the try/catch hedge but drop the "ancient better-sqlite3" caveat from acceptance; it cannot fire on this stack.

## Human questions

None blocking — all findings have mechanical corrections; direction B stands.

## Required plan edits

1. Stage 2.2 rewrite per F1 (remove per-screen routes; fix replace-snapshot; atomic with DROP; import round-trip acceptance).
2. Stage 1 signature + four call sites per F2; default-skip semantics.
3. Stage 2.2 atomic ordering per F3 (folded into 1).
4. Stage 2.3 + shared: `validateAppLogout` per F4.
5. Stage 4: revision-guard parity per F5.
6. Verified-facts: DROP COLUMN confirmed on 3.49.2 per F6.

## Inspected on paper vs. requires execution

Paper: settlement remainder inventory (routes/snapshot/fallback enumerated from source), grammar threading feasibility (parse signature + call sites counted), route shapes to clone, panel parity surface, migration idempotency. Requires execution: playback recipe resolution tests, registry import post-drop, panel save/load, live drill both preflight paths.
