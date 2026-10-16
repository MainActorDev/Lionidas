# In-Place Edit Flow — First-Class State Plan

- Source: session sess_451c34f0-ceb analysis ("edit in place" escape hatch had no host complement — agent hand-delivered git commands; canonical clone left dirty; pbxproj polluted)
- Status: READY (for review)
- Related: identifier-flow.ts state machine (plan 20261014T132710Z Phase IIIb), wrong-repo fix slice map from the same session analysis (slices #1/#2 tracked separately)

## Problem

`/implement-identifiers` has one happy path: proposal → confirm → host creates worktree → model edits in worktree → host compiles, commits, pushes, PRs, cleans up. When no worktree can be provisioned (wrong-repo bug, now fixed) or the user prefers it, the only escape is "edit in place" — the model edits the canonical clone directly. Today that path dead-ends:

1. The model ends its turn with paste-ready git commands for the human (agent: "no shell, commit/push are host-side").
2. The canonical clone sits dirty on `main` until a human commits — unbounded time, host state at risk (the pbxproj xcodegen pollution rode exactly this window).
3. Recipe prepare/verify steps may have mutated tracked files in the clone; nothing separates intended edits from tool dirt.
4. No provenance: the eventual commit (if any) carries no machine-readable trace that it was an agent-authored, user-authorized in-place edit.

## Law

- The host owns git — always. The in-place path adds a host-side COMMITTER, not a model shell.
- The model's file writes remain cwd-gated editor tools; in-place means cwd = the canonical clone (explicitly user-authorized per session).
- Only the proposal's files are committed — explicit pathspec, never `git add -A`. Everything else is stashed/restored.
- `user-authorized-in-place` provenance rides the commit trailer and the PR body.
- Compile gate unchanged: nothing is pushed before compileWorktree passes on the edited tree.

## Design

### State machine addition

`identifier_proposals.state` gains `in-place` (after user says "edit in place" on a pending/confirmed-but-unprovisionable proposal):

```
pending ──confirm──▶ confirmed (worktree path)
pending ──edit-in-place──▶ in-place          ← NEW transition
in-place ──turn settles──▶ compile → commit → push → PR → cleanup → cleared
```

### Trigger (prepareTurn)

- Proposal exists in `pending` (or `confirmed` whose worktree creation failed), AND
- user content is a BARE directive (review F5): `/^(edit|apply) in place$/i` on trimmed, single-sentence content — questions or prose containing the phrase keep the proposal pending, same law as CONFIRM_RE, AND
- the canonical clone exists and is clean-enough: ANY proposal-listed file already dirty (staged or unstaged) REFUSES the trigger — "proposal file <f> has uncommitted changes — commit or discard first" (a human's mid-edit must never ride under the agent's trailer; review F1). Non-proposal dirt (`.derived-data/`, pbxproj regen) is tolerable, AND
- exclusivity (review F3): no active build, verify, or other proposal flow for the same repo — in-place compile and worktree creation share `.git` locks; one lane at a time.

Action: set state `in-place`; **snapshot the pre-existing dirt** (`git status --porcelain`, non-proposal entries) into the proposal row — afterTurn partitions against this list, because "what was already dirty" is unrecoverable after the turn (F1); swap provider cwd to the canonical clone (`repos/<repo>`); prompt block: identical edit mandate as the worktree turn + "you are editing the CANONICAL clone in place, user-authorized — the host will commit exactly your proposal's files after your turn".

### Completion (afterTurn)

- state `in-place` + turn ok:
  1. **Snapshot intent**: `git status --porcelain` → partition into (a) files named in the proposal, (b) everything else — using BOTH the live list and the trigger-time `pre_existing_dirt` snapshot (review F1).
  2. **Stash the rest**: `git stash push -- <non-proposal paths>` (pre-existing dirt and new tool dirt alike; the two classes logged distinguishably). If nothing to stash, skip.
  3. **Compile gate**: `compileWorktree(clonePath, log)` — same proven path, compile-only. Red ⇒ state `compile-failed`, report, keep edits on disk (no commit).
  4. **Commit**: branch `feat/identifiers-<slug>` — on name collision from a failed prior attempt, suffix `-2`, `-3`… (review F2; the bld_ unique-id lesson); `git checkout -b` + `git add -- <proposal files exactly>` + commit with trailer `Lionidas-In-Place: session <id>, user-authorized`.
  5. **Push + PR**: `pushAndPr` opts gain an optional `bodyPrefix` (backward-compatible extension, review F4) carrying `**Applied in-place, user-authorized** (session <id>)`; the `wt`-shaped object reuse (`path = clone`) is deliberate — pushAndPr uses only path-as-cwd and branch-as-ref (verified in worktree.ts).
  6. **Restore + cleanup — ordering matters (review F2)**: `git stash pop` (best-effort; on conflict: LEAVE the stash entry, log the stash ref in the completion note — never drop, never lose); reset clone to `main`; clear the proposal row LAST, only after restore succeeded or its failure is logged.
- state `in-place` + turn failed: mirror `edit-failed` — keep edits, park state `in-place-failed`, log for retry. NEVER leave the machine mid-commit.

### Repo resolution (dependency note)

This plan assumes slice #1 (repo resolved from proposal file paths at park time, not the `ios-consumer-intl` hardcode). If #1 hasn't landed, in-place on non-intl repos can't address the right clone — implement #1 first or together.

## Stages

1. **Slice A — state + trigger**: `in-place` transition, EDIT_IN_PLACE_RE, provider cwd swap, prompt block. Tests: transition legality matrix (pending/in-place, confirmed/in-place refused — one path at a time), prompt content.
2. **Slice B — afterTurn pipeline**: stash-partition-commit-compile-push-PR with the trailer + PR provenance, stash-pop restore. Tests: proposal-files-only commit (fake a pbxproj mutation → assert excluded + restored), compile-fail parks without commit, turn-fail parks, happy path pushes and cleans.
3. **Slice C — live drill**: real Foodiary-clone in-place edit via the real chat turn (one identifier), verify commit contains exactly that file, PR carries the provenance line, clone back on main, stash restored.

## Acceptance criteria

- "edit in place" on a pending proposal drives a fully-automated commit/push/PR with zero human git commands.
- The commit contains exactly the proposal's files — a concurrently mutated pbxproj or `.derived-data/` never rides along.
- Compile gate failure ⇒ no commit, edits preserved, state parks honestly.
- PR body + commit trailer carry `user-authorized-in-place` provenance.
- Clone returns to `main` clean after the flow (tool dirt restored or logged, never silently dropped).
