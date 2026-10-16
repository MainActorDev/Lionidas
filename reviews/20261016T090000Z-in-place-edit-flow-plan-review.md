# Review — In-Place Edit Flow Plan

- Plan reviewed: `plans/20261016T090000Z-in-place-edit-flow-plan.md` (READY)
- Evidence: `server/src/agent/identifier-flow.ts` (state machine, prepareTurn/afterTurn, createWorktree/commitEach seams), `server/src/agent/worktree.ts` (commitEach pathspec law `':!.lionidas'`, pushAndPr), live session sess_451c34f0-ceb transcript (the "edit in place" arc, messages [9]–[17]), Foodiary clone post-mortem (pbxproj 137-line pollution, `.derived-data/`, in-place commit `98c4f88` hand-done by host).

## Verdict: READY after corrections (2 High, 2 Medium, 1 Low)

The design is sound — it closes the real gap (agent dead-ends with paste-ready commands) without violating the host-owns-git law, and the stash-partition idea correctly separates proposal edits from tool dirt. Findings below are edge-hardening, not direction changes.

## Findings

### F1 (High) — "clean-enough" precondition is under-specified and wrongly gated
Plan: trigger requires "no staged changes; unstaged tool dirt tolerable". Two problems:
1. **Pre-existing unstaged edits to a proposal file** (a human was mid-edit) would be committed under the agent's trailer — provenance lie. The trigger must refuse when ANY proposal-listed file is already dirty (staged OR unstaged): "proposal file <f> already has uncommitted changes — commit or discard first". Non-proposal dirt is the only tolerable class.
2. **The stash partition must run BEFORE the model edits, not only after.** Snapshot the porcelain list at prepareTurn (trigger time) and use THAT list at afterTurn: anything dirty at trigger that isn't a proposal file gets stashed regardless of what happened during the turn; anything that became dirty during the turn and isn't a proposal file is *new* tool dirt — also stashed, but distinguishably logged. Without the trigger-time snapshot, "what was already dirty" is unrecoverable after the turn.
**Required**: trigger refuses dirty proposal files; prepareTurn records `pre_existing_dirt` into the proposal row (JSON column or reuse entries_json envelope); afterTurn partitions using both lists.

### F2 (High) — checkout -b on a dirty canonical clone can fail or strand
`git checkout -b` preserves dirty state — fine — but if the branch already exists (retry path: `feat/identifiers-<slug>` from a failed prior attempt) checkout -b fails, and the plan has no retry semantics. Also after push + reset-to-main, a `git stash pop` conflict leaves the clone mid-restore with the proposal row already cleared — the worst terminal state.
**Required**: (a) branch name carries the attempt (or `-N` suffix on collision, matching the bld_ unique-id lesson); (b) ordering: clear the proposal row LAST, after stash-pop succeeds or its conflict is logged; (c) on stash-pop conflict: leave the stash entry in place (never drop), log the stash ref in the completion note.

### F3 (Medium) — compile gate on the canonical clone blocks other consumers
compileWorktree runs on the edited tree — which IS the canonical clone. A multi-minute xcodebuild there holds the repo busy for any concurrent worktree creation (worktrees share .git locks during prepare steps like xcodegen) and vice versa. In practice this is rare (single-operator), but the plan should state the concurrency contract: in-place flow and worktree flow for the SAME repo must be mutually exclusive (the running-state row already serializes same-project builds; the agent flow should acquire the same exclusivity, e.g. refuse in-place trigger while any build/proposal for the repo is active).
**Required**: one paragraph in the plan + a guard clause in the trigger test matrix.

### F4 (Medium) — pushAndPr's PR body seam doesn't take the provenance line yet
The plan says "PR body gets a provenance line" but `pushAndPr(wt, { title, body })` builds its own body with entries + session. Either extend its opts (backward-compatible) or pass the full body from identifier-flow. Also `wt` is a worktree-shaped object `{repo, slug, path, branch}` — in-place reuses it with `path = clone`; confirm pushAndPr doesn't derive anything else from the shape (it uses path as cwd and branch as ref — verified in worktree.ts; fine, but the plan should say the reuse is deliberate).
**Required**: specify the opts extension in slice B.

### F5 (Low) — EDIT_IN_PLACE_RE should not match accidental phrasing
"apply in place" could appear in a QUESTION ("can you apply in place?"). Same law as CONFIRM_RE: only bare directives drive the machine; anything else keeps the proposal pending. Restrict to exact-match set (`/^(edit|apply) in place$/i` on trimmed content) and exclude multi-sentence input.

## Post-correction check
- Host-owns-git preserved (committer is host-side afterTurn; model keeps editor tools only) ✓
- Pathspec-only commits (explicit file list; stash partition as backstop) ✓ with F1 tightening
- Compile gate before push ✓ unchanged
- Honest park states ✓ (compile-failed / in-place-failed with work preserved)
- Slice order sensible; slice C live drill covers the exact historical failure (pbxproj exclusion) ✓

Verdict after corrections: implement slices A–C.
