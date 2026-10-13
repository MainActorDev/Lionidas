# Review: agent repo-reading tools plan

- Plan reviewed: `plans/20261013T063129Z-agent-repo-reading-tools-plan.md` (Ready, pre-approved pipeline)
- Evidence: repo-refs.ts:185-260 (safeDir/repoDir + five existing tools), tools.ts:169-180 (sources.search shape), profiles.ts:65-95 (per-profile tool allowlists), brainstorm's verified gaps A/B/C
- Verdict: **Ready for implementation with 2 required edits** (1 High, 1 Medium — both cheap, neither blocking direction)

## Coverage

Traced brainstorm→plan→stages→acceptance; checked the plan's assumptions against the actual registration, permission, and allowlist machinery. Lenses applied: correctness, robustness, feasibility, verification. Lenses skipped: scalability (single-user operator tool), compliance (read-only, internal).

## Findings

### RR1 — HIGH — New tools are invisible without profile allowlist edits
- **Location:** plan §Stages A/B; §Interfaces.
- **Evidence:** `profiles.ts:73/91` — every profile declares an explicit `tools: [...]` allowlist (`planner`, `author`, `breaker`). Tools absent from the list are never given to the model regardless of registry.
- **Consequence:** the four tools register but no profile can call them; the live drill fails mysteriously; "the agent still can't read."
- **Correction:** Stage A/B must include adding `repo.read`, `repo.commit_files`, `repo.diff`, `repo.tree` to the allowlists (minimally `planner` + `author`; consider `breaker`). Also: the CHAT profile's tool set (conversation route builds from `registry.list()` filtered by policy — verify chat isn't allowlisted the same way; if it is, extend it too).
- **Verify:** `grep -rn "repo.read" src/agent/profiles.ts` + a test asserting the planner/author bundles include the tools.

### RR2 — MEDIUM — `repo.read` path-safety spec is thinner than the existing guard
- **Location:** plan §Interfaces (`repo.read { project, path }`), §Edge cases.
- **Evidence:** `safeDir()` only validates the PROJECT segment (`/^[A-Za-z0-9._-]+$/`); the new `path` parameter is a second injection surface the current tools don't have. `..` rejection is asserted as an edge case but the mechanism isn't specified; `path.join` alone does not normalize `..`.
- **Consequence:** `repo.read(project, '../../../etc/passwd')`-style traversal or absolute-path bypass becomes the one write-adjacent hole in a read-only toolset.
- **Correction:** specify: resolve `join(repoDir, path)`, then require `resolved.startsWith(repoDir + sep)` AND reject absolute inputs and any `..` segment before joining; same for `repo.tree`'s `path` and `repo.diff`'s `file`.
- **Verify:** traversal tests in Stage A/B explicitly list `..`, absolute, encoded, and symlink-free assumptions.

### RR3 — LOW — `sources.search` staleness note vs result shape
- **Evidence:** the tool returns a joined string, not JSON (`tools.ts:175`); plan says "include `snapshotAge` in results". A string tool result can carry the note as a prefix line — fine — but say so, so the test asserts the right shape.
- **Correction:** note as a first line `[snapshot: Ns old — refresh kicked]` when stale; plain results otherwise.

### RR4 — LOW — git availability assumed
- **Evidence:** plan runs local `git` via execFile; the repos are clones so git is present in dev. No CI risk found (tests can init fixture repos). No action needed beyond a fixture-based test (already in stages).

## Non-findings (checked, clean)

- safeDir project validation exists and is reused (repoDir regex).
- Permission 'read' fits the existing policy ladder (conversation route filters by permission rank).
- 12k cap matches the landed chunk policy — consistent.
- Butler untouched — correct; no tag bump needed.
- Staleness refresh detached (no lock/wait) — consistent with search being auxiliary.

## Required edits before implementation

1. Stages A/B: add allowlist edits (+ chat-profile verification) — RR1.
2. §Interfaces/§Edge cases: specify the containment check (resolved-prefix + `..`/absolute rejection) for every path-taking tool — RR2.
3. (Optional) RR3 note-shape sentence.

## What remains to validate during implementation

Live drill against 733e224-class merge; merge-commit diff sizing; the 52-tool regression; suite runs. The review inspected the plan on paper against current code only.
