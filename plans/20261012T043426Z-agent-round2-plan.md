# Agent round 2 — skills-in-chat context, C2 retrieval memory, C3 persistent MCP, cleanup

- Source brainstorm: `brainstorm/20261012T034031Z-agent-round2-limits-and-skill-context.md` (status: direction selected across follow-up answers: skills+refs YES; C2 stays with Lionidas memory, reuse BUTLER_* endpoint for embeddings; C4 deferred — the operator is the eval loop; tag hygiene dropped)
- Created: 2026-10-12T04:34:26Z
- Status: Ready

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
- claude-cli provider spawns per `complete()` (claude-cli.ts); GLM middleware wraps it in context.ts; `--resume` statefulness is a documented hazard.
- Butler src emits ONLY `turn.tool` (the deprecated pair is already gone — the cleanup is documentation-only).
- better-sqlite3 pinned at 11.10.0; the GC crash was root-caused to node 24.20 + fresh installs (cleanroom).
- CRUCIBLE_REPOS_ROOT seam exists; boot seeding covers registered repos since `620c062`.

## Stages (ordered; each ends verified)

### F1 — Skills-in-chat transcript hardening (M)
1. Live-verify follow-up context: run `/planning`, then ask a follow-up referencing the plan; confirm the answer demonstrably uses it (not just "should work").
2. Persist a compact tool-narrative row after each skill run: `used cases.list (2), screens.registry (1)…` from the workflow events — so follow-ups know HOW the answer was derived.
3. Skill run footnote row keeps runId for panel binding.
Verification: browser drill (skill → follow-up quotes plan specifics), suite green.

### F2 — Knowledge grounding + refs for skills (M)
1. `pipeline.skill()` resolves the app (existing chain) and injects the latest `app:<bundle>` knowledge page into the planner/author prompt as BACKGROUND (explicit rule: tools are truth, page is context).
2. Composer: a command chip + ref chips may coexist; send → skill fires WITH refs → compileKnowledge runs first (same as pipeline), then the single stage reads the fresh page.
3. Refs recorded in the skill's persisted user row.
Verification: skill with an @jira ref produces an answer citing ticket content from the compiled page.

### F3 — C2 retrieval-based memory (L)
1. butler: storage gains optional `embed(text): Promise<Float32Array>`; `notesBlockFor` retrieves top-k (k=8) by cosine similarity to the ask when embeddings exist, falls back to recency top-20 otherwise (env-less → honest fallback, chat never breaks).
2. Embeddings provider: openai-compat `/embeddings` via existing BUTLER_* env + `EMBED_MODEL` override (decision: reuse).
3. Embed at `note.save`; backfill script for existing notes (idempotent).
4. Butler tag v0.4.2; lionidas pins it.
Verification: hermetic ranking tests (injectable embedder); live drill shows relevant notes injected for two different asks.

### F4 — C3 persistent claude-cli process (L)
1. Singleton child per server lifetime: spawn on first use, reuse across turns, respawn with capped backoff on crash, idle TTL 30m, health check per borrow.
2. `BUTLER_MCP_PERSISTENT=0` opts out (tests keep per-turn spawn).
3. Session isolation: each Lionidas chat session maps to its own claude session id (no `--resume` cross-talk) — verify explicitly.
Verification: two consecutive turns reuse one process (log the pid), kill -9 the child → next turn respawns and answers.

### F5 — Cleanup + C1b (S)
1. Event contract: changelog note in butler (tool.call/tool.result already absent — verified); no code.
2. better-sqlite3 bump; drop `.npmrc` build-from-source if prebuilds cover 24.20; cleanroom: fresh install on node 24.20 → boot → smoke (the exact historical crash recipe).
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

Continues on `feat/refs-at-mention`? NO — new branch `feat/agent-round2` off main AFTER PR #34 merges (human merge per standing rule). Butler gets v0.4.2. No DB migrations except the embeddings column/table (additive).
