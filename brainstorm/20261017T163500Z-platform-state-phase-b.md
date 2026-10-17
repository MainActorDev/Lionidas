# Brainstorm — Platform state management, Phase B (2026-10-17)

Status: DRAFT — decision points open (numbered below; answered before any plan).
Parent: `plans/20261017T112229Z-platform-state-management.md` (Phase A, merged as PR #55).

## The prompt

Phase A's deferred list names three Phase B candidates — batch grouping,
run-level provenance UI, AI write-proposals. What ships next, in what shape,
and when?

## Grounding (queried 2026-10-17, prod DB)

| Fact | Value | Read |
|---|---|---|
| `app_states` rows in prod | table doesn't exist yet | server pre-dates the merge — migrations land on restart |
| templates total | 19 | small real portfolio |
| `ensureLogin` setups | 2 | the login seam has exactly two consumers |
| `ensureLogout` usage | 3 | more logout consumers than login |
| multi-variant templates | 1 | lane parallelism barely used |
| runs (30d) | 579 | healthy play volume |
| suite-stamped runs (30d) | 60 | suites carry ~10% of volume |

**Central finding: Phase A adoption is at zero.** Every Phase B candidate
presupposes registry content that does not exist yet:

- **Batch grouping** rolls up "first case pays the walk, rest probe-hit"
  across a lane — needs multiple cases sharing an arrival state. Zero
  `ensureState` cases exist.
- **Run-level provenance UI** shows which state revision a run converged
  with — needs registry churn (revision > 1) to matter. Zero revisions.
- **AI write-proposals** draft registry states from run evidence — needs
  runs worth drafting from. These DO exist (579/30d).

So the three candidates split by what unblocks them. AI write-proposals is
the only one whose input exists today — and it is the *adoption
accelerant*: it bootstrap-populates the registry that the other two need.

## Preconditions (not decisions — facts to act on)

- **Prod server restart** activates Phase A (migrations + routes). Until
  then the platform runs pre-merge code. Operator's call when.
- The drill-proven Foodiary states (`on_profile_setup`, `fresh_install`)
  live only in the drill DB. Re-authoring them on prod after restart is
  the first real registry content — 10 minutes of work, no code.

## Candidate directions

### C — AI state write-proposals (the accelerant)

The agent watches green runs, reads their evidence + AX trees, and drafts
an `app_states` entry (probe/recipe/verify) into a **proposal queue**. A
human approves/rejects in the app states panel; approval commits with
provenance `ai+user` and bumps revision. Rejects die quietly. Nothing an
AI proposes ever reaches the registry without a human tap.

Open sub-questions (encoded in the decision points): where the human
reviews (panel inbox vs chat-side cards), what a proposal may touch
(new-only vs edits), and what the drafting heuristics are allowed to read
(evidence, trees, screen registry — never env values).

### B — Run-level provenance (small slice, any time)

Phase A already audits `{stateId, revision, path, probeMs}` per step. The
small slice: surface it — state chip on the run row, revision badge with
history tooltip, probe-hit vs recipe dimming. Zero new server machinery;
purely read-side. Value grows with adoption but costs little now.

### A — Batch grouping (wait)

Group same-batch runs sharing an arrival state into one rollup line
("6 plays · 1 walk 9.4s · 5 probe-hits ~0.1s · saved 47s"). Needs lanes
that reuse states. Defer with an explicit adoption trigger.

## Decision points (answer before planning)

1. **Sequencing**: (a) C first as the adoption accelerant, B rides along
   small, A deferred-with-trigger; (b) all three now; (c) B only (cheapest);
   (d) hold Phase B entirely until Phase A shows organic use.
2. **Write-proposal review surface**: (a) proposals inbox inside the app
   states panel (one home for registry truth); (b) chat-side proposal cards
   with accept/reject inline; (c) both, chat drafts → panel approves.
3. **Proposal write scope**: (a) new states only; (b) new states + edits to
   states whose provenance is `ai+user`; (c) any state, human-diff-gated.
4. **Batch-grouping adoption trigger** (if deferred): (a) ≥3 registry states
   in prod; (b) ≥1 lane with ≥3 cases sharing an arrival state; (c) first
   observed multi-probe-hit batch in run data; (d) calendar (Nov 15).
5. **Prod restart timing** (operator fact, recorded here): restart before
   Phase B work so the brainstorm's assumptions stay queryable?

## Non-goals (carried from Phase A unless reopened)

State graphs, auto-inference without proposals, conditional recipe
branching, multi-app choreography, per-screen deep-links.
