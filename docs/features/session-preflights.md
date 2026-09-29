# Session preflights — ensure login / ensure logout

The two setup verbs that absorb app state before a case's real steps run.

- `ensure login` — makes a session exist. No-op when logged in; else walks the app's **login recipe**.
- `ensure logout` — makes no session exist. No-op when logged out; else walks the app's **logout recipe** (button → confirm sheet → verify gone).

Both are idempotent, live-resolved (no recorded coordinates — cross-device safe), and live in a case's `setup:` section. A passing preflight means *the precondition holds*, not that the app works.

## Recipes are app-level registry entries

Each app has ONE login procedure and ONE logout procedure, stored per bundle and edited on the **screens page** (bundle header → `login flow` / `logout flow`). Recipes change when the app build changes — cases never repeat them.

- login recipe: `app_login` (entry navigation, field ids, submit, verify screen/state)
- logout recipe: `app_logout` (`button`, `confirm`, optional `stay` sheet check, optional `via` navigation)

History note (settled 2026-09-29, plan `20260929T080249Z`): login recipes were briefly also storable per screen (`app_screens.login_json`, edited by per-screen routes). The column, the routes, and the playback fallback are GONE — `app_login` is the single source; any screen-level data was migrated. `ensure login: screen: X` is accepted for back-compat and resolves the app recipe.

## Case forms

```yaml
setup:
  - ensure logout: {}                  # registry recipe (bare)
  - ensure logout: { back: Home }     # bare + case-owned return target
  - ensure logout:                     # inline recipe — WINS over the registry
      button: account_logout_button
      confirm: account_logout_confirm_button
      stay: account_logout_stay_button
      via: ic_tabbar_account_inactive
      back: Home
  - ensure login:
      screen: auth                     # resolves the app's login recipe
      phone: ${env.DRILL_PHONE}
      password: ${env.DRILL_PASSWORD}
```

- **bare form** resolves the app's registered recipe at run time; saving fails with a fix-naming error when the app has none registered
- **inline form** overrides the registry (case-level escape hatch; useful for a case that logs out differently)
- **`via:`** — navigate to a control (e.g. the account tab) before the preflight; may come from the recipe or the case
- **`back:`** — case-owned: after the preflight ends (either path), tap back to the screen the case's first step was recorded from. Without it, the app stays wherever the preflight landed (a case recorded on Home but parked on the Account tab fails its first step — the tnc bug of 2026-09-29)

## Editing

Screens page → bundle header:
- `login flow` — LoginFlowPanel (entry kind: tab / deep link / navigate steps; form controls; verify screen+state)
- `logout flow` — LogoutFlowPanel (button / confirm / stay / via; revision-guarded like login)

Both panels keep a form ⇄ yaml document sync; saves are operator-gated and revision-guarded (409 on stale).
