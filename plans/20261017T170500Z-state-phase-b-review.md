# Self-review — State Phase B plan (2026-10-17)

Reviewing `plans/20261017T170500Z-state-phase-b.md` against the approved
decisions (①a ②a ③a ④b ⑤done), Phase A's carried rules, and the repo's
real shape.

## Verdict

SHIP after amendments — all applied to the plan file before freeze:

1. **Recipe must be grammar-valid, not a reference** (S2). First draft said
   "recipe = the case's ensureState walk" — but Phase A's grammar allows
   `steps` or `actuator` only; a recipe pointing at another state is not
   parseable. Amended: deep-copy the referenced state's CURRENT recipe at
   draft time, name the source + revision in the rationale so drift is
   visible at accept time.
2. **"Human-only accept" overstates** (S1). Server routes authenticate
   sessions; the agent holds session-class authority for reads and could
   technically POST. Honest framing amended: the gate is tool registration
   (no accept/reject tool exists) + the panel as blessed UI. Same authority
   class as every registry write. Disclosed, not hidden.
3. **S4's data path unverified.** The plan assumed `evaluated_json` reaches
   the web layer; unconfirmed. Amended: wire-check first, and if the runs
   API strips it, the one-field server read change ships disclosed in the
   S4 commit.
4. **e2e POST mocks** (edge 9): Phase A's harness mocks reads only; the
   inbox accept flow needs POST mocks — declared up front instead of
   discovered mid-stage.
5. **stateId fallback can dangle** when a bundle has no screen registry
   (true of Foodiary on prod). Amended guardrail: operator-supplied stateId
   required when screens can't name one.

## Checks performed

- Decisions ①a②a③a④b each map to a stage or a DEFERRED line — no orphan
  decisions, no extra scope smuggled in.
- Phase A carried rules re-checked: no busy guard (S1 routes), revision
  guards (accept path), validation at both create and accept, credentials
  untouched (S2 guardrail), one actuator per recipe (untouched).
- Registry write path reuse: accept creates via the same S2-Phase-A
  validation + history writer, not a parallel code path.
- Test coverage per stage enumerated; edge table rows each have a test or
  an explicit UI behavior.
- Worktree discipline: all edits on `wt/state-phase-b`; the only
  shared-checkout file this session touched was moving its own uncommitted
  brainstorm OUT. wt-parallel plan file declared with intended files.
- Backup: manual tag `wt-backup/main@<ts>` (script's backup refused the
  shared checkout's dirty state — the dirt is the sibling session's, not
  stashable by me). Rollback ladder intact via branch + tag.

## Risks accepted (with reasons)

- Draft heuristics are deliberately dumb (last expect = probe/verify). Miss
  cases (state whose proof isn't the last expect) produce a human-rejected
  proposal — cheap failure, visible in the inbox. No AI cleverness before
  trust is earned (decision ③a's spirit).
- Proposal rows carry full recipe JSON — same class as registry rows; no
  secret surface added.
