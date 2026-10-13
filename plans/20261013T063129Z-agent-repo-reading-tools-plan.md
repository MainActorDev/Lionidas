# Agent repo-reading tools — PLAN

- Source brainstorm: `brainstorm/20261013T063129Z-agent-repo-reading-tools.md`
- Created: 2026-10-13T06:31:29Z
- Status: **Ready** — operator pre-approved the full pipeline ("Do the brainstorm -> plan -> review -> implement"); all decisions trace to verified code facts in the brainstorm

## Decision log

- **Approach = live reads + staleness-guarded search** (brainstorm Option 1 + 3). Rationale: verified that no file-content tool exists and the index is 6 days stale; harness-grade agents read files live, search is auxiliary.
- **Placement = `server/src/agent/repo-refs.ts`** beside the existing repo tools; tests in `server/test/agent-repo-read.test.ts`.
- **Caps = 12,000 chars** default (matches the landed chunk-cap policy `1e79223`), `offset`/`limit`/`file`/`maxChars` parameters, honest truncation markers.
- **Staleness threshold = 1h**, refresh is fire-and-forget with an honest note; reads NEVER depend on it.

## Objective and completion conditions

The agent can answer "read the code change", "show me this file", "what changed in this commit" against LIVE repo state. Done when:

1. Four tools registered and permission-gated read-only: `repo.read`, `repo.commit_files`, `repo.diff`, `repo.tree` — each honoring `safeDir()` (no path escapes), each capped at 12k chars by default with explicit truncation markers.
2. `repo.diff` on a merge commit (733e224-class) returns a useful stat + truncated hunks, NOT a 200k-token wall.
3. `sources.search` refreshes a >1h-stale repo snapshot in the background and says so honestly when results predate the refresh.
4. The originating failure scenario passes live: "what is commit 733e224 about? read the code change" → answer cites actual diff content from today's commits, with tool_call events in the durable log.
5. Suites green (server + web + tsc), no regressions in the 52 existing tools.

## Scope

**In:** the four tools + staleness seam in repo-refs.ts/sources.ts; system-prompt mention so the model knows file reading exists; tests; live drill.

**Out:** index-freshness guarantees for reads (reads are always live), LSP/tree-sitter symbol tooling, writes of any kind, new UI.

## Interfaces

```
repo.read      { project, path, offset?, limit? }         → { path, lines, totalLines, truncated? }
repo.commit_files { project, sha }                        → { sha, subject, files: [{path, status, adds, dels}] }
repo.diff      { project, sha, file?, maxChars? }         → { sha, stat, hunks, truncated? }
repo.tree      { project, path? }                         → { entries: [{name, kind, bytes}] }
```

All run local `git` (execFile) or fs reads under `safeDir(project)`. Errors are honest strings (`invalid project name`, `path not found`, `file too large — use offset/limit`).

## Stages

### A — `repo.read` + `repo.tree` (the basics)
fs reads with line numbering, 12k cap, offset/limit. **Containment (review RR2):** resolve `join(repoDir, path)`, then require `resolved === repoDir || resolved.startsWith(repoDir + path.sep)`; reject absolute inputs and any `..` segment BEFORE joining. Same check for `repo.tree`'s `path`. Tests: happy path, path-escape rejection (`..`, absolute, nested traversal), binary detection (reject with honest error), truncation marker, empty dir.
### B — `repo.commit_files` + `repo.diff` + **allowlists (review RR1)**
git show --name-status + --stat; per-file hunks with global char cap; file filter (same containment check on `file`). **Add `repo.read`, `repo.commit_files`, `repo.diff`, `repo.tree` to the profile allowlists** (`profiles.ts` planner + author; chat route verified — it filters `registry.list()` by permission, not allowlist, but assert it in a test). Tests: ordinary commit, merge commit (hundreds of files → stat list + truncated hunks), unknown sha, path traversal in `file` param rejected, allowlist presence.
### C — `sources.search` staleness guard + system-prompt line
Track last-ingest per source; on search, if >1h, fire re-ingest (existing pipeline) in background; when stale, prefix the (string) result with a first line `[snapshot: Ns old — refresh kicked]` (review RR3); fresh searches return plain results. System prompt gains one sentence: "You can read registered repos live via repo.read/repo.diff/repo.commit_files/repo.tree." Tests: stale → refresh kicked (mocked), fresh → no kick, note content.
### D — Live drill + PR update
Restart server; run the originating scenario end-to-end; verify durable log shows the new tool calls; push to `feat/agent-round3` (PR #36).

## Edge cases bound into stages

- Merge commits (huge diffs) → stat-first, hunks truncated, model follows up with repo.read.
- Binary files → rejected honestly, never guessed at.
- `path` containing `..` or absolute → safeDir rejection (same guard as existing tools).
- Repo missing on disk → `repo.list`-consistent error.
- Concurrent refresh + search → refresh is detached; search returns current snapshot with age note (no lock, no wait).

## Validation & acceptance

1. Unit suites for A/B/C as listed.
2. Live: "what is 733e224 about? read the code change" → cites today's diff; `butler_turn_events` shows `repo.commit_files`/`repo.diff`/`repo.read` calls.
3. Full suites: server, web, tsc ×2; butler untouched (no tag bump).
4. Oversized-result guard: no tool result exceeds its cap (asserted in tests).

## Rollout

Single commit set on `feat/agent-round3`; PR #36 grows; human merge gate unchanged.
