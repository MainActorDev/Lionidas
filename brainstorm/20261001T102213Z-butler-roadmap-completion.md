# Butler roadmap completion + the demo-app question

- Source prompt: "Can we finish the whole roadmap? Except the integration to lionidas. It's really hard to reason what Butler now can do. What about the demo app?"
- Created: 2026-10-01T10:22:13Z
- Status: Questions open
- Parent artifacts: brainstorm `20261001T081628Z-agent-core-distribution-orchestration.md` (orchestration risk register), plan `plans/20261001T035356Z-agentic-infrastructure-core-plan.md` (rev 3.1, shipped)

## Goal and context

Two distinct asks bundled in one prompt — they need different treatment:

1. **"Finish the whole roadmap (except Lionidas integration)."** Butler's ROADMAP.md currently holds: orchestration-L2 (seams-only by D16 decision), embeddings (Layer 3, trigger-gated), postgres driver, MCP stdio bin, tree-sitter indexing. The user wants these DONE — i.e. promote deferred machinery to built machinery.
2. **"It's really hard to reason what Butler now can do."** An admission that the package's current capability surface is hard to grasp from the outside — the real underlying need is *comprehensibility*, not just more features.
3. **"What about the demo app?"** Open-ended — the demo today is an API surface with fixture tickets and a scripted/mock default; there is no human-usable face on it.

**The key insight this brainstorm must resolve:** items 1 and 2 are in tension. Finishing the roadmap ADDS machinery, which makes "hard to reason about" WORSE unless the demo/app simultaneously becomes the lens that makes capability legible. The right framing is not "finish the roadmap" but "finish the roadmap BEHIND a demo that finally shows what Butler is."

## Confirmed inputs and decisions

- Confirmed, verbatim: user wants roadmap completion EXCLUDING Lionidas integration; finds current Butler hard to reason about; is asking (open question, not directive) about the demo app.
- Verified state (2026-10-01): Butler v0.1, 61/61 tests, stages 0–5 shipped; ROADMAP entries as listed above; demo = Fastify API + WS + MCP + two fixture tickets, mock-provider default, no UI.
- Standing decisions that govern this work: D6 (scientifically proven — evals that can fail), D15 (generic demo, zero coupling), D16 (orchestration seams-only **with explicit trigger conditions** — the anti-forgetting design said "do not build ahead of the trigger").

## Exploration

### The roadmap items, honestly assessed

| Item | Why it was deferred | What "finishing" it means now |
|---|---|---|
| **Orchestration L2** | No paying use case; cost multiplies; testing nonlinear (§2 risk register) | Supervisor + spawn tool + budget trees + cancellation. **The triggers have NOT fired.** But "finish the roadmap" IS effectively the user firing the trigger by fiat — eval-fanout is the honest justification to lead with (it's a real, testable workload: run N authoring fixtures concurrently) |
| **Embeddings (Layer 3)** | Corpus too small; BM25 suffices | A provider-agnostic embedding seam + hybrid retrieval (BM25 + cosine rerank) with an eval proving when it helps and when it doesn't. Must NOT silently replace BM25 — hybrid with a measured toggle |
| **Postgres driver** | No consumer needs it | Implement the Storage contract over pg (same guarded-migration semantics, same test suite run against BOTH drivers) |
| **MCP stdio bin** | No CLI consumer exists | A `butler-mcp` bin: stdio transport over the same registry — instantly makes Butler mountable in Claude Code/Codex/Hermes configs |
| **tree-sitter indexing** | v1 tree+grep suffices | Repo connector emits symbol chunks (functions/types) — web-tree-sitter dependency, per-language grammars opt-in |

Each is buildable without violating D6 — but L2 in particular must come WITH its eval harness (that was the deal in D16: "machinery lands WITH its eval").

### The real problem: comprehensibility ("hard to reason what Butler can do")

A capability matrix nobody can read is a product failure. Options:

- **A. Capability-driven demo app (web UI).** A minimal single-page chat over the conversation API + WS events: type a goal, watch the agent think (tool calls streaming live), see drafts + validator verdicts, browse notes/documents/sessions. The UI was deferred (D4) for *Lionidas's* chat panel — but Butler-the-package having its own demo UI is a DIFFERENT decision, and it's the strongest answer to "hard to reason": the demo becomes the interactive documentation.
- **B. Executable tour.** A `demo/tour.ts` script that runs N scripted scenarios end-to-end (search→draft→validate→refuse-act) printing a narrated transcript. Cheaper than UI, works in CI, but passive.
- **C. Docs-only.** Rewrite docs around capabilities, not modules. Cheapest, weakest — the user already read the docs and is still asking.

**Proposal (unaccepted): A + B together.** B ships in a day and doubles as the demo's smoke test; A is the real fix. A small vanilla-JS (or Vue) page served BY the demo Fastify app keeps zero-coupling intact — it talks only to the conversation API/WS/MCP, exactly like any consumer would, so it doubles as the reference client implementation.

### Sequencing proposal (unaccepted)

1. **Demo tour + demo UI first** — solves the stated pain (comprehensibility) immediately; the UI also becomes the harness that makes L2 observable (watch a supervisor spawn children live).
2. **MCP stdio bin** — half-day, high payoff (every CLI agent can mount Butler).
3. **Orchestration L2 WITH eval-fanout** — the one real piece of machinery; ships with supervisor, budget trees, cancellation, and its eval family. Session-tree seam already exists.
4. **Embeddings seam + hybrid retrieval** — with the retrieval eval extended to measure BM25 vs hybrid on a synthetic corpus large enough to matter.
5. **Postgres driver** — contract test suite parameterized over both drivers.
6. **tree-sitter symbol chunks** — opt-in per repo source config.

This ordering front-loads legibility, back-loads risk — and each step still ships evals-first per D6.

## Open questions

1. ~~Demo UI scope~~ — **answered 2026-10-01: minimal chat + live tool calls + data browser, built in VUE** (matches the Lionidas web stack).
2. ~~Orchestration L2 green-light~~ — **answered 2026-10-01: APPROVED.** Build the supervisor + spawn machinery now, leading with the eval-fanout use case, shipping with its own eval family per D6.
3. ~~Embeddings provider~~ — **answered 2026-10-01: the z.ai key** (OpenAI-compatible embedding endpoint behind the seam; CI hermeticity via recorded/mock embeddings, live runs with the key).
4. Priorities/timeline — sequencing proposal stands unless overridden (demo UI+tour → MCP stdio → L2 → embeddings → postgres → tree-sitter).

## Next step

All material questions answered (Vue UI · L2 approved · z.ai embeddings). Run `hms-plan-from-brainstorm` against this artifact to produce the roadmap-completion plan. Note for the plan: Butler repo gains its own `plans/` + `brainstorm/` convention going forward (standalone product); this brainstorm lives in Lionidas only because the conversation started there — the plan itself should be authored in the Butler repo.
