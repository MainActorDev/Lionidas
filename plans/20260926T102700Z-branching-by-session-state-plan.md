# PLAN (Pending) — Login seam + logged-in legal-doc twin cases (session-state coverage)

- Source brainstorm: `brainstorm/20260926T102700Z-branching-by-session-state.md`
- Plan status: **Pending** — one blocking question (test-account credentials) + one design choice
- Created: 2026-09-26T10:35Z

## Decision log (operator, chat 2026-09-26)

1. **Q1 login seam: YES** — a stable test account exists/can exist for drills. (Exact credentials still needed — see blocking question.)
2. **Q2 coverage: BOTH states proven, plus tolerance for whatever state the sim is in.** Interpretation: twin cases (logged-out + logged-in) prove both paths explicitly; each twin's SETUP normalizes the sim's state so "whatever state" never leaks into the steps. This is the brainstorm's Option 1 — no if/else grammar.

## Confirmed facts

- Logged-out twins already work: pp `run_1ff37d8e` (7/7), tnc `run_30079c57` (5/5).
- `ensure logout` verb: no-op 0.08s when logged out; full walk implemented (button→sheet→verify-gone), live-drill of the logged-in walk still pending a session.
- Logged-in Account exposes "Terms & conditions" / "Privacy policy" rows (`AccountFeature.swift:26-33`), title-only (no identifiers yet).
- Login form (LoginView.swift): `AuthPhoneField` + `AuthPasswordField` + "Log in" button — **no accessibility identifiers on any of them**; placeholders only ("e.g : 12 789 4563", "Enter your password").
- Env substitution `${env.KEY}` exists for text/selectors at playback (template-env.ts) — credentials belong there, never in steps_json.

## Design sketch (pending answers)

### App side (ios-consumer-intl, PR #390 branch or new branch)

Identifiers, same `{screen}_{element}_{type}` convention:
- `auth_login_phone_field`, `auth_login_password_field`, `auth_login_button`
- `account_legal_terms_row`, `account_legal_privacy_row` (logged-in Legal & policies rows)
Needed for reliable `ensure login` typing + logged-in twin navigation.

### Crucible side

1. **`ensure login` setup verb** (mirror of ensure logout): if a session indicator (e.g. profile/`account_logout_button`) is already visible → no-op pass. Else: tap `home_login_bar_login_button` (or Account → Log In), type phone/password from `${env.DRILL_PHONE}`/`${env.DRILL_PASSWORD}`, tap `auth_login_button`, verify session indicator appears. Bounded polls, identifier-first resolution, zero coordinates.
2. **Twin cases**:
   - `pp` / `tnc` (existing, logged-out): setup `ensure logout` — unchanged.
   - `pp (logged-in)` / `tnc (logged-in)`: setup `ensure login`; steps: Account tab → tap `account_legal_privacy_row` / `account_legal_terms_row` → expect the same `legal_doc_*_screen` identifiers.
3. **Reporting**: both twins run in the same batch where needed; each run proves exactly its state (honest coverage per run, both states across the pair).

### Speed

- Setup no-ops: 0.08s (measured class).
- Logged-in steps: selector taps only — same speed class as the logged-out twins (1-2s/step incl. dispatch).
- The whole arc's optimizations apply unchanged.

## Blocking question

**Q: The test-account credentials.** Which phone/password does the drill use, and are they stable across environments (staging)? They'll live in Crucible's env (run invocation env or server env vars), referenced as `${env.DRILL_PHONE}` / `${env.DRILL_PASSWORD}` — never stored in the template. Also: does login for that account require OTP/2FA (which would need an `ensure login` extension or an OTP-bypass seam in the app)?

## Open design choice (answer with the credentials)

- Logged-in Legal rows: tap by **label** now (works, matches current Link-label approach) or wait for the row **identifiers** (robust to copy changes)? Recommendation: ship app identifiers + use them — labels on rows are cheap but the identifier convention is the established pattern.

## Next step

Operator provides the test-account credentials (+ OTP status) → plan goes Ready with implementation order: app identifiers → `ensure login` verb + tests → twin cases → drills proving all four (2 logged-out + 2 logged-in) + the live logged-in `ensure logout` walk as a bonus.
