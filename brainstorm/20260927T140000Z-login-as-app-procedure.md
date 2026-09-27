# Login as an app-level procedure (no screen owns it)

- Source prompt: "When I uncheck the box, it's gone forever. And there is nothing I can do. Please compose it differently. No screen should 'own' the login form in this context. Only any screen might referencing it as their steps."
- Created: 2026-09-27T14:00:00Z
- Status: Direction selected

## The verdict that ends the iteration

Five UI rounds failed because every one kept the same wrong foundation: login as an
attribute of a screen (recipe → capability → gated checkbox). The operator names the
correct model outright:

1. **Login is a PROCEDURE of the app**, not a fact of any screen. It spans screens by
   nature (enter from home → fill the form → verify the session) so it cannot belong to
   one screen any more than a trip belongs to one city.
2. **Screens may REFERENCE it as steps** — a screen that needs a session declares the
   login as a precondition of reaching it, the same way entries reference taps.
3. **Nothing destructive**: unchecking a box on some screen's editor must never delete
   the login definition. Editing a screen touches the screen; the login is edited on its
   own surface.

## The model

App-level, one definition per app, stored beside the screens registry:

```yaml
login:                                  # app-level procedure
  entry: { navigate: [{on: home_login_bar_login_button}] }
  phone: auth_login_phone_field
  password: auth_login_password_field
  submit: auth_login_button
  verify: { screen: auth, state: logged_in }   # states stay screen facts
```

- entry/phone/password/submit — selectors, none owned by a screen
- verify references a (screen, state) PAIR — states remain screen facts (they are);
  the procedure points at them, it does not copy them
- `ensure login` in case setup drops the `screen:` argument — it resolves the app's
  procedure. Cases keep only env refs.

Screen reference (the operator's second point) lands as a follow-up grammar step:
a screen entry may include `{login: true}` — "ensure the session before entering me" —
so deep screens declare the dependency instead of every case repeating it.

## Why each earlier pain disappears

- uncheck-the-box deletes data → there is no box; the login editor is its own surface
- "owns the login form" wording → nothing owns it
- which screen carries it → none; which app → the registry's
- recipe duplicating entry/session → the procedure holds each fact once; states stay
  where they live and are referenced, not copied

## Editing surface

Screens page, app-scoped: a `login flow` header action (beside `+ app` / `yaml`) opens a
dedicated form + document panel (same anatomy as ScreenDocPanel, minus screen identity).
List page shows nothing login-related per screen — the dependency is invisible until
referenced, exactly as the operator describes.

## Migration

- Existing screen-level `login` blocks move to the app-level table on first read
  (read-time fallback as with v2: screen blocks keep working until re-saved; a one-time
  copy seeds `app_login` from `auth`'s block — non-destructive, the source row is left
  in place and simply stops being read once `app_login` exists)
- `ensure login: {screen: X}` still parses (compat) but resolves the app procedure,
  ignoring the screen arg with a deprecation note in the step reason

## Open questions

None blocking — the operator specified the model. Surface choice (header action on
screens page) follows the existing app-scoped pattern.
