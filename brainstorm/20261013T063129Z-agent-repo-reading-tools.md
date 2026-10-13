# Agent repo-reading tools — close the "can't read the codebase" gap

- Source prompt: "What can't the agent read codebase in the registered repo?" followed by diagnosis acceptance and "Do the brainstorm -> plan -> review -> implement"
- Created: 2026-10-13T06:31:29Z
- Status: Direction selected (operator approved full pipeline in one command)

## Goal and context

The Lionidas agent cannot actually READ registered repos' code today. When a user asks "read the code change and show it to me" or "what is this commit about?", the model falls back to week-old indexed snapshots and gets oversized-tool-result errors. The user wants the agent to read live repo state like a developer would: files, diffs, changed-file lists.

## Confirmed inputs and decisions (verified in code, 2026-10-13)

1. **Verified gap A — no file-content tools.** Registered repo tools are metadata-only: `repo.list`, `repo.branches`, `repo.commits` (sha/author/72-char subject only), `repo.pulls`, `repo.apps` (`server/src/agent/repo-refs.ts:199-260`). No `repo.read`, no diff, no changed-files tool exists anywhere in the registry (52 tools enumerated).
2. **Verified gap B — stale partial snapshot.** `sources.search` reads `butler_documents`; intl repo last ingested 2026-10-07 13:18 (6 days stale). Coverage 872/3,538 Swift files (2,000-file walk cap; historical junk ingestion). Today's commit 733e224's stepper changes are absent; the two StatusStepper docs in the store are pre-PR versions.
3. **Verified gap C — no diff surface.** No tool returns a commit's changed files or patch (`grep patch|diff repo-refs.ts` → nothing).
4. **Prior fix (landed today, commit `1e79223`):** chunks capped at 12k chars, `.derived-data`/`Pods`/`.build`/`.swiftpm`/`buck-out` skipped on walks, live store purged+resharded (max chunk 12,988 chars). That fixed oversized results but did NOT add reading capability.
5. Operator instruction (verbatim): "Do the brainstorm -> plan -> review -> implement" — full pipeline in one pass; merge gates remain human-only.

## Exploration

**Options considered for "how the agent reads code":**

- **Option 1 — direct live filesystem reads (CHOSEN for reads):** new `repo.read` / `repo.commit_files` / `repo.diff` tools running `git` + file reads against `server/repos/<name>` directly. Always current, trivially correct scope (one repo dir), no index maintenance. Matches what Claude Code/Codex agents do — the harness reads files live, search is auxiliary.
- **Option 2 — always-fresh re-ingest before search:** re-walk the repo on every `sources.search`. Rejected as the primary fix: 2,000-file walks per question are slow, still no diff/file targeting, and the walk cap still truncates.
- **Option 3 — hybrid staleness guard (CHOSEN for search freshness):** `sources.search` transparently refreshes the repo when the snapshot is >1h old (background, non-blocking on the first miss with an honest "snapshot refreshed mid-answer" note when it lands late). Keeps search useful without making reads depend on an index.
- Bigger indexes (LSP, tree-sitter symbols) — explicitly out; that's a different round.

**Tool safety shape:** all new tools are read-only, scoped by the existing `safeDir()` guard (no `../` escapes), with hard output caps (12k chars, same as the chunk cap) and line/offset parameters mirroring the provider's own error guidance ("use offset and limit parameters").

**Diff sizing:** full patches can still be huge (a merge commit like 733e224 touches hundreds of files). `repo.diff` returns per-file stat + truncated hunks by default, with `file` filter and `maxChars` override — the model composes detail via `repo.read` on the files it cares about.

## Proposed direction

Four read tools + one freshness seam, all in `server/src/agent/repo-refs.ts` (they belong with their siblings, no new files needed but one test file):

1. `repo.read(project, path, offset?, limit?)` — live file read, 12k-char cap, line-numbered, honest truncation marker.
2. `repo.commit_files(project, sha)` — changed-file list with +/- stats (git show --name-status).
3. `repo.diff(project, sha, file?, maxChars?)` — stat summary + filtered hunks, 12k default cap.
4. `repo.tree(project, path?)` — directory listing (the agent has no way to browse either).
5. `sources.search` staleness guard — if the repo snapshot backing the search is >1h old, kick a re-ingest; note surfaces when results predate it.

## Open questions

None blocking — operator pre-approved the pipeline. Defaults chosen: 12k caps (matches chunk policy), 1h staleness threshold, diff-per-file truncation. All reversible.

## Next step

Plan (`hms-plan-from-brainstorm`) → review (`hms-review-detailed-plan`) → implement on `feat/agent-round3`, tests + live drill, PR #36 updated.
