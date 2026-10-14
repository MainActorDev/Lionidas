# Identifier gate + /implement-identifiers — PLAN

- Source brainstorm: `brainstorm/20261014T132710Z-identifier-gate-and-skill.md` (`486a067` + pivot `f881fd4` + CI-decision in-thread)
- Created: 2026-10-14T13:47:52Z
- Status: Ready

## Goal and context

Hard-block case creation when a step's `identifier:` selector doesn't exist in the app's codebase, and provide `/implement-identifiers` (pipeline order 4) which implements missing identifiers via the claude CLI editing inside a **git worktree**, with the host owning all git. CI (not local xcodebuild, no artifacts) is the compile gate. User decisions: write-mode yes (safest workflow), dynamic identifiers pass-with-note (default, pending user ack), slash command in Lionidas, naming recommend-only.

## Confirmed inputs and decisions

All code-verified during brainstorm:
- `resolveCaseRefs` (server/src/routes/templates.ts:213) is the validation seam every save path flows through; it checks screens/recipes/scenarios refs today, no identifier check.
- Selector grammar: plain `on:` string = identifier iff `^[a-z][a-z0-9_]*$` (case-yaml.ts:368); mapping form `{identifier|label|labelContains|ignoreCase|type}`. Gate must inspect steps + setup + screen-registry navigate entries.
- Ingest: `ingest()` (butler connector.ts:45) is content-addressed, called by lionidas sources.ts on seed/refresh; docs carry uri/title/content — Swift chunks land in butler_documents. The index can be built POST-ingest by scanning new/changed docs (no butler change needed for indexing; a lionidas-side scan of butler_documents per repo sync).
- Repo roots: `CRUCIBLE_REPOS_ROOT` (default ./repos); repo.apps maps bundles→repos; claude-cli provider spawn opts (env/binPath/mcpConfigPath) already exist — `cwd` is a 1-line addition.
- User decisions this round: CLI edits (no repo.edit MCP tool), worktrees, CI-gated compile (no ipa/apk), plan-phase must verify the app repo has a compile-type PR check (fallback: local compile, only if CI absent).

## Implementation steps

### Phase I — identifier index + gate (server)

**1. Index table + builder** (`server/src/agent/identifier-index.ts`)
- `app_identifiers(id, bundle, identifier, file, line, kind 'literal'|'dynamic', indexed_at)` in the MAIN db (queryable by routes/validation; indexed by (bundle, identifier)).
- Builder (review PR1: scans the REPO WORKING TREE — `<reposRoot>/<repo>` on disk — NOT butler_documents; content-addressed doc stores never forget deleted files, so a docs-based index would pass ghosts): walk *.swift, extract `.accessibilityIdentifier("…")`, `accessibilityIdentifier\s*=\s*"…"`, `.identifier("…")`; literal → one row per string with REAL file+line; non-literal arg → one `dynamic` row for the call site.
- Hook: after the repo sync (sources.ts) → rebuild that repo's bundles (delete+insert in one txn). Manual `POST /api/agent/identifiers/reindex` (operator) for first-time backfill.
- Staleness (PR1): meta records `head_sha` (git rev-parse of the repo at index time); gate compares against origin/develop HEAD when it can — a PRECISE staleness oracle — plus `indexed_at`, files count.

**2. The gate** (inside `resolveCaseRefs`)
- Collect identifiers: every step/setup `on:` plain-string matching IDENTIFIER_RE + every `{identifier:}` mapping + screen-registry navigate `on:` strings for referenced screens.
- Lookups: literal hit → pass. Miss + dynamic row for that bundle → pass with a WARNING row in the (valid) response: `dynamic-identifier: <id> — trust note expected` (review PR2(a): resolveCaseRefs is pure sync — it cannot enforce a later note.save; the /author instructions already mandate notes, and the warning surfaces in UI + model context without new orchestration machinery). Miss + nothing → block with: `INVALID: step N uses identifier "X" which does not exist in <repo> (F files indexed at HEAD <sha>, T ago). Use /implement-identifiers to add it, or switch to a label selector.` Missing meta → `INVALID: no identifier index for <bundle> — POST /api/agent/identifiers/reindex (sources ingest first)`.
- case.validate gets it free (same function); MCP + REST paths inherit.

**3. Tests** (`identifier-gate.test.ts`): literal present saves; absent blocks with exact message; dynamic passes (+note required); stale meta disclosed; no-index path; setup steps + registry entries covered; plain-string vs mapping form both gated.

### Phase II — worktree driver + CLI cwd (host-owned git)

**4. Butler: provider `cwd` option** (spawn opts): `claudeCliProvider({..., cwd })` → `spawn(bin, args, { cwd, ... })`. Default unchanged. Test in butler (fake binary asserts process.cwd()).

**5. Worktree driver** (`server/src/agent/worktree.ts`)
- `create(repo, slug)`: fetch origin, `git worktree add <reposRoot>/.wt/<repo>-<slug> -b feat/identifiers-<slug> origin/develop` (branch base = origin/develop, never local state).
- `commitEach(wtPath, entries)`: per identifier one commit `feat(a11y): add identifier <id> (<screen>) — unblocks case <caseId>`; only the files the CLI touched (git status diff-based).
- `pushAndVerify(wtPath, pr)`: push, `gh pr create --fill` with body (unblocked cases, retired notes, "CI compile check required before merge"), then `gh pr checks <n>` poll (non-blocking; turn ENDS at PR open + checks pending; status page/queue shows CI result later). On compile-check failure: report, keep worktree for one CLI retry round, else discard.
- `remove(wtPath)`: `git worktree remove --force` + branch delete (post-merge cleanup path too).
- Guards (review PR3): worktrees live at `<reposRoot>/.wt/<repo>-<slug>` (DERIVED from CRUCIBLE_REPOS_ROOT, never hardcoded `repos/`); sources.ts repo walk EXCLUDES dot-directories (verify + test: `.wt` must never be ingested as a repo); driver refuses if `git status` in the main repo is dirty (protect user WIP).

**6. Driver tests** (fake git via PATH-shim binary): branch-from-develop asserted; commit messages carry case ids; PR body contains linkage; dirty-main-refusal; remove cleans up.

### Phase III — /implement-identifiers command

**7. Command registration** (commands.ts): order 4, instructions: gather missing ids → propose table (file, line, insert text, recommended name from convention mining: dominant prefix pattern among existing literal identifiers for the bundle) → WAIT FOR USER CONFIRMATION (hard stop; no worktree before "yes") → worktree+CLI edit → commits → push/PR → report + park case yaml as note (kind author-parked, scope case). Parked yaml rides the note body — CAP at 50KB (validator-guarded on resume); oversized cases park as an agent draft instead (review PR5).

**8. Turn plumbing**: commandOverlay tools = repo reads + case/screen tools (as author); CLI spawn for the edit step uses the provider cwd seam with the worktree path; the host drives git between provider calls (the turn orchestrates: propose (chat) → confirm (chat) → spawn CLI in wt (one provider call with edit instructions) → host commits/pushes/PR → report).

**9. Command tests**: proposal renders from gate error; NO worktree created without confirmation (asserted); orchestration order (branch→edit→commit→PR) via driver mocks; park note saved with the yaml.

### Phase IV — loop closure + proof

**10. Resume-after-merge**: re-ingest (existing sources refresh) rebuilds the index → parked note carries the case yaml + missing ids; a "resume" ask (or /author seeing the parked note) re-validates → gate passes → save. No new machinery beyond the note convention + instruction.

**11. CI verification (plan-phase promise; review PR4 matcher)**: read `.github/workflows/*`; a COMPILE CHECK = a workflow triggering on `pull_request` (or push to the PR branch) whose steps include `xcodebuild` with `-scheme` and no required `archive`/`export` (or an Xcode build action e.g. `xcode-build`/`maxim-lobanov/setup-xcode`). If no match → the documented fallback (local compile) is surfaced to the USER as a decision, never silently chosen.

**12. Live E2E drill on a real registered repo** (ios-consumer worktree, main untouched): block → propose → confirm → branch → CLI edits → commits → PR (CI pending) → merge the drill PR → reindex → resume → case SAVES. Screenshot/log each stage into the PR description of the feature PR.

**13. Docs**: system-prompt selector-strategy section gains the gate + command; README workflow section; suite green (server+web+tsc), butler suite green.

## Acceptance criteria

1. Case with absent identifier is REFUSED (REST+MCP+validate) with the actionable message naming the identifier, file count, index age, and the command.
2. Present identifier passes; dynamic call-site passes with a required trust note; missing index gives the ingest instruction — all test-asserted.
3. Setup steps and screen-registry navigate entries are gated identically.
4. /implement-identifiers: proposal table → hard confirmation gate → worktree from origin/develop → CLI edits (Bash still denied) → per-identifier commits with case linkage → PR create-only with linkage body → worktree cleaned. No write occurs pre-confirmation (test).
5. CI compile check is the gate; no .ipa/.apk produced anywhere; local xcodebuild absent from the pipeline unless CI is proven absent (step 11 fallback).
6. Parked case yaml survives; after merge+reindex the same case saves unchanged.
7. E2E drill (step 12) passes on a real repo with main untouched.

## Out of scope

Android (.apk) — the design leaves the seam (driver is repo-kind agnostic) but no Android build tooling; label-selector runtime verification; identifier correctness-on-right-control (existence only, v1); auto-merge of any PR; Hermes-skill packaging.
