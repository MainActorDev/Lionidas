# Build-Config Autonomy — Plan

- Source: in-session decision (2026-10-15, post-bridge): "I hate the human part in this build config setup. Why can't it be full agentic? But not necessarily sloppy" + the human/agent task split the user approved ("Do that")
- Status: READY
- Branch: `feat/build-config-apply-bridge` line continues (or a fresh branch at implementation time — implementer's call, PR against main)
- Supersedes: the confirmation-gate portion of plan 20261015T121500Z (its R1 finding argued FOR the hard gate; this plan replaces confirmation with stronger mechanisms — see "The reversal, honestly")

## Problem

The apply bridge works but ends every loop in a human click. The user is right that most of the safety never came from those clicks: Foodiary and intl both verified green with zero human gates, while ios-consumer's remaining "human" step is a `cp` of an env-config file that already exists on the machine. Confirmations on yaml a human won't read are theater; the real safety is reversibility + oracle + read-scoped tools.

## The refined law

**"Simulator-slice is agent territory; signing is a toggle; distribution is human."**

| Tier | Examples | Who |
|---|---|---|
| Simulator slice | detect, propose, write revisions, verify (compile-only, `generic/platform=iOS Simulator`), diagnose/revise/re-verify loops, pod install / xcodegen, env-config COPY (files that exist on-machine) | **Agent, fully** |
| Device-test .ipa | ad-hoc/dev signing (certs live in the login keychain from everyday Xcode use) | Agent allowed, behind a per-project toggle the human sets once |
| Distribution | App Store / TestFlight / match repo / ASC keys | **Human, full stop** |

Env-config files (xcconfig with API endpoints/SDK keys) are **not credentials that grant access** — they're runtime config. Copying them by path never reads contents. The secrets law narrows to: never ingest VALUES into context/transcript/logs, never create credentials, never sign for distribution without the toggle.

## Design

### 1. Auto-apply tiers (replaces confirm-first for config writes)

- `derivable` detection → auto-write the generated row, auto-verify, report. No turn, no click.
- Evidence-cited proposal (from `/build-config-propose` or `/build-diagnose`) → **auto-write on the SAME turn**, auto-fire verify, report with revision + provenance. The HARD STOP is REMOVED for these writes. The Projects chip/panel renders an `auto` marker on revisions whose provenance is `*-auto`, and the canary counts autonomous rows (review R4 — the audit trail must be visible where decisions are made).
- The parked-proposal/confirm machinery stays in the codebase but demoted: it now serves only actions that leave the Lionidas sandbox or touch signing — i.e. future cross-repo PR proposals. Kept, not deleted — BUT its `consumeConfirmation` seam is marked IDENTIFIER-FLOW-ONLY in comments and no autonomous tool may consult the build_config_proposals table (review R6: dead-but-kept code with a vague future is where schema drift breeds).
- Command instructions updated: propose → write → verify → report in one turn; "if verify fails, diagnose and revise up to the budget."

### 2. `env_config.provision` tool (the cp-semantics file tool)

- Args: `{projectId, files: [exact names]}` — e.g. `{files: ["DevelopmentConfig.xcconfig", "StagingConfig.xcconfig"]}`. **Exact filenames only** (review R1): no globs, no path separators (refuse any name containing `/`), and a hard extension allowlist — `*.xcconfig` ONLY. A refuse-list rejects credential-looking names loudly (`*.p8`, `*.p12`, `*.pem`, `*.key`, `id_rsa*`, `.env*`).
- Sources: **registered** directories only — a new server setting `env_config_sources` (default: auto-include `~/.lionidas/env-configs/<project>/` when present, plus the sibling dev-checkout convention on this machine). Never arbitrary paths.
- Semantics: byte-for-byte `cp` from first source that has the file → the project workspace clone ROOT (where pbxproj references expect them). Returns `{copied: [{file, sha256, bytes, from}], missing: [names]}` — **never contents**. sha256 proves what landed without exposing it.
- **Provisioning ledger** (R1): every placement records into a `provisioned_files` table (project, file, sha256, from, at) — the status page shows exactly what the agent placed.
- Missing everywhere → honest blocker `ENV_CONFIG_NOT_FOUND` naming the exact file(s) and the searched dirs; THAT is the genuine human moment (bootstrap).
- Idempotent: same sha → no-op report. Different sha already present → report both, overwrite only with `force: true`.

### 3. Budget rails (sloppiness capped by construction)

- Max N (default 3) config revisions per project per rolling hour; excess → the turn reports the cap instead of writing.
- **Verify budget enforced in the ENGINE, not the prompt** (review R2): max 3 verify fires per rolling hour, PROJECT-scoped (not per-revision), counted in startBuildVerify itself; excess returns `VERIFY_BUDGET_EXHAUSTED (next eligible HH:MM)`. Command instructions: on that error, END THE TURN reporting the last failure and what was tried.
- **Identical-error circuit breaker** (R2): a failed verify whose normalized first hard error equals the previous revision's must not auto-revise — same-error loops are the stuck signature; report and stop.
- Every write logs provenance `{by: 'agent-auto'|'ai-auto', evidence[]}` — auto applies are never laundered as user confirms.

### 4. Signing toggle (scoped, minimal)

- `projects.allow_device_signing` (default 0). When 0 and a recipe names a DEVICE destination → **REFUSE** with `DEVICE_SIGNING_BLOCKED (enable projects.allow_device_signing)` — an honest refusal, never a silently modified build (review R3: injecting flags the recipe didn't carry makes the oracle judge a different command than the team's lane — false-green risk). Injection of `CODE_SIGNING_ALLOWED=NO` is legal ONLY as an explicit, provenance-cited recipe step the agent itself wrote. When the toggle is 1, device-destination builds run using the login keychain (the everyday-Xcode case).
- Distribution actions (match, ASC, TestFlight) are NOT implemented in any tool — not a toggle, absent. Human does those outside Lionidas.

## Stages

**A1 — provision tool + sources setting**: `env_config_sources` config; the tool with sha-report semantics; unit tests (copy, idempotence, missing-blocker, never-contents assertion via mock read attempt).
**A2 — auto-apply**: apply-on-propose in the command instructions + a `build_config.write` path that skips the pending/flip when invoked with `auto: true` from the command flow (the REST UI derive button already does this shape); budget rails; revision provenance `ai-auto`. Update bridge tests: confirm-flow still enforced for NON-auto callers (the REST apply-proposal route keeps requiring an admin — it's a human door by design).
**A3 — signing toggle + forced-sim guard**: column, injection rule, verify refusal when a recipe names a device destination on an untoggled project.
**A4 — live drills**: (a) ios-consumer end-to-end: provision the xcconfigs from the dev checkout → auto-propose/auto-write/auto-verify Dev row → green expected — zero human actions AFTER the one-time source registration (this machine: the default sibling path is already valid; fresh installs register sources once — that bootstrap IS the honest human moment, review R5); (b) Foodiary fresh derive → auto-write/verify; (c) missing-file drill: request a nonexistent config name → honest ENV_CONFIG_NOT_FOUND with searched dirs.

## Edge cases

- Env-config source dir contains MANY variants (Dev/Staging/Prod): tool copies only NAMED files; never glob-copies everything.
- Overwrite policy: if the clone already has the file with a DIFFERENT sha, report both shas and overwrite only when the arg says `force: true` (default false → report conflict, human-ish decision surfaced cheaply).
- Budget hit mid-diagnose-loop: report which revision number the cap allows next hour; do not partially write.
- The bridge's parked table rows from earlier sessions: left as-is (historical); new flow doesn't consult them.
- Security review of the tool by a second pass: ensure no arg shape can make it cat/echo contents (only cp + stat + sha).

## Acceptance

1. Suite green; new tests for provision semantics, budget caps, forced-sim injection, auto-apply provenance
2. A4a drill: ios-consumer Dev row GREEN with zero human actions in the transcript — the xcconfig step executed by the agent via the tool, sha reported
3. A4c drill: honest not-found blocker names file + searched dirs
4. Confirm-flow regression: REST apply-proposal (human door) unchanged; identifier flow untouched

## The reversal, honestly

This morning's review R1 argued the flip must be structurally human-confirmed. That was correct FOR THE MECHANISM AS THEN DESIGNED (a text-check the model could spoof). Autonomy doesn't weaken that finding — it obsoletes the need for it: when writes are append-only, oracle-judged, budget-capped, and provenance-stamped, the confirmation adds ceremony, not safety. The strong properties (reversibility, verify-as-oracle, read-scoped tools) are what we keep and strengthen.
