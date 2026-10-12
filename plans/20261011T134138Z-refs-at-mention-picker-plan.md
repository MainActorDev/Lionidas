# Refs @-mention picker — implementation plan

- Source brainstorm: `brainstorm/20261011T134138Z-refs-at-mention-picker.md` (status: Direction selected; all open questions answered by the operator 2026-10-11)
- Decision log (operator answers, 2026-10-11):
  1. Attachments enter the pipeline as a NEW `attachment` ref kind.
  2. Branch selection for commits: SEARCHABLE branch picker seeded with the top-3 active branches ("It's to avoid a long list of branch.").
  3. Jira auth: server env `JIRA_TOKEN` (secrets policy; `JIRA_TOKEN` seam already exists in `server/src/secrets.ts`).
  4. Paste/drag-drop to attach: in v1.
  5. Multi-select: Enter-stays-open + Esc/Tab/click-input commits for @jira and @repo lists; @attachment single-select only (re-mention for more) — folded into the brainstorm 2026-10-11 (`d056063`).
- Created: 2026-10-11T13:50:09Z
- Status: Ready

## Objective and completion conditions

Replace the free-typed "＋ refs" composer picker with an @-mention system. Done when:

1. Typing `@` in the composer opens the family menu (jira / repo / attachment); refs are creatable ONLY through the pickers — the old free-typed kind+locator form is gone.
2. Each family's flow works end-to-end (search → select → chip → send → pipeline) per the flows below.
3. Chips render as capsules in the input line and map to `PipelineRef[]` on send; multiple chips compose.
4. All new fetch/search capabilities exist as Lionidas registry tools (read class) AND the UI routes call the same functions.
5. All sad paths show honest states (never spinners); the acceptance drills at each stage pass.

## Scope

**In:** composer @-menus (3 families, two-level repo, searchable branch picker), attachments store+route+tool+paste/drop, Jira search route+tool+menu (env-gated), repo commits/PRs via `gh` route+tools+menu, `attachment` pipeline kind + compile, tests for all of it.

**Out:** editing/deleting stored attachments (delete = out of v1), Jira OAuth per-user, non-default-branch PR filtering, PDF/Office text extraction (v1 stores binary + manifest; compiles text-like files only), the run panel (unchanged).

## Verified facts (checked 2026-10-11)

- `PipelineRef` is `{ kind: RefKind; locator; note? }`; `RefKind = 'jira'|'github-pr'|'github-commit'|'doc'|'repo'` (`server/src/agent/knowledge.ts:12-18`). The pipeline input takes `refs: PipelineRef[]` — arrays already flow.
- Composer slash-menu + chip machinery exists (rev 21/22: menu, ↑↓/Enter/Tab/Esc, chip commit/revert, registered-only rule) — `web/src/pages/agent/components/Composer.vue`.
- Butler `jiraConnector` exists (fixture-tested, takes baseUrl/project/authHeader/jql); `JIRA_TOKEN` env seam exists in `server/src/secrets.ts:11`.
- Registered repos live on disk under `server/repos/` (ios-consumer, ios-consumer-intl); the sources table tracks ingested repos.
- `CRUCIBLE_GITHUB_TOKEN` is in the env seams; `gh` CLI is available on this machine.
- Artifacts dir seam (`CRUCIBLE_ARTIFACTS_DIR`) exists; no attachments store today.
- The agent registry (41 tools, read/draft policy) is the internal-tools mechanism; HTTP + MCP both mount it.

## Interfaces

- `POST /api/agent/attachments` (multipart, operator-gated): file → `{ id, fileName, bytes, sha256 }`. Cap 10 MB. Stored `artifacts/attachments/{sha}` + manifest row.
- `GET /api/agent/refs/jira?q=` (operator-gated) → `{ issues: [{key, title, type}], configured }`. Debounced client-side.
- `GET /api/agent/refs/repos` → `{ repos: [name] }` (from `server/repos/` + sources).
- `GET /api/agent/refs/repos/{project}/branches` → seeded: top-3 by recent commit activity, then search-over-all on query.
- `GET /api/agent/refs/repos/{project}/commits?branch=&q=` and `.../pulls?q=` → `{ rows: [{id, title, meta}] }` via `gh api` (fixed argv, timeout, output cap).
- Registry tools (read class): `jira.search {query}`, `repo.list {}`, `repo.branches {project, q?}`, `repo.commits {project, branch?}`, `repo.pulls {project}`, `attachment.get {id}` (returns extracted text or a manifest).
- `RefKind` gains `'attachment'`; compileKnowledge reads attachment text/manifest.

## Stages (ordered; each ends with its own verification)

### F1 — Composer @-menu + chip plumbing (M)
1. `@` opens family menu (reuse slash-menu anatomy: rows, ↑↓, Enter/Tab, Esc, click, registered-only).
2. Ref chips render in the input line beside the command chip; capsule `@jira:KEY`, `@repo:proj/sha`, `@attachment:name`; ✕ per chip; Backspace-on-empty removes last; dedup by (kind, locator); cap 8 with footer "n/8".
3. Family menu advances to the (stubbed) level-2 menus; stubs return fixed rows so F1 is demoable alone.
4. Send assembles `PipelineRef[]` (attachment → new kind string; pipeline-side lands in F5).
Verification: browser drill — open/navigate/chip/remove/dedup/cap; vitest composer tests (menu states, chip model, dedup, cap); vue-tsc.

### F2 — Attachments (M)
1. `POST /api/agent/attachments` (multipart via @fastify/multipart), sha-deduped store, manifest table, 10 MB cap, operator gate.
2. `attachment.get` registry tool (text/markdown passthrough; images + others → manifest with name/size/shash; honest "binary — not extracted" line).
3. Picker: `@attachment` → file input; **paste and drag-drop** on the textarea upload and chip directly.
4. Send-time validation: dead attachment id → system note, rest proceed.
Verification: route tests (upload, dedup, cap, 401); tool test; browser drill incl. paste-to-chip; dead-id drill.

### F3 — Jira search (M)
1. `jira.search` tool + `GET /api/agent/refs/jira` sharing one implementation; JQL text-search + key-prefix; type badges from issue fields.
2. `@jira` menu: search-first (300 ms debounce), multi-select (Enter-stays-open, checkmark+dim, counter, Esc/Tab commits).
3. Unconfigured → honest empty state naming `JIRA_TOKEN`; 401/rate-limit/zero-result distinct rows; typed `@jira:KEY` plain text is NOT a ref.
Verification: hermetic tests with a fake fetcher (results, empty, 401); live drill only if a token is configured; browser drill of multi-select.

### F4 — Repo two-level menu + branch picker (L)
1. Tools + routes for repos/branches/commits/pulls via `gh` (default token env; fixed argv; timeouts; caps).
2. `@repo` level 1 single-select (repos list) → level 2 segmented Commits | PRs with search; commits scoped by the branch picker (top-3 active seed, searchable beyond); PRs branch-less.
3. Multi-select on the commits/PRs list; chips `@repo:proj/{sha8}` and `@repo:proj/PR-n`.
4. Honest states: gh missing/unauthed/private repo; empty search; slow gh (loading row + timeout).
Verification: tool tests with a fake gh binary (list/segments/errors); browser drill of both levels + branch search; cap across chips.

### F5 — Pipeline `attachment` kind (S)
1. `RefKind |= 'attachment'`; compileKnowledge handles it (text merges; binary → manifest line into the page).
2. `/api/agent/pipeline` accepts the kind; tests for compile with mixed refs.
Verification: pipeline test with a mixed ref set (jira fixture + attachment fixture); tsc across all.

## Edge cases (bind into the stages above)

- Pasted `@jira:LP-1` text ≠ ref (registered-only chips, rev-22 rule).
- Duplicate selection no-ops; cap blocks with reason.
- Attachment deleted pre-send → drop-with-note (F2.4).
- Branch choice pins the LIST; the chip's SHA pins the content (menu subtitle says so).
- Offline/unconfigured degrade per family; chat never blocks.

## Validation & acceptance (end-to-end, after F5)

1. Full drill: `@jira` multi-select 2 tickets + `@repo` 1 PR + paste-attach 1 image → send → knowledge compile merges all → gated pipeline runs.
2. Sad-path sweep: no JIRA_TOKEN, no gh, oversized attachment, dead attachment id, 8-ref cap.
3. Suites: server (new route/tool tests), web (composer/menu tests), vue-tsc + tsc 0; butler untouched this round.

## Rollout

Single PR off main (`feat/refs-at-mention`), human merge per standing rule. `.env.example` gains `JIRA_TOKEN`/`GITHUB_TOKEN` notes. No migration needed (attachment manifest is a new table; RefKind widening is additive).
