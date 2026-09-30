# Logout recipe into the screens registry (symmetry with login)

- Source prompt: "why can't those two being part of screen definition? Are they different?" → "Brainstorm first" (invoked with /hms-brainstorm-rough-ideas), on the assistant's observation that ensure-login's recipe lives in the screens registry while ensure-logout's recipe is copy-pasted inline into every case.
- Created: 2026-09-29T08:02:49Z
- Status: Exploring

## Goal and context

The two session preflights are asymmetric today. `ensure login: screen: auth` pulls a whole recipe from the screens registry (`login_json` on the auth screen row — entry navigation, field ids, submit, verify state), so cases carry only runtime inputs (credentials). `ensure logout` instead repeats its recipe (button/stay/confirm/via) inline in every case that needs a logged-out start. The operator asks whether logout should live in the screen definition like login does. Interpretation: goal is ONE editable place per app for the logout procedure, cases referencing it, mirroring the login precedent — not a rearchitecture of the registry.

## Confirmed inputs and decisions

- Verified (DB, 2026-09-29): `app_screens` has `login_json` per screen; `auth` is the only screen with one. A separate `app_login` table ALSO exists (one row per bundle) and is what the ScreensPage "login flow" button edits (`/api/apps/:bundle/login`), while playback ALSO reads `app_screens.login_json` (playback.ts:1272-1290) — two storage homes for login recipes already, a pre-existing wrinkle this work should not worsen (and may want to settle).
- Verified: inline ensure-logout steps exist in exactly 2 templates (`tnc`, `privacy policy`), both carrying identical recipe bodies (button/stay/confirm/via). Registry-form ensure-login (`screen: auth`) in 2 templates (`tnc (logged-in)`, `privacy policy (logged-in)`).
- Verified: `back:` (added 2026-09-29, PR#10 branch) is genuinely case-specific (where the case's first step expects to start) — NOT recipe material.
- User-confirmed direction: logout recipe "should be registry" was the assistant's framing the operator then asked to brainstorm — direction welcomed but not yet accepted in detail.
- Context: the screens registry models per-app facts (entry_json, states_json, login_json); cases own runtime inputs and flow shape.

## Exploration

### Where should the logout recipe live?

**Option A — `logout_json` on a screen row (mirrors login_json literally)**
`ensure logout: screen: account` reads `logout_json` from the account screen. Symmetric reading, symmetric editing.
- Weakness: WHICH screen? The logout button lives on the account tab, but the "logged out" state is a property of auth/home. Login dodges this because the login form and its verify state coincidentally live on `auth`. For logout the recipe spans two screens (act on account, verify elsewhere) — forcing it into one screen row repeats the accident, not the design.

**Option B — app-level `app_logout` table (mirrors the app_login table the UI actually edits)**
The "login flow" button already edits `app_login` (per-bundle). A per-bundle `app_logout` (button/stay/confirm/via) is the true mirror of the editing surface that exists. Cases say `ensure logout: {}` or `ensure logout: screen: <id>` resolves app-level.
- Strength: one recipe per app (correct cardinality — an app has one logout procedure); editing UI lands next to "login flow" (same group header); no forced screen choice.
- Weakness: does NOT reuse the per-screen login_json column pattern; two mechanisms (table + column) coexist — but they already do for login.

**Option C — both: table as source of truth, screen column deprecated**
Settle the pre-existing login duality as part of this: `app_login`+`app_logout` tables become the canonical recipes; `app_screens.login_json` becomes a read-through cache or is dropped. Bigger scope; touches the login path that currently works.

### How do cases reference it?

- `ensure logout: {}` — bare verb, resolves the app's recipe; error at save if the app has none (fail-closed, same as `ensure login: screen:` on an unknown screen).
- `ensure logout: { screen: account }` — explicit form for multi-logout-app futures (not needed now; the app has one logout).
- Inline recipe keeps working forever (back-compat): registry wins when both present? NO — inline should win (case-level override of a shared recipe is the conservative semantics, mirrors variants overriding case defaults). Recommendation: inline wins, registry fills the gaps (per-key merge is over-engineering; whole-recipe precedence).

### What stays in the case?

`back:`, credentials-independent; and nothing else — button/stay/confirm/via all move to the recipe.

### Editing UI

Reuse the LoginFlowPanel pattern: a "logout flow" mini-act beside "login flow" in the bundle header; form fields = button / stay / confirm / via (+ yaml doc view like login). OR defer UI and seed via yaml import the registry already has. Recommendation: ship the panel — the operator's POV complaint was precisely that this stuff is undiscoverable; a hidden table with no editor repeats it.

### Edge cases

- App with no recipe + bare `ensure logout:` → save-time error naming the fix ("register the app's logout flow on the screens page") — honest, prevents silent no-op.
- `via` in recipe vs case: recipe owns it; case can still override inline if it truly needs a different route.
- The 2 existing inline cases: migrate to bare form after the recipe lands (data migration, one UPDATE each; keep inline if operator prefers zero churn).
- Registry edited mid-suite: next run reads fresh (recipes resolve at run start) — same as login today.

## Open questions

1. **B or A** — app-level table (recommended: mirrors the editing surface that exists) vs per-screen column (mirrors the storage login_json uses)? The login duality (table vs column) makes "mirror login" ambiguous — which half do we mirror?
2. **Settle the login duality now (C) or leave it?** Recommended: leave it (working system, zero complaints); note it as known debt.
3. **Migrate the 2 inline cases to the bare form, or leave them inline?** Recommended: migrate (they become the demo of the new form).
4. **UI panel this round, or registry-only + yaml import?** Recommended: panel (discoverability was the complaint).

## Decisions log

- 2026-09-29 user (chat), answering the four open questions:
  1. **"B"** — app-level `app_logout` table (mirrors the editing surface), NOT a per-screen column.
  2. **"settle now"** — the login duality (`app_login` table vs `app_screens.login_json` column) is settled as part of this work: one canonical store.
  3. **"yes"** — migrate the 2 inline ensure-logout cases (tnc, privacy policy) to the bare registry form.
  4. **"yes"** — ship the UI panel (LogoutFlowPanel beside the login one).

## Next step (superseded by decisions)

All four questions answered → write the plan (`plans/20260929T080249Z-logout-recipe-registry-plan.md`): settle login canonical store + `app_logout` table + bare `ensure logout: {}` grammar + playback resolution (inline wins) + panel + migration of 2 cases → review → build → drill on tnc via the registry recipe.

