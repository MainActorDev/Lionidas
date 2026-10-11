# Agent handoff control, slash-command skills, and post-merge hardening

- Source prompt: "For this chat feature, I'd like handoff between agents to be manual and not automatic. Can we make this configurable? And I'd like each agent profiles to have their own skill command like '/planning', '/breakdown', '/author' to trigger what each of them do. And PR #32 is merged. Do the above task along with the post-merge tasks: clean-room fresh-machine install test; retrieval memory, persistent MCP process, agent evals."
- Created: 2026-10-11T10:35:18Z
- Status: Direction selected

## Goal and context

The agentic chat round (PR #32, 37 commits) is merged. Three follow-on asks plus previously deferred post-merge work:

1. **Manual agent handoff** — today the author pipeline (plan → breakdown → author) advances automatically: a stage finishes and the next starts. The user wants a mode where *the human* approves each transition.
2. **Slash-command skills** — `/planning`, `/breakdown`, `/author` in the composer to invoke a specific agent profile directly, instead of the chat auto-routing.
3. **Post-merge hardening** (previously deferred, now approved): clean-room fresh-machine install test; retrieval-based memory; persistent MCP process; agent evals.

## Confirmed inputs and decisions

- PR #32 is MERGED into main (verified: merge commit 4ca2e18; local main updated).
- Manual handoff must be CONFIGURABLE, not a hard switch (user: "Can we make this configurable?").
- The three slash commands named by the user: /planning /breakdown /author (mapping to lionidas.planner / lionidas.breaker / lionidas.author profiles).
- Butler workflow engine today: stages advance in a for-loop (`run.ts` carry/handoff); pause exists only for QUESTIONS (pauseOnQuestion), not for stage transitions.

## Exploration

### A. Manual handoff (gated stages)

Butler's engine already has the machinery: a stage can pause (question flow), and resume carries the payload. The cleanest design is a per-stage `gated: true` flag: after a gated stage completes, the workflow emits `workflow.stage_gate` and waits; a `POST /api/agent/runs/:id/advance` (operator-gated) lets the human release the next stage (with the handoff payload applied). Config surface: env `AGENT_PIPELINE_HANDOFF=manual|auto` (default auto to preserve current behavior), overridable per run at POST /api/agent/pipeline. Run panel shows a "review & continue" card on the gate — same anatomy as the existing question card.

Tradeoffs: manual mode makes runs interactive by design (good for trust, slower for batch). Keeping auto as default avoids breaking the existing pipeline tests/drills.

### B. Slash-command skills

Composer intercepts messages starting with `/`: `/planning <ask>`, `/breakdown <ask>`, `/author <ask>`. Routing: a slash command targets ONE profile directly — it runs a single-stage workflow (or a direct conversation turn with that profile's executor+prompt) rather than the full pipeline. Auto-complete hint list in the composer when `/` is typed. Also `/help` listing commands. Unknown slash → inline hint (no server round-trip).

Design choice to settle: single-agent turn (cheap, uses the chat transport with a per-profile system prompt) vs single-stage workflow (run panel shows progress, artifacts land in the run). Proposal: workflow-based, so every slash invocation is observable in the run panel and reuses gates/checkpoints.

### C. Post-merge tasks

1. **Clean-room install test**: clone main into /tmp, pnpm install, boot server (no BUTLER env → mock provider path), run web build + a subset of suites, verify /agent renders. Proves the portability fixes (portable mcp-stdio.sh, .env.example) on a fresh tree. ~30-45 min.
2. **Retrieval memory**: replace top-20 recency note injection with relevance selection (tag/scope match first; embeddings only if needed). Butler transport seam: `selectNotes(sessionId, message)`.
3. **Persistent MCP process**: today every claude turn spawns a fresh MCP server (node+tsx ≈ 1-2s tax per turn). Options: (a) claude's built-in MCP over HTTP/SSE endpoint mounted once in the server, (b) keep stdio but reuse the claude session (--resume) so the harness keeps its MCP connection alive. (b) is already half-true; measure first.
4. **Agent evals**: golden-set Q→expected-tool/expected-content evals against the mock provider (hermetic) plus a small live smoke set; wire into CI as a separate suite.

Sizing: A+B ≈ a day together (they share the routing/gate work). C1 is isolated. C2-C4 are independent follow-ups.

## Open questions

None — all three answered 2026-10-11:
1. Handoff default: **manual** (every stage transition needs human approval; `auto` available via `AGENT_PIPELINE_HANDOFF=auto`).
2. Slash commands: **workflow-based** (run panel visibility, gates, artifacts per run).
3. Slash commands run **bare** — knowledge page + profile prompt, no refs/app-bundle required.

## Next step

A+B shipped (rev 20, ba07142). C1 clean-room findings:

- Fresh install boots correctly under the PINNED node (.nvmrc 24.12.0 —
  the repo's declared engine). Under node 24.20 SOME installs crash at
  boot with a better-sqlite3 native assertion (Statement destructor vs
  env teardown, GC-timing dependent — lldb-confirmed). The dev tree's
  older-built binary masks it; freshly-built binaries expose it
  inconsistently (cleanroom2 crash / cleanroom3 boot, same checksum —
  indicating a deeper ABI/n-API timing issue in better-sqlite3@11.10
  with newer node runtimes).
- Mitigations landed: .npmrc build-from-source=better-sqlite3 (build
  determinism), .nvmrc remains the contract (24.12.x engines).
- Follow-up (C1b, recommended): bump better-sqlite3 to a release with
  node 24.20 support, or pin engines strictly and CI-check boots on
  the pinned runtime only.

C2-C4 (retrieval memory, persistent MCP, evals) still queued.
