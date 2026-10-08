# Phase 2 — freshness & hygiene: schedules, retention, stamping, secrets

- Source prompt: "The PR is merged. start brainstorming" — Phase 2 scope as
  proposed and acknowledged in chat (2026-10-08): triggers, retention,
  version stamping, secrets hardening.
- Created: 2026-10-08T10:33:10Z
- Status: Exploring

## Goal and context

PR #20 merged at `a28c4a9` — the whole CI chain (registry → clone → build
with verified inputs → smoke gate → ▶ test → suite verdict) is on main.
Phase 2 keeps that chain FRESH and CLEAN: builds happen without a human
clicking, artifacts don't accumulate unbounded, builds are uniquely
identifiable to crash tooling, and the auth token stops being plaintext.

Audience: admin (operators of Lionidas). Constraints: single-host SQLite
tool, no new pages (admin surfaces already exist), everything staged
independently and drilled against the real repo.

## Confirmed inputs and decisions

- Phase 2 scope agreed in chat: (1) build triggers, (2) artifact
  retention, (3) version stamping, (4) secrets hardening — with the
  explicit non-goals: Android/Web, scheduler suite-UX, new pages.
- Scheduler was Q2-deferred in Phase 1 with "manual action is its engine"
  recorded (brainstorm 20261008T083419Z).
- Token plaintext was accepted "until first consumer" (brainstorm
  20261005T071623Z); clone shipped = consumer live; hardening due.
- Verified: `CFBundleVersion` in built artifacts is the stale literal
  `20250515` (read from build #18/#20 Info.plists this session).
- Verified: artifacts ~35 MB each; builds 13/16/20 in packages/ today.
- Verified: runs.app_build column exists (schema), stamped from installed
  apps at run creation — but every build reports the same stale value.
- GitHub webhook needs a reachable endpoint + secret; the host runs LAN
  only (settings page, LAN note) — EXTERNAL reachability is NOT
  established. This constrains the webhook option.

## Decisions (2026-10-08, user — supersede earlier scope)

- **Scheduler: REMOVED from Phase 2 entirely** (not deferred) — "manual run
  is fine". No schedule fields, no tick loop, no catch-up semantics.
- **Secrets redesigned: env fields, not app-managed storage.** The user
  never supplied a PAT; the earlier design (user pastes token into Settings
  → encrypted in DB) is wrong-shape. GITHUB and JIRA tokens arrive as
  environment variables the operator sets where the server runs
  (.env / launchd / soon: docker env). The app NEVER holds the source of
  truth for secrets.
- **Next direction announced (informs design): containerize/dockerize.**
  Env-var config is the 12-factor/Docker-native mechanism — designing
  secrets as env fields NOW is container-ready by construction. Note for
  that phase (not a blocker now): simulator orchestration (simctl/
  xcodebuild) requires a macOS host — full containerization will need an
  architecture decision (engine on Mac host vs. remote device hosts).

## Exploration (revised for the three remaining stages)

### Secrets v2 — env fields

- Server reads `CRUCIBLE_GITHUB_TOKEN` (clone/pull auth when a project has
  no per-project token) and `CRUCIBLE_JIRA_TOKEN` (Jira connector auth).
  Precedence: per-project token (if ever set) > env GitHub token > ambient
  credentials (today's behavior on this Mac).
- The Settings page credentials section becomes an env-field STATUS
  mirror: which secret env keys are SET (masked ✓) / unset — read-only;
  values never enter the DB, never render.
- Fate of the per-project auth_token column: deprecate the UI field (keep
  the column one release for compat) — env is the primary mechanism.
  AES-GCM encryption-at-rest stage is MOOT for env-sourced tokens (nothing
  sensitive at rest); if the column is ever revived for multi-org
  overrides, encrypt then.
- Drill (env token): the OPERATOR sets CRUCIBLE_GITHUB_TOKEN in the
  server's env (their hands only — .env or launchd plist), restarts, and
  the drill wipes the clone and proves private clone + pull through the
  env token, plus a wrong-token failure that errors honestly. No token
  value ever passes through chat or the UI.

### 1. Triggers — schedule-first, webhook honest-deferred

**Schedule (build):** per-project row `schedule_json` = `{enabled, time:
"02:00", suiteId?}` set in the project editor. In-server scheduler
(setInterval tick each minute; single-host = no locking needed). Fires the
EXISTING chain: pull → build → (smoke is inside build) → if passed+smoke-ok
and suiteId set → ▶ test internals. Chain state visible as build rows +
suite chips — no new surface; the overnight outcome reads as "#21 ● passed
✓⌁ [48/50]" by morning.
- Edge: build already running at fire time → skip with a log line (the
  per-project serial queue already prevents overlap; the tick just skips).
- Edge: machine asleep at 02:00 → missed schedule fires on wake if
  `time` passed and last fire date < today (catch-up semantics; document).
- Edge: no booted sim at 02:00 → smoke='skipped', build still passes;
  ▶ test would 409 NO_DEVICE → skip the test leg with a log line (build
  verdict intact — two-verdicts rule).
  - OPTION (challenge): auto-boot a sim for the overnight chain
    (simctl boot + wait). Tempting; adds device-state automation to a
    scheduler. Lean: v1 skips, admin boots a sim before leaving; auto-boot
    later if it annoys.

**Webhook (defer, honest reason):** LAN-only host today — a GitHub webhook
needs a public URL or a tunnel. That's infra the user doesn't have
declared. Defer until a host/reachability decision exists; schedule covers
the freshness need.

### 2. Retention — GC with evidence immunity

- Per-project `retention` (default 10) in projects table + editor field.
- GC pass after each build settles (and at boot): per project, list builds
  with artifact_path ordered desc; keep newest N **plus** any artifact a
  run row references (`SELECT DISTINCT artifact… runs → builds` — actually
  runs reference build_id, so: keep any build id that has runs), plus the
  newest passing one even if beyond N. Delete file + package_owner claim
  for the rest; build ROW stays (history), artifact_path → NULL (same
  semantics as smoke-crash rows).
- Manual trigger: settings page "reclaim" button? No — automatic only;
  knobs in the editor. Simplicity.

### 3. Stamping — env var through prepare/build

- Engine exports `LIONIDAS_BUILD_NUMBER=<n>` (and `LIONIDAS_BUILD_ID`) to
  prepare steps and xcbuddy/xcodebuild children (documented contract).
- App repo: one PR — `CURRENT_PROJECT_VERSION = $(LIONIDAS_BUILD_NUMBER)`
  fallback `20250515` in project.yml (xcodegen accepts xcconfig/env
  interpolation; verify the exact mechanism during implementation —
  `CURRENT_PROJECT_VERSION` from an xcconfig file is the standard route:
  add a CI-generated line, or use `INFOPLIST_KEY`… implementation detail
  to verify, the design is: env in → build number out).
- Effect: CFBundleVersion = 20, 21, … — runs.app_build becomes real;
  crash reports (already collected by the smoke gate's DiagnosticReports
  scan) map to builds.

### 4. Secrets — encrypt at rest + the PAT drill

- Encryption: AES-256-GCM, key from `CRUCIBLE_TOKEN_KEY` env (32-byte
  hex/base64). Store `enc:<iv>:<tag>:<ct>` in auth_token column; decrypt
  on use in projectAuthToken. Missing key at boot → tokens unreadable →
  clear error naming the env (fail honest, not silent plaintext).
  Migration: on first boot with key present, encrypt any plaintext tokens
  in place (one pass).
- PAT drill: user drops a real PAT into Settings (their hands, not mine),
  wipe `server/repos/ios-consumer-intl`, private clone + pull via API with
  the token path exercised (https token-in-URL + ssh askpass branches).
  Success criterion: clone + pull both work with the stored token and fail
  honestly with a bad token.

## Risks

- Scheduler wake/sleep semantics differ by host (macOS App Nap / sleep) —
  catch-up logic must be simple and observable (last-fire stamp in the
  project row; log every decision).
- GC deleting an artifact a test run still points at → guarded by the
  runs-reference immunity; drill it.
- Encryption key lost = tokens lost (acceptable, documented; re-enter).

## Open questions

1. **Retention default** — N=10 per project? (~350 MB per project at
   current artifact size.)
2. **Stamping mechanism** — prepare-script writes CURRENT_PROJECT_VERSION
   into the generated spec from `LIONIDAS_BUILD_NUMBER` env (zero app-repo
   change) — confirm.
3. **Env token names** — `CRUCIBLE_GITHUB_TOKEN` / `CRUCIBLE_JIRA_TOKEN`
   as proposed, or different names the user prefers?
4. **Per-project auth_token column** — deprecate the UI field now (env is
   primary), or remove entirely in this round?

## Next step

Close the four questions → plan (three stages: retention T1, stamping T2,
env-secrets T3) → build on a fresh branch off main → drill each (GC with
fabricated builds, a stamped real build reading CFBundleVersion=N, env-set
clone drill). Containerization is a separate future brainstorm — but every
Phase 2 choice above is already 12-factor-shaped to make it easy.
