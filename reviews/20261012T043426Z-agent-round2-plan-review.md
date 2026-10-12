# Review — plans/20261012T043426Z-agent-round2-plan.md

- Reviewed: 2026-10-12T05:20Z, plan status **Ready** (76 lines, commit `ada8b4c`)
- Evidence: plan + source brainstorm `20261012T034031Z` + live code reads (paths cited inline): `server/src/agent/{context,pipeline,pipeline-routes,draft-tools}.ts`, butler `src/{provider/claude-cli,profile/profile,memory/contract,embeddings/index,workflow/run}.ts`
- Scope: paper audit of correctness, robustness, feasibility, verification. No code was executed for this review.

## Verdict: **Needs revision** — 1 Critical, 3 High. The plan's direction is sound and each mechanism is a proven industry pattern, but one architectural fact about the claude-cli provider invalidates F4's design as written, and three stage contracts are underspecified enough to change implementation or acceptance.

## Known-solution assessment (the operator's direct question)

Every core mechanism is a mainstream, well-established pattern — none is experimental:

| Plan item | Known solution it implements | Where it's standard |
|---|---|---|
| F1 transcript continuation + tool narrative | Chat-history-as-context; agent trace summarization in the transcript (the "Scratchpad/Thought-Action-Observation" lineage; Claude Code/Cursor keep tool traces in-session the same way) | Every production agent chat |
| F2 knowledge grounding + compile-on-demand | RAG with a grounding document + recency-vs-source precedence rule ("tools win") | Standard retrieval-augmented agent design |
| F3 top-k embedding retrieval with recency fallback | Vector memory with hybrid fallback — the canonical fix for naive top-N injection; butler already ships `OpenAICompatEmbedding` + `cosine()` (embeddings/index.ts:46,76) so this is wiring, not invention | ChatGPT memory, MemGPT/Letta, every RAG stack |
| F4 persistent child process | Process pool / singleton worker with health-check + capped-backoff respawn — the standard MCP stdio-server lifecycle (the MCP spec itself assumes a long-lived stdio server per client) | MCP reference implementations, language servers (LSP) |
| F5 dependency bump + cleanroom | Reproducible-build verification | Routine |

Verdict on mechanism risk: **low**. The risk in this plan is not "will the pattern work" but the integration facts below.

## Traceability summary

All six brainstorm decisions map to stages (skills+refs → F2.2/2.3; C2-reuse-endpoint → F3.2; C3-daily → F4; event cleanup → F5.1; C1b → F5.2; C4-deferred → absent, correctly). One extra commitment not in the brainstorm: F1.2 tool-narrative row — it IS in the brainstorm's Option 1, so not extra. No contradictions with approved requirements found.

## Findings

### R1 — Critical — F4 premise is wrong: the provider is ONE server-wide instance with shared session state
- **Location:** plan line 23 ("`--resume` statefulness is a documented hazard") and F4.3 ("Session isolation: each Lionidas chat session maps to its own claude session id — verify explicitly").
- **Evidence:** `claude-cli.ts:48` — `private sessionId: string | null = null` is *instance* state; `context.ts:84` constructs the provider **once per server** and `routes.ts:23` passes that single `ctx.provider` to every conversation. There is no per-session provider today. After the first turn sets `sessionId`, **every subsequent turn in every Lionidas chat resumes that same claude session** — cross-talk exists *now*; persistence (F4) would cement it.
- **Consequence:** F4 as written ("verify explicitly") would discover the isolation doesn't exist and needs building, not verifying — stage estimate and acceptance are both wrong. Worse: shared `--resume` means user A's chat context leaks into user B's turns (privacy + correctness).
- **Correction:** F4 must include *implementing* session isolation (provider-per-session map keyed by Lionidas session id, or a sessionId argument threaded through `complete()`), and a test: two sessions, interleaved turns, assert no context bleed. Do isolation FIRST or together with persistence — a persistent shared session is a regression.
- **Verify:** unit test with two fake sessions asserting distinct `--resume` ids; live drill: two chats ask different things, no bleed.

### R2 — High — F3's "storage gains embed" is a bigger seam than stated; injection point is unowned
- **Location:** F3.1.
- **Evidence:** butler's storage contract (memory/contract.ts) has **no embed seam today** (grep: zero matches). The notes block is built in `resolveProfile` → `notesBlockFor(notes, scopes)` (profile.ts:68,114) from `storage.activeNotes(prefix)` — note: `activeNotes` takes a *scope prefix*, not a query; there is no similarity parameter anywhere in the chain. The plan doesn't say whether ranking lives in storage (SQL), in `resolveProfile` (fetch-all-then-rank), or in a new MemoryRetriever, nor who calls the embedder at prompt time.
- **Consequence:** implementer must invent the architecture mid-stage; "chat never breaks" depends on where the fallback lives — if it's inside storage, every consumer gets it; if in profile, workflow stages need the same path. Cost estimate (L) may be right, but the stage as written can't be accepted against "top-k by similarity" without deciding the seam.
- **Correction:** specify: (a) `activeNotes` stays; new `searchNotes(queryEmbedding, k)` or rank-after-fetch in `resolveProfile` with an injectable embedder; (b) embed-at-save lives in Lionidas' `note.save` tool wrapper (draft-tools.ts:146) calling `OpenAICompatEmbedding`; (c) fallback = no embeddings present → current behavior. Keep the embedding **storage-agnostic** (vectors in a side table, cosine in JS — at current note volumes, <1k rows, no sqlite-vec needed).
- **Verify:** hermetic test with injectable embedder asserting ranking + fallback, named in the plan, stays.

### R3 — High — F2 acceptance has no failure-path and the composer change touches send semantics
- **Location:** F2.2/2.3 and its verification line.
- **Evidence:** F2 says refs "may coexist" with a command chip and `compileKnowledge` runs first — but today `submit()` in Composer.vue branches: command → `emit('skill', cmd, ask)` **discarding refs** (verified: `refs.value = []` on the skill path). No plan line covers: compile failure mid-skill (does the skill run without the page? abort?), ref validation (the pipeline route filters unknown kinds — skills path needs the same), or the UI affordance showing refs attached to a skill. Also unresolved: which app resolves when refs carry no repo and multiple apps are registered (pipeline has a 4-step chain; skill path currently passes `'skill'` literal).
- **Consequence:** "skill with @jira produces an answer citing ticket content" can pass while refs are silently dropped (the exact bug class fixed in `190ac44`'s KNOWN-set round). Acceptance must include the negative path.
- **Correction:** add to F2: refs survive the skill branch in the composer; skill route validates refs identically to the pipeline route; compile failure → skill still runs, answer prefixed with an honest "refs partially compiled: …" line; app resolution reuses `resolveAppBundle` verbatim.
- **Verify:** drill with an @jira ref + unknown-kind ref mixed; assert ticket content cited AND unknown ref surfaced honestly.

### R4 — Medium — F1.1 "live-verify" depends on F2's app resolution for its most convincing case
- **Location:** F1.1 vs F2 ordering.
- **Evidence:** F1 verifies follow-up context with `/planning` alone; the strongest version of the operator's scenario ("follow up on the plan that used my ticket") lands only after F2. Not a defect — an expectation-setting gap: if F1's verification passes trivially, that's expected and shouldn't be read as the scenario being fully proven.
- **Consequence:** low; risk of declaring victory early.
- **Correction:** note in F1 that full scenario proof lands in Validation after F5; F1 verifies transcript mechanics only.

### R5 — Medium — Butler release coupling is one-way
- **Location:** F3.4 (v0.4.2), Rollout.
- **Evidence:** F3 and F4 both change butler (storage seam; provider lifecycle) but only F3 mentions a tag. F4 changing `claude-cli.ts` also needs a tagged release; the plan doesn't say whether one v0.4.2 covers both or two tags.
- **Consequence:** mid-round, lionidas may pin a tag missing F4's provider changes.
- **Correction:** one line: tag once after F3+F4 (single v0.4.2), lionidas pins at F4 completion.

### R6 — Low — F3 backfill has no volume guard
- **Location:** F3.3.
- **Evidence:** backfill embeds all existing notes serially; no cap or batching mentioned. At current volumes trivial; if notes grow first, an unbounded loop hits rate limits.
- **Correction:** batch (e.g. 20) with small delay; resumable (skip notes with embeddings).

## Questions for the operator (grouped, highest first)

1. **R1:** Confirm session isolation is in-scope for F4 (it's required for correctness, adds ~½ day). Alternative if you want it later: keep per-turn spawn until isolation exists (i.e., defer ALL of F4).
2. **R3:** When a skill's refs partially fail to compile, proceed-with-honest-note (recommended) or abort the skill?
3. **R5:** Single butler tag v0.4.2 after F3+F4 — acceptable?

## Necessary plan edits

- F4: replace "verify explicitly" with "implement provider-per-session isolation + interleave test"; order isolation before/with persistence.
- F3: name the seam (rank in resolveProfile via injectable embedder; vectors in a side table; JS cosine; fallback = current behavior) and the owner of embed-at-save (note.save tool wrapper).
- F2: add refs-survive-skill-branch, ref validation parity with the pipeline route, compile-failure behavior, app-resolution reuse; extend acceptance to the mixed-refs negative case.
- F1: scope note (transcript mechanics only; full scenario proven in final validation).
- F5/R5: single tag line. R6: batching line.

## What remains to validate during implementation (not certifiable on paper)

- Actual follow-up grounding quality (model behavior, needs the live drill).
- Embedding relevance on real note corpora (needs the two-ask live drill).
- Respawn/backoff behavior under real crashes (kill -9 drill).
- Cleanroom boot on node 24.20 (execution).
- Whether GLM's `/embeddings` endpoint accepts the configured model (F3.2 assumes yes — probe before building the backfill).

This review inspected the plan against the cited code on paper. It cannot certify that the implementations will be correct, reliable, or performant — those need the stages' own verification steps, which (after the edits above) are specific enough to execute.
