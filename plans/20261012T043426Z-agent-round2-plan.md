# Agent round 2 — skills-in-chat context, C2 retrieval memory, C3 persistent MCP, cleanup

- Source brainstorm: `brainstorm/20261012T034031Z-agent-round2-limits-and-skill-context.md` (status: direction selected across follow-up answers: skills+refs YES; C2 stays with Lionidas memory, reuse BUTLER_* endpoint for embeddings; C4 deferred — the operator is the eval loop; tag hygiene dropped)
- Created: 2026-10-12T04:34:26Z
- Status: Ready (revised 2026-10-12 after review `reviews/20261012T043426Z-agent-round2-plan-review.md`; operator answers: R1 isolation IN SCOPE, R3 proceed-with-honest-note, R5 single tag)

## Objective and completion conditions

Make skills first-class citizens of conversations and harden the agent's daily-driver path. Done when:

1. A follow-up chat message after `/planning` sees the full skill context — command, answer, AND a compact tool narrative — verified live.
2. Skills read the app's knowledge page (background grounding; tools win over stale page) and accept `@` refs (compile-on-skill).
3. C2: notes embed at save; prompt injection retrieves top-k by similarity with an honest recency fallback.
4. C3: claude-cli runs on a persistent child process (spawn once, reuse, respawn-on-crash), opt-out switch for tests.
5. Event contract: deprecated `tool.call`/`tool.result` verified gone (pre-checked: butler src has only `turn.tool`; no Lionidas consumer) — document, no code.
6. C1b: better-sqlite3 bumped 11.10.0 → latest, cleanroom boot on node 24.20 + fresh install passes.

## Verified facts (checked 2026-10-12)

- `runSkill` persists command+answer rows (`319ea0c`); the chat provider's context IS the session message list → follow-ups should already see them — needs live verification, plus the tool narrative is missing.
- `pipeline.skill()` passes `{ask, appBundle}` — never calls `compileKnowledge` (pipeline.ts:111); refs are dropped by the composer when a skill fires.
- Memory: `notesBlockFor`/`activeNotes` inject top-20 flat (butler profile.ts); embeddings seam exists in butler (embeddings/index.ts exported) but is unused by Lionidas.
- claude-cli provider spawns per `complete()` (claude-cli.ts) — AND (review R1) the provider is constructed ONCE per server (context.ts:84) with `sessionId` as instance state (claude-cli.ts:48): cross-session `--resume` bleed exists TODAY. F4 must build isolation, not verify it.
- butler's memory contract has NO embed seam; `activeNotes(prefix)` takes a scope prefix, not a query (review R2) — the ranking architecture is specified in F3 below.
- Composer's skill branch discards refs today (`refs.value = []` before emit) — review R3.
- Butler src emits ONLY `turn.tool` (the deprecated pair is already gone — the cleanup is documentation-only).
- better-sqlite3 pinned at 11.10.0; the GC crash was root-caused to node 24.20 + fresh installs (cleanroom).
- CRUCIBLE_REPOS_ROOT seam exists; boot seeding covers registered repos since `620c062`.

## Stages (ordered; each ends verified)

### F1 — Skills-in-chat transcript hardening (M)
1. Live-verify follow-up context: run `/planning`, then ask a follow-up referencing the plan; confirm the answer demonstrably uses it (not just "should work").
2. Persist a compact tool-narrative row after each skill run: `used cases.list (2), screens.registry (1)…` from the workflow events — so follow-ups know HOW the answer was derived.
3. Skill run footnote row keeps runId for panel binding.
Verification: browser drill (skill → follow-up quotes plan specifics), suite green.
Scope note (review R4): F1 proves TRANSCRIPT MECHANICS only — the operator's full scenario (follow-up on a plan built from refs) is proven in final Validation after F5.

### F2 — Knowledge grounding + refs for skills (M)
1. `pipeline.skill()` resolves the app (existing chain) and injects the latest `app:<bundle>` knowledge page into the planner/author prompt as BACKGROUND (explicit rule: tools are truth, page is context).
2. Composer: a command chip + ref chips may coexist; send → skill fires WITH refs → compileKnowledge runs first (same as pipeline), then the single stage reads the fresh page.
3. Refs recorded in the skill's persisted user row.
4. (review R3) Composer: the skill branch STOPS discarding refs — they ride the skill event; the skill route validates refs with the SAME filter as the pipeline route (KNOWN kinds); app resolution reuses `resolveAppBundle` verbatim (the `'skill'` literal fallback dies).
5. (review R3) Compile failure → the skill STILL RUNS; the answer is prefixed with an honest line: `refs partially compiled: <what failed>` (operator decision: proceed-with-honest-note).
Verification: skill with an @jira ref produces an answer citing ticket content from the compiled page, AND the negative drill: @jira + an unknown-kind ref mixed → ticket content cited AND the unknown ref surfaced honestly (not silently dropped).

### F3 — C2 retrieval-based memory (L)
1. butler (review R2, seam specified): vectors live in a SIDE TABLE (`note_embeddings`, note_id PK, model, vector BLOB) — storage-agnostic, JS cosine (current volumes <1k notes; no sqlite-vec). Ranking lives in `resolveProfile`: fetch scoped notes → if a query embedding exists (injectable embedder on the profile deps), rank by cosine and take top-k (k=8); else current recency top-20 — the fallback is therefore in ONE place and every consumer (chat + workflow stages) inherits it. `activeNotes` unchanged. Lionidas' `note.save` tool wrapper (draft-tools.ts:146) owns embed-at-save via `OpenAICompatEmbedding` (probe the endpoint/model FIRST — review's open check).
2. Embeddings provider: openai-compat `/embeddings` via existing BUTLER_* env + `EMBED_MODEL` override (decision: reuse).
3. Embed at `note.save`; backfill script for existing notes (idempotent; review R6: batches of 20 with a small delay, skips notes that already have embeddings — resumable, rate-limit safe).
4. Butler tag v0.4.2; lionidas pins it.
Verification: hermetic ranking tests (injectable embedder); live drill shows relevant notes injected for two different asks.

### F4 — C3 persistent claude-cli process (L)
1. **Session isolation FIRST (review R1 — the bleed exists today)**: provider-per-Lionidas-session — a session-keyed provider map (built on demand, evicted with idle TTL) OR a `sessionId` argument threaded through `complete()`. The single shared `ctx.provider` instance with instance-level `sessionId` dies. Interleave test: two sessions, alternating turns, assert distinct `--resume` ids and zero context bleed — this test must pass BEFORE any persistence work lands (otherwise persistence cements the leak).
2. THEN the singleton child per provider: spawn on first use, reuse across turns, respawn with capped backoff on crash, idle TTL 30m, health check per borrow. Hard respawn cap (zombie guard).
3. `BUTLER_MCP_PERSISTENT=0` opts out (tests keep per-turn spawn).
4. GLM middleware (ANTHROPIC_* env injection, MCP config) must survive the per-session + persistent refactor — re-verify the mcpConfigPath flow.
Verification: two consecutive turns in ONE session reuse one process pid; kill -9 the child → next turn respawns and answers; interleave test still green (isolation holds under persistence).

### F5 — Cleanup + C1b (S)
1. Event contract: changelog note in butler (tool.call/tool.result already absent — verified); no code.
2. (review R5) ONE butler tag v0.4.2 cut AFTER F3+F4 complete (covers the storage seam AND the provider work); lionidas pins it here — not at F3.
3. better-sqlite3 bump; drop `.npmrc` build-from-source if prebuilds cover 24.20; cleanroom: fresh install on node 24.20 → boot → smoke (the exact historical crash recipe).
Verification: cleanroom boot log, suites green.

## Edge cases bound into stages

- F2: stale page vs live tools → prompt rule "tools win"; refs+skill+attachment all coexisting.
- F3: embeddings endpoint down → recency fallback (chat must never hard-fail); notes without embeddings (pre-backfill) → included via fallback path.
- F4: zombie children → hard respawn cap + TTL; claude session per Lionidas session; GLM middleware must survive the persistent wrapper.
- F1: aborted skill mid-run → narrative row still written (partial, labeled).

## Validation (end-to-end, after F5)

1. `/planning` with @jira ref → answer cites ticket AC → follow-up question → answer demonstrably builds on the plan (not a fresh take).
2. Two different asks → injected notes differ and are relevant (C2 live proof).
3. Two turns, one provider pid; kill → respawn (C3 proof).
4. Full suites: server, web, butler; tsc ×3; cleanroom boot per F5.

## Rollout

Continues on `feat/refs-at-mention`? NO — new branch `feat/agent-round2` off main AFTER PR #34 merges (human merge per standing rule). Butler gets ONE tag v0.4.2 after F3+F4 (review R5). No DB migrations except the `note_embeddings` side table (additive).
