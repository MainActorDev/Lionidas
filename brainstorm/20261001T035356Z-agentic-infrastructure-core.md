# Lionidas Agentic Infrastructure — Build vs. Adopt

- Source prompt: "Now, let's move onto something else. I think now it's the time for us to create the agentic infrastructure (core). I honestly don't know which direction I'm going to take. Should we just spawn claude-cli/similar tools or create our own in-house infrastructure? If in-house, we need to design the infra with LLM model configurations, memory system, RAG, harness, API calls and so on." + three reference repos (obsidian-second-brain, codebase-memory-mcp, claude-obsidian)
- Created: 2026-10-01T03:53:56Z
- Status: Direction selected (2026-10-01: "Lionidas-as-product" — hybrid Option C; authoring-only v1; OpenAI-compatible; chat-panel-later. Memory direction deep-dived below.)

## Goal and context

The user wants to give Lionidas an **agentic core** — the layer that lets an AI agent autonomously operate the testing platform: understand a goal, author cases, run them, triage failures, and improve. The CLI (PR #13) was built deliberately as "the surface an agent drives." This is the next layer up: the driver itself.

Two rough directions were named:
1. **Adopt** — spawn claude-cli (or Codex/Gemini/OpenCode CLI) as the agent runtime; Lionidas stays a tool surface.
2. **In-house** — build our own agent loop: LLM model configuration, memory system, RAG, harness, API calls.

The user explicitly does not know which direction — this brainstorm's job is to map the decision honestly, not to champion in-house.

**Context that shapes this** (from the Lionidas arc, my observation — not user-confirmed for this feature):
- The CLI contract was designed for machine consumption: `--json` everywhere, exit-code verdicts (0/1/2), named errors, id|name resolution. An agent can already drive it blind.
- Memory note from earlier Lionidas planning: "FUTURE: AI agent authors test cases from registry + grammar (machine rulebook)" — an agent authoring cases from the screens/step registry was already the long-term intent.
- The stack is TypeScript (pnpm workspace: server/shared/web/cli). Any in-house loop would live naturally as another workspace package.
- There is also the existing `Hermes` context (this assistant runs on Hermes Agent) and `hermes-colony` for multi-agent orchestration — relevant prior art sitting on the user's machine, though Lionidas-the-product shipping a dependency on the user's personal agent tooling is a different question.

## Confirmed inputs and decisions

- **ADDED 2026-10-01 (user, verbatim):** "Lionidas (agentic) later will have to read from various sources of information to mostly create testcases. Such as from Jira, Github, codebase repo (will need to have a registry system to Lionidas), attachments, and so on." → the agent is fundamentally a **multi-source → test-case authoring** system; Lionidas needs a **source registry** (incl. codebase repos).
- **ADDED 2026-10-01 (user, verbatim):** "We need to implement it scientifically proven" → design decisions must map to established, reproducible results from the LLM/RAG/agent literature — not vibes. See "Scientific foundations" section.
- **ADDED 2026-10-01 (user, verbatim):** "Can we make this agentic infrastructure reusable as package? I might want to implement it for something else." → **the core must be a reusable package**, Lionidas becomes its first consumer. See "Reusability — core as a package" section.
- **DECIDED (2026-10-01, user):** "Lionidas-as-product" — the agent layer is a product feature, not a personal tool. This selects the **hybrid Option C** direction: in-house harness (tool registry + permission gates + memory) with both an embedded loop driver (web-integrated) and an external MCP surface. Q1 of the open questions is now answered; Q2–Q5 remain.
- The user named the in-house scope themselves: "LLM model configurations, memory system, RAG, harness, API calls and so on."
- Three reference repos were supplied as "just some of the repos that we can use for reference or idea" (verified via GitHub API, 2026-10-01):
  - **obsidian-second-brain** — an Obsidian vault as cross-platform agent memory; 47 commands; runs on Claude Code, Codex, Gemini CLI, OpenCode, Hermes, etc. Thesis: *vault outlives whichever CLI you switch to* — memory as plain files, agent-agnostic.
  - **codebase-memory-mcp** — a pure-C MCP server that indexes codebases into a graph (tree-sitter, 162 languages, SQLite in-memory, Cypher queries, impact analysis, ADR management). Thesis: *structural memory of a codebase as an MCP tool any agent can call* — 120× fewer tokens than grep/read cycles.
  - **claude-obsidian** — 15 coordinated Agent Skills that turn an Obsidian vault into a knowledge system (ingest → linked pages → BM25/cosine retrieval → lint). Thesis: *knowledge lifecycle as small skills with strict trust rules* (scoped saves, provenance, never auto-save transcripts).
- Nothing else is decided. No model choice, no budget, no hosting constraint, no timeline.

## Exploration

### What "agentic infrastructure" actually decomposes into

Regardless of adopt-vs-build, an agent that operates Lionidas needs five things. Separating them prevents the classic trap of building a whole runtime when only one layer is missing:

| Layer | What it does | Adopt via CLI tools | In-house |
|---|---|---|---|
| **Model + loop** | Chat completion, tool calling, retries, context window management | Free (the CLI brings its own loop) | Provider-adapter (OpenRouter/Anthropic/OpenAI-compat), agent loop, token budgeting |
| **Harness** | The tools the agent may call + permission gating + sandboxing | The CLI's own tools (bash/read/write) + our `lionidas` CLI on PATH | Our own tool registry: `case.new`, `run.verify`, `screen.yaml`… mapped 1:1 to the CLI commands we already shipped |
| **Memory** | What persists across sessions: decisions, learned pitfalls, project state | Claude Code memory files / CLAUDE.md conventions | Our tables: a `agent_notes` store + the run history itself is memory |
| **RAG / retrieval** | Finding the right case, screen, past failure, doc chunk | CLI tools' built-in search (grep-based) | Embedding index over cases/screens/past triages — or skip embeddings: Lionidas data is small and structured; SQL + BM25 may be enough |
| **Evals / guardrails** | Judging agent output before it touches real devices | Manual review | Schema validation (the yaml validator IS a guardrail), dry-run mode, sandboxed sim scope |

### Option A — Adopt a CLI agent (spawn claude-cli et al.)

Lionidas ships the **playbook + CLI + MCP-optional**; the agent runtime is the user's choice.

- *How:* `lionidas` on PATH + `docs/agent-playbook.md` (already merged) + optionally a small MCP server wrapping ~15 core commands so any MCP host (Claude Code, Codex, Hermes, Cursor) can drive it natively.
- *Strengths:* near-zero maintenance; the loop/tool-calling/context-management problem is someone else's full-time job; model choice stays with the user; the three reference repos all prove this pattern works (they're all "agent-agnostic memory, bring your own CLI").
- *Weaknesses:* no product-controlled experience; every user wires their own keys; hard to embed in Lionidas-web ("click: let the agent fix this flake"); vendor lock-in at the harness level; can't guarantee deterministic budget/permissions.

### Option B — In-house full stack (model config + memory + RAG + harness)

Lionidas becomes its own agent product.

- *How:* new `agent/` workspace package: provider adapter (OpenAI-compatible + Anthropic), tool registry generated from the CLI commands, agent loop with step budgets, sqlite memory tables, optional embedding index.
- *Strengths:* product-owned experience (web button → agent runs in a lane on a sim, files the triage back into the run); deterministic permissions (agent can NEVER touch a device outside its lane — we own the enforcement); model-agnostic config; the memory becomes part of the product's data (every triage teaches the next run).
- *Weaknesses:* real cost — the loop is the easy 20%; context management, tool-error recovery, evals, and prompt drift are the hard 80%. Duplicates what claude-cli/Codex/Hermes already do well. Needs an eval harness before it can be trusted on real devices.

### Option C — Hybrid: in-house harness, adopted loop (proposal)

The reference repos triangulate a third shape that fits Lionidas unusually well:

- **The harness is the product; the loop is pluggable.** Build the Lionidas-native tool registry + permission gates + memory as a **provider-agnostic "agent core"** (small: a tool-calling interface + a session/memory schema), then implement TWO drivers for it:
  1. `driver: embedded` — our own thin loop (one provider adapter, ~500 lines) for the web-integrated "agent fixes this run" experience.
  2. `driver: external` — the same tool registry exposed as an MCP server, so claude-cli/Codex/Hermes drive the identical gated surface.
- Memory follows the **second-brain thesis**: plain, portable files (or our sqlite), never a vendor's proprietary memory — so the agent layer can be swapped without losing what was learned.
- Retrieval follows the **codebase-memory thesis** but scoped honestly: Lionidas data is already structured (screens registry, step grammar, case versions, triage reasons). The first retrieval layer is SQL + keyword; embeddings only if that demonstrably fails.
- This also matches the "machine rulebook" memory note: the screens.yaml registry + step grammar + narrate ACs are exactly the structured ground truth an agent authors cases against — no RAG needed to teach the grammar, it's a schema.

### Memory direction (deep dive, 2026-10-01 — user flagged memory as the topic to get right)

**What the agent actually needs to remember** falls into four distinct kinds, and conflating them is the classic memory-system failure. Lionidas already has three of the four as first-class relational data:

| Kind | Question it answers | Where it lives (already!) |
|---|---|---|
| **World state** | What apps/screens/steps/recipes exist? What's the grammar? | `app_screens`, templates yaml, step grammar — *the machine rulebook already noted in project memory* |
| **History** | What ran, what failed, why? | `runs`, `run_steps` (reasons), evidence, case_versions — 2,386 run_steps in the pilot DB already carry failure knowledge like "label Definitely Missing", alloy watchdog notes |
| **Conversations** | What did this user ask, what did the agent say? | *Does not exist yet* — agent_sessions / agent_messages tables (the chat-panel substrate) |
| **Distilled knowledge** | What have we LEARNED? ("that screen needs settle-wait", "this env var gates that feature", "selector X is flaky on iOS 26.4") | *Does not exist yet* — the true memory system |

The insight: **Lionidas is not a chatbot with a RAG bolt-on. It is a structured system where 80% of "memory" is queries.** The screens registry answers "what can I tap"; run history answers "what failed last time"; case versions answer "what changed." An agent with SQL tools has perfect recall of the past without a single embedding.

**Proposed direction — layered, embeddings deferred:**

1. **Layer 0 — Query memory (exists):** the agent's read tools ARE memory. `run list --status failed`, `case versions`, `screen yaml` — grounded, always fresh, zero drift, zero infrastructure. The tool registry from the CLI surface already delivers this.
2. **Layer 1 — Conversation memory (new tables, simple):** `agent_sessions(id, user_id, title, created_at)` + `agent_messages(session_id, role, content, tool_calls_json, tokens_in, tokens_out, created_at)`. Chat UI + MCP both resume from these. Plain rows — a session IS replayable context.
3. **Layer 2 — Distilled notes (new table, structured, provenance-stamped):** `agent_notes(id, app_bundle, screen_id?, flow?, kind, content, source_type, source_ref, created_by, created_at, superseded_by)`. Kinds: `pitfall`, `convention`, `env-gate`, `selector-trust`, `app-behavior`. **Crucial rule from claude-obsidian's trust architecture:** notes are never auto-written from transcripts; they're written by an explicit digest step (post-run, post-triage, or user-pinned), each stamped with *why we believe this* (source_ref → run_id / step idx / session). Notes are injected into the agent's system prompt by (app, screen, flow) keys — structured lookup, not semantic search.
4. **Layer 3 — Semantic retrieval (explicitly deferred):** only if/when Layers 0–2 demonstrably fail — e.g. "find that case where the map pins cluster weirdly" across thousands of cases. Trigger to build it: a real query that SQL+notes cannot answer. Then: embeddings over case yaml + narrate ACs + notes, stored beside the DB, provider-agnostic (local model or gateway), never a proprietary vendor memory.

**Why not embeddings-first (challenge to the RAG instinct):** the pilot corpus is tiny (6 cases, ~30 screens); vector search over 6 documents is theater. Worse, early RAG systems poison the distilled layer — stale retrievals get quoted as fact. Query-first means every "memory" the agent cites is live, structured, and verifiable. The repos agree: second-brain keeps memory as portable plain files; codebase-memory structures before it retrieves; claude-obsidian gates writes with trust rules. All three earn semantic search only after structure.

**Forgetting (the other half of memory):** notes supersede (`superseded_by`), never delete — an audit trail of what the agent used to believe. Notes tied to an app version get aged out when `app_version` bumps. Conversations are cheap rows; retention policy can come later (product decision, not v1).

**What this makes the memory direction, in one line:** *SQL is the recall, tables are the learning, embeddings are a later upgrade — provenance on every note, supersession instead of deletion.*

### Source ingestion — the multi-source authoring pipeline (added 2026-10-01)

The user widened the job: the agent doesn't just read Lionidas tables — it must **ingest external sources to author test cases**: Jira tickets, GitHub (issues/PRs/code), codebase repos, attachments (mockups, PRDs, screenshots). This reframes the memory stack with an ingestion front-end:

```
sources (Jira · GitHub · repo · attachments · pasted text)
   ↓  connectors: fetch + normalize → SOURCE DOCUMENTS (content-addressed, cached)
   ↓  chunking + indexing (structural first: headings/tickets/diffs; semantic later)
   ↓  retrieval at authoring time (SQL/keyword → rerank → context assembly)
   ↓  agent authors case YAML against the screens registry + step grammar (validator = ground truth)
```

Design commitments this adds:
1. **`agent_sources` registry** (new): what Lionidas is allowed to read — source type (jira/github/repo/file), connection config (per-tenant creds, PATs like the CLI's), sync state, last fetched. Nothing ingests without a registered source — provenance starts at the front door (each stored document carries source_ref + fetched_at + content hash).
2. **`agent_documents`** (new): normalized, content-addressed documents (sha256 key) — a Jira ticket, a PR diff, a file blob, an image with extracted text. Cache-first: re-fetch only when the source says changed (ETag/updated fields). Attachments (images) store OCR/vision-derived text alongside bytes.
3. **Ingestion is not believing.** Documents are *evidence*, not truth: the agent cites documents by hash when drafting a case, and the case's ticket_key/pinned doc versions record what it was authored against (same discipline as case_versions provenance).
4. **Codebase repos are a source with structure** — the codebase-memory-mcp thesis applies here: index a registered repo structurally (tree, symbols optional v1) so "where is the login screen implemented" is a lookup, not a crawl. v1: file tree + grep + explicit files; tree-sitter depth later.
5. **Retrieval stays layered** — SQL/keyword over documents first; embeddings (Layer 3) enter through this pipeline when volume demands it, and the same "deferred until a real query defeats it" trigger applies.

### Scientific foundations — "implement it scientifically proven" (added 2026-10-01)

The user requires design choices grounded in reproducible results, not folklore. Mapping each core choice to the established literature it rests on (all widely replicated; the plan will cite specifics per component):

| Design choice | Established result it rests on |
|---|---|
| **Grounding: agent reads live structured state via tools (Layer 0), never free-recalls it** | Retrieval-augmentation beats parametric recall for factual accuracy (Lewis et al., RAG, NeurIPS 2020); tool-augmented agents reduce hallucination vs. closed-book generation (ReAct, Yao et al., ICLR 2023) |
| **Agentic loop = reason→act→observe with tool calls** | ReAct (Yao et al. 2023); function-calling agent loops (Schick, Toolformer, 2023) — the pattern every production harness uses |
| **Notes carry provenance; no auto-write from transcripts; supersession over deletion** | Attribution/verifiability improves trust and error detection (attributed QA literature — Bohnet et al., attributed QA, 2022; Rashkin et al., measuring attribution, ACL 2022). Supersession = temporal knowledge-base correction (temporal KG literature) |
| **Context assembly: bounded, relevant, structured-first** | Lost-in-the-middle: long contexts degrade recall positional (Liu et al., TACL 2024) → budget context, put critical content at edges; structured (tabular/schema) context outperforms prose dumps for verifiable tasks |
| **Validator as the ground truth (case yaml PUT validates before persist)** | Constrained decoding / schema-constrained generation reduces invalid outputs (e.g., JSON-mode/grammar-constrained generation literature); execution feedback beats self-critique (Self-Refine uses external signals, Madaan et al., 2023) |
| **Chunking: structural boundaries over fixed windows** | Structure-aware chunking (headings/AST boundaries) outperforms naive fixed-size for retrieval quality (widely replicated in RAG surveys — Gao et al., RAG survey 2023; tree-structure indexing, RAPTOR, Sarthi et al., 2024) |
| **Retrieval: keyword/SQL before vectors, hybrid when both** | BM25 remains a strong baseline that pure-dense retrieval often fails to beat (BEIR, Thakur et al., NeurIPS 2021); hybrid sparse+dense is the consistent winner (many IR results; e.g., Luan et al. 2021) — justifies deferring embeddings without falling behind |
| **Reranking when corpus grows** | Cross-encoder reranking over first-stage retrieval is a standard, replicated gain (Nogueira & Cho, BERT reranker, 2019) |
| **Eval before autonomy** | Agent benchmarks require task-level success metrics, not vibes (AgentBench, SWE-bench methodology); regression-gated autonomy mirrors RLHF/eval-gated deployment practice |
| **Token accounting + context budgets per session** | Bounded-context/summarization policies for long horizons (dialogue context compression literature); cost measurement as a first-class metric (efficiency results across inference papers) |

**What this rules out (as unproven or risky):** fully autonomous memory writes from raw transcripts (unattributed, drifts — contradicts attribution results); giant single-prompt "stuff everything" contexts (lost-in-the-middle); embeddings-only retrieval (BEIR); trusting model self-critique over executable validation (Self-Refine's external-signal finding).

**Verification culture, not just citations:** each subsystem ships with an eval — the repo convention already does this (vitest + real-server contract tests). The agent layer adds: authoring evals (given a ticket fixture → does the drafted case validate + pass human review gates?), retrieval evals (given a query → is the right document in top-k?), and regression suites so a prompt/model change that degrades any metric is caught in CI. That is the operational meaning of "scientifically proven" here: **every claim has a test that can fail.**

### Reusability — the core as a package (added 2026-10-01)

The user wants the agentic infrastructure itself reusable for other products. This changes the architecture from "a Lionidas feature" to "**a standalone agent framework, Lionidas is its first consumer**" — and it resolves cleanly along the seam the design already has:

**Two packages, hard boundary:**

```
@<scope>/agent-core          (reusable — zero Lionidas imports)
  provider     OpenAI-compatible adapter, model config, token accounting, retries
  loop         reason→act→observe engine: tool calls, budgets (steps/tokens/wall), abort
  tools        ToolRegistry interface: name → schema + handler + permission class
  memory       the layered contract: KV sessions, notes w/ provenance + supersession,
               document store (content-addressed), retrieval interface (BM25 first)
  sources      SourceConnector interface: fetch→normalize→document (jira/github/repo/file
               connectors ship as OPTIONAL addons in the same package)
  harness      permission gates (read-only / draft / act), eval harness contract
  transport    conversation-shaped API surface (HTTP/SSE) + MCP server adapter —
               both drive the SAME registry

lionidas (the app)           (consumer)
  tools that call its own server code (case yaml validate, screen registry, run history…)
  its notes schema keys (app_bundle/screen/flow), its sources (its Jira, its repos)
  its guardrail policy: v1 = read + draft-only, validator = ground truth
```

**Rules that keep the core reusable (the discipline that makes or breaks this):**
1. **Core never imports app code.** Dependency direction: app → core, always. If the core needs Lionidas data, the app registers a *tool* or a *retrieval provider* — the core calls interfaces, not tables. (Same law as `cli/src/client.ts` being the only server-contact layer.)
2. **Domain concepts stay out of the core vocabulary.** No "case", "screen", "run", "udid" in agent-core — only the generic shapes: documents, notes, tools, sessions, sources. Lionidas-specific tools live in the Lionidas app package.
3. **Storage is pluggable.** Core defines the persistence interface (sessions/notes/documents); ships a **sqlite driver** (Lionidas uses it), a postgres driver can come later. Migrations owned by the driver, schema by the core contract + driver tests.
4. **Everything the product needs is a policy, not a fork.** Autonomy level (authoring-only), budget ceilings, permission gates, model choice — all constructor/config arguments. If a second product needs "act" autonomy, it passes a different policy; it does not patch the core.
5. **The MCP server + conversation API come from the core** — any product built on it gets both surfaces for free, which is the concrete payoff of reusability.
6. **Eval harness is part of the core contract.** Products define fixtures; the core runs them (retrieval top-k, authoring validate-rate, budget adherence) so "scientifically proven" travels with the package.

**Where it lives (proposal, unaccepted):** a sibling workspace package in this monorepo first (`agent/` — the pnpm workspace already hosts shared/cli; dogfooding in-repo is the cheapest path to v1), extracted to its own repo/package (`@mainactor/agent-core` or similar) once a second consumer exists. Premature extraction before consumer #2 is a known trap — the boundary above is what makes later extraction cheap, and it's enforceable from day one with a lint rule (`no-restricted-imports`: agent-core may not import `server/`, `shared/`, `web/`, `cli/`).

**What this does NOT change:** the staged plan is identical — same layers, same order — just with the package boundary drawn from commit one instead of retrofitted.

Smallest honest scope for a first cut:
1. `agent/tool-registry.ts` — map of tool name → schema + handler, generated from CLI commands (they already share arg parsing).
2. `agent/provider.ts` — OpenAI-compatible + Anthropic adapters, model config per run (model, temperature, max tool hops, token budget).
3. `agent/memory.ts` — `agent_notes` table (keyed by app bundle + screen + flow), write path = post-triage digest; read path = inject top-N relevant notes into the system prompt.
4. `agent/loop.ts` — tool-call loop with hard budgets (max steps, max tokens, wall clock) and a kill switch tied to run abort.
5. Harness guardrails: agent may only run cases on an explicitly assigned lane (udid), writes limited to case yaml + notes, everything else read-only.

That's a realistic 2–4 week arc for a first working cut — versus an afternoon for Option A's "install claude-cli + write the MCP wrapper."

### Risks worth naming now

- **Prompt-drift maintenance** is the recurring cost nobody budgets for — in-house means owning it forever.
- **Device safety:** an agent with device power + case-run tools can wedge real sims; permissions must be lane-scoped from day one.
- **Cost observability:** model config without per-run token accounting will surprise someone.
- **The eval question:** before any autonomy, define what "the agent did well" means (case passes? flake found? human review?). Without it, the agent demo impresses and then rots.

## Open questions

1. ~~Who is the agent for~~ — **answered 2026-10-01: Lionidas-as-product.** Hybrid C it is.
2. **Hosting/deployment context** — does this need to run on your Linux+Win Colony boxes (Indonesia-first), or is macOS-local enough for v1? *Can default to "wherever the server runs" for v1.*
3. ~~Model budget & keys~~ — **answered 2026-10-01: OpenAI-compatible provider.** (Exact endpoint/key + any monthly ceiling still needed at build time; the adapter targets the OpenAI-compatible API shape — base URL + key + model name, so any gateway — OpenRouter, LiteLLM, vLLM, OpenAI itself — works.) Per-run token accounting still required from day one (product).
4. ~~Autonomy level for v1~~ — **answered 2026-10-01: authoring-only.** The agent drafts/edits case YAML and recipes; a human presses play. Device execution graduates later once guardrails prove out.
5. ~~Memory shape~~ — **direction deep-dived 2026-10-01 (see "Memory direction" section): layered.** Layer 0 = existing tables as query memory; Layer 1 = agent_sessions/agent_messages conversation rows; Layer 2 = provenance-stamped agent_notes (supersession, never delete, no transcript auto-writes); Layer 3 = embeddings deferred until a real query defeats SQL+notes. *This is a labeled proposal awaiting the user's read — the user flagged memory as the topic to nail, so it should be confirmed before the plan.*
6. ~~Where does the agent surface first in the product~~ — **answered 2026-10-01: a chat panel, direction C — but UI is explicitly out of scope for now** ("don't worry about the UI for now"). v1 therefore = the server-side agent core with a conversation-shaped API (sessions, messages, streaming replies, tool calls) that a chat UI can later attach to; the MCP surface exposes the same core to CLI agents.

## Next step

All direction-setting questions are answered:
- **Product, not personal tool** → hybrid C (harness as product, embedded loop + MCP surface)
- **Authoring-only autonomy** for v1 — the agent reads everything, drafts case YAML/recipes, never touches devices
- **OpenAI-compatible provider adapter** (base URL + key + model; any gateway works)
- **Chat panel is the eventual surface, UI deferred** — v1 delivers a conversation-shaped server API (sessions, messages, streamed replies, tool calls) + the MCP surface; a UI attaches later
- **Multi-source ingestion is in scope as a first-class pipeline** — `agent_sources` registry (Jira/GitHub/repo/attachments), content-addressed `agent_documents`, structural chunking, layered retrieval; the agent authors against validator ground truth with cited provenance
- **Scientifically-proven discipline** — each design choice mapped to replicated results (RAG, ReAct/Toolformer, BEIR, lost-in-the-middle, attribution, Self-Refine external feedback, structural chunking); every subsystem ships an eval that can fail in CI
- **Reusable as a package** — `agent-core` (provider/loop/tools/memory/sources/harness/transport, zero Lionidas imports, pluggable storage, policy-not-fork) + Lionidas as first consumer; starts as an `agent/` workspace package, extracts to its own repo when consumer #2 appears. Boundary enforceable via lint from day one.
- Remaining minor: Q2 hosting (default: wherever the server runs) and Q5 memory layered direction (deep-dived; awaiting the user's read)

**Next step:** run `hms-plan-from-brainstorm` against this artifact to produce the detailed plan (agent-core package: source registry + document store, tool registry, OpenAI-compatible provider + budgets, memory tables, conversation API, MCP server, eval harness, guardrails — TDD per repo convention; Lionidas consumption layer on top).
