# Review — setup-wizard plan

- Plan: plans/20261008T130034Z-setup-wizard-plan.md
- Verdict: **READY** — 11 findings folded in (5 original + 3 reinstall/upgrade + 3 safety-guard round).

## Reinstall & upgrade audit (2026-10-08, user: "What if the user already have Lionidas installed. What will happen if user install again via the setup wizard? Think of everything.")

The design premise: **the wizard keys off database state, not install media.** "Install again" changes binaries, never the DB unless explicitly deleted. Consequences, verified against the current code:

**Happy path — existing install, user opens /setup directly or via login link**
- T0 backfill: local admin hash exists ⇒ stamp written at boot ⇒ `needsSetup=false` ⇒ `/setup` 404s server-side, web guard redirects to /login with a notice. Zero exposure, zero change.
- Fresh machine + copied/restored DB: same — stamp travels with the DB.
- Fresh machine, user re-runs `pnpm` install from repo: DB is at `server/crucible.db` in the workspace ⇒ survives; wizard inert. **Data created by setup (users, projects) lives in the DB, so nothing is lost.**

**Sad path — reinstall with deleted/corrupt DB**
- Deleted DB: server re-seeds `admin@lionparcel.com` with a generated printed password ⇒ wizard reopens (correct: this IS a new instance now). All prior users/projects/runs are gone with the DB — that's the DB-restore procedure, not the wizard's.
- Corrupt DB: server refuses to boot on migration errors (existing behavior) ⇒ wizard never becomes reachable ⇒ no accidental account takeover of a half-alive instance.
- Wizard POST on an already-configured server (attack/typo path): 404, stamp check precedes any write; rate-limited. Cannot create an admin or overwrite a password.

**Edge cases**
- **DB mid-copy race**: copy in flight while server boots ⇒ migrations fail ⇒ no boot ⇒ no window. If it boots, it's a complete DB with a stamp.
- **Setup completes mid-flight in another tab**: second POST 404s, tab redirects to /login with a notice (R4).
- **Jira-only install**: no local user ever mints a hash ⇒ needsSetup stays true ⇒ setup remains open. INTENDED: the operator hasn't completed local setup; the instance owner can complete it or set CRUCIBLE_SETUP_MODE=off (documented). Alternative rejected: closing setup on first Jira login — wrong agent (a Jira user isn't necessarily the instance owner) and it would silently close a door the operator may want later.
- **Lost only-admin password (no reset CLI exists — verified)**: `lionidas admin reset-password` added in T1.4 covers it without reopening the wizard.
- **Downgrade**: returning to a pre-wizard version after setup completed leaves the stamp unread in schema_meta ⇒ harmless, no errors.

## Findings (all folded)

1. **[R1|Med] Rate-limit store must be module-level, not per-route.** A per-route in-memory limiter resets on route re-registration; module-level Map with periodic prune. Folded into T1.2.
2. **[R2|Med] `needsSetup` must NOT treat a Jira-provisioned user with a hash as completing setup.** The auth stack can mint hashes for Jira-provisioned users. Fix: needsSetup checks only LOCAL users' hashes (auth_source='local'). Folded into T1.1.
2b. **[R2b|Med] The seed row must not be deactivated when the wizard email EQUALS admin@lionparcel.com.** Same-email case sets the hash on that row instead of creating a duplicate. Folded into T1.2.
3. **[R3|Med] Readiness probes must never block boot or requests.** All probes timeout-capped (2s exec cap), cached, failures map to 'fail' rows — never throw. Folded into T2.
4. **[R4|Low] SetupPage must handle the transitional state where setup completes in another tab.** If POST admin returns 404 (already completed), redirect to /login with notice, not an error screen. Folded into T3.1.
5. **[R5|Low] Web tests for router guard should stub `/api/setup/state` with both states.** Folded into T4.2.
6. **[R6|High] Upgrade path: existing installs have no stamp.** Without T0 backfill, every upgraded install would show the wizard again — the exact scenario the user asked about. Folded in as T0.
7. **[R7|Med] No password-reset path exists for a locked-out single admin.** Reopening the wizard would be an account-takeover vector; CLI reset added instead (T1.4).
8. **[R8|Low] Jira-only installs keep the window open forever — document it.** Not a bug; documented in the wizard and README-adjacent docs.
9. **[R9|High] Pre-setup window trusts whoever shows up — setup token required.** A LAN peer could claim the instance during first boot. Jenkins-style: 128-bit token printed to the machine console, required by the admin POST, never exposed via state endpoint. Folded into T1.5.
10. **[R10|Med] CSRF during the open window.** Origin check + JSON-only content type on the POST. Folded into T1.5.
11. **[R11|Med] Racing admin-creation POSTs.** Stamp check + writes in one `BEGIN IMMEDIATE` transaction — single winner. Folded into T1.5.

## Checks passed

- Scope matches brainstorm decisions (Q1 deactivate seed row ✓, Q2 include Xcode/xcbuddy probes ✓, Q3 Settings section ✓).
- Security edges addressed: pre-setup window (public routes limited to state+admin POST, rate-limited), CRUCIBLE_SETUP_MODE=off, post-stamp 404s.
- No new deps; uses existing auth/password policy.
- Out of scope list protects the container-phase boundary.
