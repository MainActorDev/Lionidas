# Review — project registry plan

- Plan: plans/20261005T092500Z-project-registry-plan.md
- Verdict: **Ready for implementation** (3 findings folded in)

## Findings

- **[M1|Medium] Hashing a PAT with SHA-256 is irreversible — git needs the
  plaintext.** Unlike api_tokens (verify-only), the project token's future
  consumers (CI clone, agent fetch) must PRESENT the credential to git. A
  hash cannot do that; encrypting needs a key Lionidas doesn't have. Honest
  v1: store the token PLAINTEXT in a column never selected into any API
  response (store layer owns the projection; a test asserts the field never
  appears in JSON), documented as a known limitation. The env_vars table sets
  the precedent — secrets live in the DB today.
- **[L1|Low] `defaultBranch` default 'main' lies for some repos.** Accept
  NULL = "unspecified"; UI shows '—'. No silent wrong default.
- **[L2|Low] Claim-by-path is brittle to filename changes (upload NAME_TAKEN
  guards renames, but a CI overwrite can change case/whitespace).** Acceptable
  v1: claims key on the exact path; a re-claim after rename is one click. Note
  in store docs.

## Verified

- requireRole('admin') exists and admin passes all tiers (roles.ts:106-113) —
  the page's admin gate is one preHandler.
- Migration pattern confirmed (ALTER list in migrateM1).
- packages are files (no rows) — the package_owner side table is the right
  attribution seam; GET /api/packages joins it.
- App.vue holds `me.role` — the nav item can render conditionally.

## Residual

Plaintext-token storage (M1) is a real but scoped risk: local SQLite, admin-only
API surface, no logging of the column. Revisit with an OS keychain integration
when CI-pull lands.
