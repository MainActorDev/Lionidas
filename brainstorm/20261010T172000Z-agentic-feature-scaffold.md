# Agentic feature scaffold — Butler core + Lionidas specialized agents

- Source prompt: "We're scaffolding the agentic feature now" (full rough brief verbatim in `docs` note below — Jira/PR/doc/codebase references, planning→breakdown→author agents, a11y inspector, claude-cli middleware, Butler core infra, phased)
- Created: 2026-10-10T17:20:00Z
- Status: Direction selected (Q1–Q3 answered 2026-10-10 — executor configurable per profile; chat UI after API pipeline; a11y = branch+PR + existing builds)
- Prior art (verified today): Butler `main` @ `3c17edc` (provider seam, loop, tools+policy, memory sqlite+pg, sources BM25+symbol-chunks, conversation API + MCP transports, L2 supervisor fanOut); Lionidas agent layer SHIPPED (`server/src/agent/*` — read/draft tools, v1 policy act-refused, `/api/agent/*` + `/mcp`, notes with provenance, drill-proven authoring loop). Integration plan `20261001T155936Z` conditions 1–9 done except real-Jira (env-gated).

## Goal and context

Move from "one authoring agent, API-only, human tests via Hermes" to the product shape: **a specialized agent team inside Lionidas that turns references (Jira subtasks, GitHub PRs/commits, attached docs, the codebase) into organized, validating test cases/suites — plus durable knowledge artifacts — through a visible pipeline.** Butler matures into the general harness this runs on; claude-cli becomes an optional executor so any major agentic coding app (Claude Code, Codex, Hermes) can drive or BE driven.

User-stated (confirmed): rough brief, questions open, corrections welcome, system design first then flow then UI/UX, UI/UX must be sketched, plans must be phased.

## Verified ground truth (what already exists — do not re-plan)

- Butler already has: provider/loop/tools/policy classes, layered memory w/ provenance + supersession, sources (file/repo/jira-fixture, BM25 + tree-sitter-lite symbol chunks), conversation API + MCP transports, `fanOut` supervisor (L2, budget roll-up, summaries-not-transcripts, session-tree).
- Lionidas already has: agent routes operator-gated, read tools (cases/runs/screens/folders/notes/sources), draft tools (`case.draft.save` through the REAL yaml validator → `status='draft'`), act tools registered-but-REFUSED, notes scoped `app:<bundle>/…`, `docs/agent-drills.md` live-proven.
- claude-cli today (researched 2026-10-10): `claude -p` headless, `--bare` (no host context — recommended for scripted/SDK), `--output-format stream-json`, `--resume <session>`, `--allowedTools`, `--permission-prompts none`, `--mcp-config`, session JSONL on disk, Agent SDK spawns one subprocess per session, subagent depth/concurrency/spend caps via env (`CLAUDE_CODE_MAX_SUBAGENT_*`, `maxBudgetUsd`). SIGTERM kills in-flight turns (143); SIGINT/interrupt() ends turn cleanly.
- Orchestration patterns that matter (researched): plan-and-execute w/ CAPPED re-planning (thrash guard), typed handoffs between stages, summaries-not-transcripts at every boundary, per-agent token budgets, checkpoint/resume of pipeline state, human gate before irreversible actions, "memory beats pattern choice" (journals of decisions > raw logs).

## Exploration — the system design (draft)

### The shape (3 layers)

```
LIONIDAS (product)          chat surface w/ references · pipeline view · artifacts
  └─ claude-cli middleware (executor option) + Butler conversation API/MCP
BUTLER (harness)            agent PROFILES · WORKFLOWS (typed pipelines)
  └─ provider seam: openai-compat | claude-cli | mock   memory · sources · policy
```

### Butler core gaps (the deep-research-informed list)

1. **Agent profiles** — a named record: system prompt, tool subset, policy class, provider+model, budgets, memory scopes. Today a "session" carries these ad-hoc; profiles make "the planner" / "the author" deployable, testable units. (`B1`)
2. **Workflows (pipeline orchestration, L2.5)** — typed multi-stage pipelines (planning → breakdown → author) with per-stage profiles, typed handoff payloads, capped re-plan counters, checkpoint/resume (survives restart mid-pipeline), and a pause-point type for human questions. fanOut exists; sequential-with-gates does not. (`B2`)
3. **claude-cli executor adapter** — Butler provider implementing the seam over `claude -p --bare --output-format stream-json` (+ `--resume` for continuity, `--allowedTools` mapped from the policy class, `--permission-prompts none` under Butler's own permission gate). Butler stays agnostic: claude-cli is one executor next to openai-compat. (`B3`)
4. **Reference ingestion + knowledge merge** — multi-source ingest already exists; add a **knowledge-compilation step**: refs (Jira subtask, PR diff, attached doc, code symbols) → ONE versioned knowledge doc (what we know, per-ref provenance, contradictions flagged, open assumptions) that stages consume and that becomes a durable artifact. (`B4`)
5. **Artifact store** — pipeline outputs beyond cases: planning scope docs, breakdown tables, knowledge docs, a11y reports. Versioned, referenceable by later runs (the user's "documentation the agent references later"). Butler notes exist but are small; artifacts are bigger, named, linked. (`B5`)

### Lionidas consumer layer

- **The test-author pipeline** (one assistant, three specialists — matches the user's "one agent for now"):
  - **Planning**: compiles references → scope doc (what to test, what NOT, risk areas, AC extraction) + may ASK QUESTIONS (pause-point; chat surfaces them to the human).
  - **Breakdown**: scope doc → organized case list (names, folders, coverage rationale, dedupe against existing cases via read tools).
  - **Author**: writes the case/suite YAML through the existing validating draft seam, organizes folders, saves selector-trust notes, emits the artifact set.
- **A11y inspector agent** — separate, NOT part of planning (correction below): reads the workspace repo, writes accessibility identifiers per the rules, builds .ipa/.apk. This is the FIRST act-class graduation (repo write + build), gated.
- **Chat surface** — new Lionidas web panel (reverses I4's "no UI" — that was v1 test-path only). References attachable, pipeline stage visible, artifacts browsable, draft cases linked. SKETCH ROUND MANDATORY before build (≥3 variants, house tokens).

### Corrections I owe you (openly, per your note 4)

1. **A11y-inspector inside the planning agent — recommend AGAINST.** Different tool class (act: repo write + build vs read/draft), different failure cost, different cadence. Keep it a separate specialized agent; the PLANNER may list "missing identifiers" as a scope item and the human triggers the inspector. Collapsing it into planning couples a risky capability to a safe one.
2. **claude-cli "middleware" placement.** If claude-cli sat IN FRONT of Butler (Claude Code orchestrating), Butler's policy/memory/tools would be bypassed. Recommended: claude-cli BEHIND Butler's provider seam as an executor (and Butler already exposes MCP so Claude Code can also be a CLIENT when useful). Agnostic in both directions, but the product spine stays Butler.
3. **Questions from the planner** are a first-class UX element, not an error state — the pipeline PAUSES, the chat surfaces the question with reference context, answers resume it. This needs the pause-point type in B2.

## Proposed phases

- **P0 — Research + design lock (this brainstorm → answers → system-design doc).** No code.
- **P1 — Butler core**: B1 profiles, B2 workflows w/ pause+checkpoint, B5 artifacts (B3 claude-cli adapter, B4 knowledge-merge). Each with contract tests; Butler repo, its own plan.
- **P2 — Lionidas pipeline**: mount the test-author workflow; planner/breakdown/author as profiles over existing read/draft tools; references ingest UI-less (API); drill: fixture ticket → artifacts + validating draft cases.
- **P3 — Chat surface UI**: sketch round (≥3 variants) → build chat panel with references, stage view, questions, artifacts. (Reverses I4; new decision needed.)
- **P4 — a11y inspector + build**: act-class graduation with human gate per commit/PR; rules doc; build → .ipa/.apk via existing builds machinery.
- **P5 — claude-cli executor live** (if P1 shipped it as mock-tested): real claude-cli per-agent profiles; cost/quota policy.

## Open questions

1. ~~Executor for the three authoring specialists~~ — **answered 2026-10-10: CONFIGURABLE per agent profile, no fixed vendor.** Butler's provider seam makes each profile's executor a config field (`openai-compat` | `claude-cli` | `mock`); the deployed defaults are ops-set (env/config), switchable per agent without code. This was the real intent of "claude-cli for the agentic chat middleware in Lionidas … Butler is agnostic."
2. ~~Chat UI confirms the I4 reversal?~~ — **answered 2026-10-10: YES, but AFTER the API-only pipeline ships** (UI sketches once the flow is real — P2 then P3).
3. ~~a11y inspector's write path~~ — **answered 2026-10-10: branch + PR, human merges; reuses the existing Lionidas builds pipeline for .ipa/.apk.**

## Next step

Answer Q1–Q3. Then: Butler-repo plan for P1 (`hms-plan-from-brainstorm`, its own review gate), Lionidas-repo plan for P2 in parallel; sketch round only at P3 per the mandatory-preview rule.
