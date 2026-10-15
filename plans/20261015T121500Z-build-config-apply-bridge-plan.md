# Build-Config Apply Bridge — Plan

- Source: in-session design discussion (2026-10-15), following three live occurrences of the chat-confirmed-but-never-written gap (Foodiary ×2, ios-consumer ×1)
- Status: READY — decisions locked below
- Branch: `feat/recipe-onboarding` (PR #44 line)

## Problem

`/build-config-propose` and `/build-diagnose` end correctly: evidence-cited proposal, HARD STOP, user confirms. Then nothing happens. The agent parks a note ("the host writes it"), but no host action exists for a chat confirmation — the apply-proposal route is admin REST the agent cannot call. Every confirmed proposal so far was hand-transcribed into curl by the operator's assistant. The loop the commands promise does not close.

## Objective

After the user's confirmation turn, the agent itself lands the build-config revision and fires verify — through policy-gated MCP tools, with the confirmation gate enforced structurally (not prompt-encouraged). Workflow, commands, and human gates unchanged.

Measurable completion:
- A live `/build-config-propose` → "Confirmed" → revision appears in `build_configs` with provenance `ai+user` — no human curl
- Verify fires in the same flow and stamps a verdict
- An apply attempted WITHOUT a confirmed proposal in the thread is refused by the tool
- Secrets law intact: no tool can place, read values of, or synthesize secret files

## Non-negotiable principles (carried from the parent plan)

1. HARD STOP stays: nothing applies before the user's confirmation reply
2. The tool refuses when no confirmed proposal is parked for the session (structural gate)
3. Secrets are files only humans place; tools never touch their contents
4. xcodebuild is the only oracle (verify = the existing compile-only gate)
5. Revisions are append-only rows with provenance; one confirmation = one write; no retry loops

## Design

### 1. Parked-proposal state machine (`src/agent/build-config-flow.ts`, mirrors identifier-flow.ts)

Table `build_config_proposals` (DDL lives in `migrateBuildConfigs` — schema.ts owns the domain's schema, review R4; the flow module assumes it exists). Keyed per-project (review R5 — a session may propose for two projects; new propose REPLACES the pending row for THAT project only):
```
session_id TEXT NOT NULL,
project_id TEXT NOT NULL,
PRIMARY KEY (session_id, project_id),
proposal_json TEXT NOT NULL,   -- {transport, scheme, configuration, prepare[], evidence[]}
created_at INTEGER NOT NULL,
state TEXT NOT NULL DEFAULT 'pending'   -- pending | applied | declined
```

- Parking is DUAL-LAYER (review R2 — the loop must survive a prose-only turn):
  - (a) canonical: if the turn called `build_config.propose`, park its structured args
  - (b) fallback: ALWAYS also run the answer-level detector (identifier-flow's answerIsProposal pattern) and park/refresh from the answer's yaml code block when (a) didn't fire
- The confirmation FLIP lives in the butler `prepareTurn` decoration (review R1 — same mechanism as the identifier auto-flow, already proven): on the user's NEXT message matching CONFIRM_RE, the seam flips `pending → applied` BEFORE the model sees the turn; DECLINE_RE clears; a question keeps `pending`. The state is claimed synchronously — no double-entry. This makes the human gate structural: the model cannot flip it, only the user's actual message does
- The applied turn's command overlay then instructs the model to call `build_config.apply` (which can only succeed on an already-flipped row)

### 2. Two new draft-class MCP tools (`config-tools.ts`)

- `build_config.propose` — the agent calls this INSTEAD of free-typing the proposal: args {projectId, transport, scheme, configuration, prepare[], evidence[]}; executes by returning the rendered proposal table + parking the row (pending). This makes the parked state machine-parseable by construction — no answer-text parsing fallback needed.
- `build_config.apply` — args {projectId}; PRECONDITION: the session's proposal row for that project is in state `applied` (review R1: the pending→applied flip is NOT this tool's to make — it happens in the turn-decoration seam below, driven by the user's actual message, before the model sees the turn; a model calling apply on a `pending` row is refused structurally). Performs the write via the same store function the REST route uses (`writeBuildConfigRevision`, provenance `ai+user`), and fires `startBuildVerify` (fire-and-forget, same as the REST verify route). Returns {revision, recipeId, verifyStarted}.
- Both register under `permission: 'draft'` (the class that already writes Lionidas data — case drafts, notes).
- Verify outcome durability (review R3): when startBuildVerify's fire-and-forget work settles, write a best-effort note (kind env-gate, scope project:<id>) with the verdict + log tail — ranked note injection surfaces it to the session's later turns, so the outcome is learned without new polling machinery. Optional WS bus event alongside.

### 3. Command instruction updates (`commands.ts`)

`/build-config-propose`: step 3 becomes "call `build_config.propose` with the fields, then render its table and HARD STOP". Step 5 becomes "after confirmation, call `build_config.apply` — it writes the revision (provenance ai+user) and fires verify; report the revision number and that verify is running".

`/build-diagnose`: same shape — the proposed revision goes through `build_config.propose` (parked), confirmation → `build_config.apply` (writes revision N+1).

Secrets law line added verbatim to both: apply must NEVER be called for a row whose gate is NEEDS_SECRETS-unmet — the tool cannot verify secrets exist; verify-build will fail honestly if they don't.

### 4. What stays untouched

- The REST routes (`/build-config/apply-proposal`, `/verify`) remain — UI buttons use them; the MCP tools are a second caller of the SAME store functions. One write path, two doors.
- The Projects page, canary, detect/derive — unchanged
- The identifier flow — unchanged (this is its sibling, not a refactor of it)

## Stages

**B1 — store + tools**: `build-config-flow.ts` state machine; `build_config.propose` / `build_config.apply` in config-tools; unit tests (parking, confirmation gate refusal, apply writes revision + provenance, secrets-needing rows carry the gate note)
**B2 — command wiring**: instruction updates; command tests assert the tool names appear in instructions and HARD STOP remains
**B3a — live drill (automatable end-to-end)**: real session — `/build-config-propose` on ios-consumer (Dev row, the real pending decision), user-style "Confirmed" via the chat API, assert: revision appears (provenance ai+user), verify fired, verdict = the honest FAILURE (Dev row needs DevelopmentConfig.xcconfig) — failure is the expected pass condition here.
**B3b — green re-verify (operator-gated, separate run)**: after the operator copies the xcconfigs into the clone (a human gate by the system's own law), re-run verify → green. Not part of B3a's continuous run.

## Edge cases

- Confirmation arrives in the SAME message as the propose ask (self-confirm): refuse — the parked row must exist first, and the confirmation check requires a LATER user message
- Two proposals same session: the table is session-keyed — a new propose REPLACES the pending row (same semantics as identifier flow); an applied row is terminal
- Tool called with another session's id: the confirmation check is scoped to this session's messages
- prepare steps referencing secret files: allowed (the step is a command string); the SECRETS law is about file contents — tools never read/emit them
- Verify still running when a second apply lands: allowed — revisions are independent rows; verify targets the active revision at fire time

## Acceptance

1. Server suite green + tsc clean; command registry tests updated for the new instructions
2. B3 live drill output pasted: proposal → confirmed → revision row + provenance + verify verdict, all without operator curl
3. Negative test in B1: apply without confirmation → refused with the structural error
