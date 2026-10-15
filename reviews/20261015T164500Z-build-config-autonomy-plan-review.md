# Review — Build-Config Autonomy Plan

- Plan reviewed: `plans/20261015T164500Z-build-config-autonomy-plan.md` (READY)
- Evidence: bridge implementation + its live drills (this branch), Foodiary/intl verify history (green without secrets), ios-consumer rev1-4 saga, `build-config-flow.ts`/`config-tools.ts` seams, projects/builds.ts verify path, butler tool-context shape
- Review date: 2026-10-15
- Verdict: **Needs revision** — 1 Critical, 2 High; corrections are plan-level. One operator decision surfaced (not blocking, default chosen).

## Coverage

The tier table (simulator/signing/distribution) traces to the design sections: simulator-slice → auto-apply + provision tool; signing → toggle; distribution → absent-by-design. The "reversal" section honestly names the conflict with this morning's R1 and reframes rather than contradicting it. What was checked on paper: tool-surface safety (cp semantics), budget-rail computability, the demoted-but-kept confirm machinery, backward compatibility of the REST human door. What needs execution: the A4 drills, especially whether auto-verify storms are prevented by the budget rails.

## Findings

### R1 — CRITICAL: `env_config.provision` as specified can exfiltrate ANY readable file's presence+sha, and worse, copy ARBITRARY files into the clone

- Location: Design §2
- Evidence: args are `{projectId, files: [names or globs]}` copied from registered source dirs into the workspace. Two attacks: (a) glob like `*` or `*.p12`/`*.pem`/`id_rsa` in a source dir that also holds keys → agent copies credential FILES into the repo workspace (contents still unread, but now sitting in a clone that future tools — repo.read! — can read as text if text-like); (b) the sha+bytes report is a partial-read oracle (existence + fingerprint of any file in source dirs).
- Consequence: the "never ingest values" law breaks via the copy itself: repo tools read the clone. A copied `.env`-style file IS readable content once it lands in the workspace.
- Correction: hard allowlist by EXTENSION and pattern — ONLY `*.xcconfig` (and explicitly `*.mobileconfig`? no — start xcconfig-only). No globs: exact filenames only, resolved with `basename()` equality. Copy destination stays the clone root (matches pbxproj references) but the tool MUST refuse any name containing a path separator. Post-copy, mark the file in a `provisioned_files` table with sha so the status page shows what the agent placed. Also: source dirs must be configured to EXCLUDE credential-looking names (`*.p8`, `*.p12`, `*.pem`, `id_*`, `*.key`) — refuse loudly if a requested name matches.
- Verify fix: plan §2 rewritten with allowlist + exact-name + refuse-list + provisioning ledger; A1 tests assert each refusal.

### R2 — HIGH: auto-apply + auto-verify + auto-diagnose composes into an unbounded agent loop the budget rails don't fully bound

- Location: Design §1 + §3
- Evidence: instructions say "if verify fails, diagnose and revise up to the budget" — 3 revisions/hour is the cap, but each revision can fire verify (2 per revision = 6 builds/hour/project), each a real xcodebuild. Three projects × a stuck agent = ~18 builds/hour on one dev machine, plus pod installs. ALSO: the loop is model-driven within a turn; turn-level loops are bounded by butler's hops, but the COST per hop is what's uncapped.
- Consequence: resource exhaustion + a stuck model burning context on repeat failures (the 1M-token incident class).
- Correction: a single project-level **verify budget: max 3 verify fires per rolling hour, project-scoped** (not per-revision), checked in startBuildVerify itself (the engine enforces, not the prompt); when exhausted, the tool returns `VERIFY_BUDGET_EXHAUSTED (next eligible HH:MM)` and the command instructions say END THE TURN reporting the last failure + what was tried — the human looks when they look. Additionally: a failed verify whose log's first hard error is IDENTICAL to the previous revision's (normalized) must not auto-revise — same-error loops are the stuck signature.
- Verify fix: §3 rewritten (engine-enforced project/hour budget + identical-error circuit breaker); A2 tests cover both.

### R3 — HIGH: the "signing toggle" injection rule can silently change builds (`CODE_SIGNING_ALLOWED=NO` injected when unset)

- Location: Design §4
- Evidence: "verify recipes are forced to simulator destinations + CODE_SIGNING_ALLOWED=NO is injected into build steps that don't set it" — mutating the user's recipe command changes what is verified vs what the team's lane actually runs; a green under injected flags proves less than it appears (the strong-mechanism principle cuts BOTH ways: the oracle must judge the real command).
- Consequence: false-green risk — exactly what this system exists to kill.
- Correction: do NOT inject silently. Two modes, explicit: (a) recipe already says simulator/unsigned → verify as-written; (b) recipe names a device destination on an untoggled project → **refuse** with `DEVICE_SIGNING_BLOCKED (enable projects.allow_device_signing)` — an honest refusal beats a quietly modified build. Injection allowed ONLY as a recipe step the agent itself writes (visible in the row, provenance-cited).
- Verify fix: §4 rewritten (refuse-don't-mutate); A3 test asserts the refusal string.

### R4 — MEDIUM: provenance `ai-auto` launders nothing but READS wrong — the UI/canary should distinguish agent-autonomous rows at a glance

- Location: Design §1/§3
- Evidence: `by: 'agent-auto'|'ai-auto'` is carried but nothing renders it; the Projects chip shows rev N + verdict only.
- Consequence: a human reviewing later can't tell which rows nobody approved — the audit trail exists but is invisible where decisions are made.
- Correction: chip/panel shows a small `auto` marker on revisions whose provenance is `*-auto`; canary counts autonomous rows in the card detail. Cheap, do it in A2.
- Verify fix: §1 adds the render note.

### R5 — MEDIUM: A4a "zero human actions" overstates — the sources setting must exist first (a human registers the dev-checkout dir once)

- Location: Stages A4a
- Evidence: `env_config_sources` default includes the sibling dev-checkout convention — on THIS machine that default works; on a fresh install it's empty → provision returns not-found → the drill fails.
- Consequence: acceptance claims "zero human" while depending on a one-time registration the plan itself introduces.
- Correction: reword A4a to "zero human actions after one-time source registration (this machine: default path already valid)"; note the bootstrap-on-new-machines is precisely the honest human moment the design keeps.
- Verify fix: A4a wording.

### R6 — LOW: demoted confirm machinery — specify the boundary precisely or it will rot

- Location: Design §1 (parked-proposal kept "for cross-repo PR proposals")
- Evidence: no current tool uses it after auto-apply; the identifier flow uses its OWN sibling table. Dead-but-kept code with a speculative future is how the FK-in-the-wrong-place bug happened.
- Correction: keep the build_config_proposals table (historical rows + the REST door semantics unchanged) but mark the consumeConfirmation seam as IDENTIFIER-FLOW-ONLY in comments; delete nothing this PR; revisit when a cross-repo proposal tool actually lands.
- Verify fix: §1 boundary sentence.

## Questions for the human (non-blocking, defaults chosen)

1. Default `env_config_sources` on a fresh install: empty (register manually) vs auto-include `~/.lionidas/env-configs/<project>/` if it exists? **Default: auto-include the ~/.lionidas path, empty otherwise.**
2. Verify budget number: 3/hour/project proposed. **Default stands unless you want 2.**

## Necessary edits to the plan

1. R1: allowlist (*.xcconfig only), exact filenames, no path separators, refuse-list of credential-looking names, provisioning ledger table
2. R2: engine-enforced project/hour verify budget + identical-error circuit breaker + end-turn instruction on exhaustion
3. R3: refuse device destinations on untoggled projects — no silent injection
4. R4: `auto` marker rendered on chips/panel/canary
5. R5: A4a one-time-registration wording
6. R6: consumeConfirmation marked identifier-flow-only

## What remains to validate during implementation

The A4 drills; the exfiltration-refusal tests (R1); budget exhaustion behavior under a deliberately stuck loop; that Foodiary/intl flows are unchanged by auto-apply (they never used confirm anyway).
