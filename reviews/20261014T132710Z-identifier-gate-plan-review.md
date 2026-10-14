# Review: identifier gate + /implement-identifiers plan

- Plan reviewed: `plans/20261014T132710Z-identifier-gate-plan.md` @ Ready
- Evidence: server/src/routes/templates.ts (resolveCaseRefs), server/src/agent/sources.ts (ingest hook), butler connector.ts:45 (content-addressed ingest), claude-cli provider spawn, case-yaml.ts selector grammar, commands.ts pipeline, user decisions in-thread (worktree/CLI/CI/no-artifacts).

## Verdict

**Approve with corrections** — the architecture matches every user decision (CLI edits in worktree, host-owns-git, CI gate, no artifacts), the gate seam is right, and the loop closes. Four findings; PR1 changes data flow, the rest tighten.

## Findings

### PR1 (High) — the index cannot be rebuilt from butler_documents alone; it needs the repo working tree

The plan builds `app_identifiers` by "scanning butler_documents rows whose uri ends .swift". But repo docs land in butler's store as CHUNKS with byte-offset addressing and `bytes_path` files — and the plan's own line-number promise ("line from chunk offset best-effort") is not derivable from chunk text without the original doc. Worse, content-addressing means DELETED files never disappear from butler_documents — rebuild would keep identifiers whose code was removed, and the gate would pass on ghosts (exactly the false-trust class this gate exists to kill).

**Correction**: the builder scans the REPO WORKING TREE (`repos/<repo>` — already on disk, sources.ts syncs it), not butler_documents: `rg`-style walk of *.swift, extract literal+dynamic call sites with real file:line, plus record `head_sha` (git rev-parse) in meta. butler ingest stays what it is (retrieval); the index is a *code artifact inventory* tied to a commit. Reindex hook = after repo sync + the manual endpoint. This also fixes staleness honesty: meta.head_sha vs origin/develop HEAD is a precise staleness oracle.

### PR2 (Medium) — "note required" for dynamic pass is unenforceable as specified

"validated: note.save must be called before save completes" — resolveCaseRefs is a pure sync function; it cannot observe a later tool call. Either the save tool grows orchestration (complex) or the requirement is honest-but-soft.

**Correction (pick one, state it)**: (a) drop the hard requirement — the /author instructions already mandate selector-trust notes; the gate returns a WARNING row in the (valid) response listing `dynamic-identifier: <id> — trust note expected` (visible in UI + model context). Recommended: keeps resolveCaseRefs pure. (b) Enforce via a per-case validation note marker — new machinery, not worth v1.

### PR3 (Medium) — worktree path guard: `repos/.wt/` vs CRUCIBLE_REPOS_ROOT semantics

Plan puts worktrees under `repos/.wt/` but the repos root is env-configurable; hardcoding `repos/` breaks other deployments, and a worktree dir that the repo-walk might INDEX (sources.ts walks reposRoot children!) would ingest throwaway worktrees as if they were repos.

**Correction**: worktrees live at `<reposRoot>/.wt/<repo>-<slug>` (derived, not hardcoded) AND sources.ts walk must EXCLUDE dot-directories (verify: it iterates `readdir` — confirm skip rule; if absent, add `.wt` + dotfile skip to the walk). Test both.

### PR4 (Low) — CI "compile check" identification needs a concrete matcher

"assert a build/compile job triggers on PRs" — repos name jobs differently. The verification (step 11) needs a rule: a workflow with `on: pull_request` (or push to the PR branch) whose steps include `xcodebuild` (with `-scheme`, without requiring `archive`/`export`) or an Xcode GitHub Action (`xcode-build`, `maxim-lobanov/setup-xcode`). State the matcher in the plan so "verified" is checkable; if no match → the documented fallback (local compile) and a user-facing note, per the plan.

### PR5 (Low) — parked-case note carries YAML; size + injection

Parked yaml rides a note body. Cap it (notes have practical size limits — check storage; if > ~50KB typical, park as an agent draft instead). Also the resume path re-parses user-provided YAML — already validator-guarded, fine; just note it.

## Questions

None blocking — PR1's correction is a design fix the implementer applies per this review; PR2(a) recommended.

## Result

Apply PR1 (scan working tree + head_sha meta, not butler docs), PR2(a) (warning row, not enforcement), PR3 (derived .wt path + walk exclusion + tests), PR4 (CI matcher named), PR5 (park cap noted). Mechanical edits; no re-review.
