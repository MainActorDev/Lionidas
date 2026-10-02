# Agentic Infrastructure Core — `agent-core` package + Lionidas agent v1

- Source brainstorm: `brainstorm/20261001T035356Z-agentic-infrastructure-core.md` (read in full 2026-10-01)
- Status: **Ready** (rev 3.1, 2026-10-01 — re-review F8–F10 edits applied; repo strategy overhaul per brainstorm `20261001T081628Z-agent-core-distribution-orchestration.md`: standalone PRIVATE repo `MainActorDev/butler`, package `@mainactordev/butler`, generic demo validation, Lionidas integration deferred to a follow-up plan. rev 2 history: review findings F1–F7 + D10–D12; verdict in `reviews/20261001T035356Z-agentic-infrastructure-core-plan-review.md`)
- Plan date: 2026-10-01

## Decision log (all operator-confirmed, provenance in the brainstorm)

| # | Decision | Source |
|---|---|---|
| D1 | Lionidas-as-product → hybrid architecture: in-house reusable core + embedded loop and MCP surface driving the same tool registry | brainstorm Q1 answer, "Lionidas-as-product" |
| D2 | v1 autonomy = **authoring-only**: reads everything, drafts case YAML / recipes; never executes on devices; human presses play | brainstorm Q4 answer, "Yes, authoring only first" |
| D3 | Provider = **OpenAI-compatible** (base URL + key + model); works against OpenAI/OpenRouter/LiteLLM/vLLM | brainstorm Q3 answer |
| D4 | First product surface = **chat panel, UI deferred** — v1 delivers the conversation-shaped server API (sessions/messages/streaming/tool calls); MCP exposes the same core; no web UI work in this plan | brainstorm Q6 answer, "The direction would be a chat panel. But don't worry about the UI for now" |
| D5 | Multi-source ingestion is first-class: Jira, GitHub, codebase repos, attachments → agent must read them to author test cases; Lionidas owns a source registry | operator verbatim in brainstorm "Confirmed inputs" |
| D6 | **Scientifically proven**: every design choice maps to replicated literature; every subsystem ships an eval that can fail in CI | operator verbatim in brainstorm "Confirmed inputs" |
| D7 | The infrastructure is a **reusable package**; Lionidas is its first consumer; hard import boundary enforced by lint from commit one | operator verbatim in brainstorm "Confirmed inputs" |
| D8 | Memory = layered (query memory → conversations → provenance-stamped notes → embeddings deferred with concrete trigger); provenance on every note; supersession, never delete; no auto-writes from transcripts | brainstorm "Memory direction" section; user asked for the deep-dive and proceeded to widen scope on top of it (treated as accepted direction; flagged below under Open items for revocation) |
| D9 | Hosting default for v1: wherever the Lionidas server runs | brainstorm Q2 default, not overridden |
| D10 | Turn-event streaming = **WebSocket** (operator chose live stream; the Lionidas `crucibleBus`/`/api/events` pattern is the model) — NOT SSE (review F2). In v1 the demo app carries its own WS channel; Lionidas wires to `crucibleBus` at integration | operator 2026-10-01: "1. Live stream (web socket)" |
| D11 | MCP transport = **official `@modelcontextprotocol/sdk`** (1.31.0, streamable-HTTP mounted in the Fastify app; stdio bin deferred) | operator 2026-10-01: "But SDK it is" (after review Q2 explanation) |
| D12 | Ingestion caps: **2 MB text/doc**; 10k chunks/source default | operator 2026-10-01: "3. 2MB" |
| D13 | **New standalone repo from the start** (not in-monorepo): `MainActorDev/butler`, private; package `@mainactordev/butler` (bare `butler` taken on npm — checked 2026-10-01) | brainstorm 20261001T081628Z: "1. new repo" + "Private" |
| D14 | Plugin surface = **MCP only** (Claude Code/Codex/Hermes/Cursor are MCP clients; the mounted server is the plugin). No per-host packaging in v1 | operator 2026-10-01: "MCP it is" |
| D15 | **v1 validated entirely in the butler repo against a GENERIC demo consumer — no Lionidas coupling** ("should be working on any use cases"); Lionidas integration = follow-up plan seeded by this plan's former Stage 4 | operator 2026-10-01: "Do the testing fully in the new repo. With a demo project not Lionidas. We'll add the integration process later into Lionidas." |
| D16 | Orchestration = **seams-only + anti-forgetting**: parent_session_id/depth columns (tested by a session-tree test), ROADMAP.md `orchestration-L2` entry with triggers, typed spawn-tool slot documented as extension point | operator 2026-10-01: accepted seams-only; "I'm afraid I'll forget to implement the machinery later" |
| D17 | Package named **Butler** | operator 2026-10-01: "Butler it is" (British-flavored shortlist) |

## Objective

Build **Butler** (`@mainactordev/butler`, private repo `MainActorDev/butler`) — a reusable, framework-free agent runtime (provider, loop, tool registry, layered memory, source ingestion, transports) — validated entirely in its own repo against a **generic demo consumer** with zero Lionidas coupling (D13–D15). The demo proves: **an agent session, driven over a conversation API or MCP, that reads file/web sources, and drafts schema-validating specs a human then reviews.** Lionidas integration is a follow-up plan; this plan's former Stage 4 content is its seed (preserved at the bottom).

## Completion conditions (measurable)

1. The `MainActorDev/butler` repo exists (private) with package `@mainactordev/butler`: `tsc --noEmit` clean, vitest green, no imports from any application — enforced by a boundary vitest test (`test/boundary.test.ts` fails on imports outside the package's own `src/` + its declared deps) and by construction (the repo CONTAINS no app to import — review F3's concern is structurally moot, test kept as regression guard).
2. Agent loop completes a scripted tool-calling conversation against a **mock provider** (deterministic fixture) within budgets; token accounting rows written per turn. A never-responding mock provider aborts with `PROVIDER_TIMEOUT` inside the wall budget and the session stays resumable (review F5).
3. Against the real OpenAI-compatible endpoint (credentials supplied at drill time), one live demo session: given a markdown "ticket" fixture ingested via the file source, the agent **drafts a spec that passes the demo's JSON-schema validator tool** (validator-as-ground-truth, Self-Refine discipline), citing the source documents (by content hash) it used. (The Lionidas yaml-validator variant of this condition moves to the integration plan.)
4. Sessions/messages/notes/documents persist in sqlite via the storage driver; a session resumes with full context replay from rows alone.
5. Permission policy holds: under the `draft` policy, any attempt to invoke an `act`-class tool (the demo registers one example, e.g. `spec.publish`) is refused with a named error — proven by test.
6. MCP server (via `@modelcontextprotocol/sdk`, streamable-HTTP mounted in the demo app — D11/D14) exposes the same tool registry: a tools/list + tools/call round-trip works for at least 3 demo tools. Turn events stream to clients over a WebSocket channel (`butler.*` event types on the demo's WS endpoint — D10; the Lionidas `crucibleBus` wiring moves to the integration plan).
7. Eval harness runs in CI: authoring eval (fixture → validator-pass rate), retrieval eval (query → expected doc in top-k), budget eval (loop respects caps); a deliberately broken prompt fixture FAILS the suite (proves the eval can fail).
8. Butler repo gates green: typecheck, full vitest suite (unit + boundary + eval harness), demo app boot check; CI hermetic (mock provider by default). No Lionidas repo changes in this plan at all.

## Out of scope (v1)

- Web UI of any kind (chat panel UI, note editors) — D4
- Device execution autonomy (play/run/verify as agent tools are **registered but gated off** under v1 policy) — D2
- Embeddings/vector search (Layer 3) — built only on the documented trigger
- Postgres storage driver (interface shipped; sqlite only)
- tree-sitter symbol indexing (repo connector v1 = tree + grep + file fetch)
- Image OCR/vision text extraction (attachments stored; text extraction marked TODO)
- Multi-tenant authz on agent endpoints beyond the existing session/role hook
- Anthropic-native adapter (OpenAI-compatible covers it via gateways)
- MCP stdio bin (streamable-HTTP ships v1; stdio when a CLI consumer exists — D11)
- **Lionidas integration** (tools/policy/sources wiring, crucibleBus events, yaml-validator ground truth) — its own follow-up plan, seeded from this plan's former Stage 4 (D15)
- Orchestration machinery L2/L3 (seams only — D16; ROADMAP tracks triggers)

## Architecture

```
MainActorDev/butler             @mainactordev/butler  (standalone private repo — no app code exists to import)
  src/
    provider.ts                 OpenAI-compatible adapter: baseUrl/key/model,
                                tool-call translation, retries/backoff, usage capture
    loop.ts                     reason→act→observe: bounded hops, token/wall budgets,
                                abort signal, per-turn persistence hooks
    tools.ts                    ToolRegistry: register({name, schema, permission, handler})
    policy.ts                   permission classes: read | draft | act; Policy decides allow/refuse
    memory/
      contract.ts               storage interface (sessions/messages/notes/documents/sources)
      sqlite.ts                 better-sqlite3 driver + guarded migrations
      notes.ts                  provenance rules, supersession, explicit-write gate
      retrieval.ts              BM25 (fts5 or pure-TS okapi) over documents + notes
    sources/
      connector.ts              SourceConnector interface: normalize→document(content-hash)
      file.ts  jira.ts  github.ts  repo.ts     (repo = local path or shallow clone)
    chunk.ts                    structural chunking (markdown headings, ticket fields,
                                diff hunks, file boundaries)
    context.ts                  context assembly: budgets, edges-first ordering
    transport/
      conversation.ts           mountable Fastify plugin: sessions CRUD, message POST;
                                turn events emitted on a WebSocket channel the CONSUMER
                                provides (butler.* event types; core exposes an emitter,
                                the consumer's bus carries it — D10, no SSE; review F9)
      mcp.ts                    MCP server over the same registry via
                                @modelcontextprotocol/sdk, streamable-HTTP mounted in
                                the app (D11; stdio bin deferred)
    eval.ts                     fixture-driven harness: authoring/retrieval/budget metrics
  test/                         vitest: mock provider, in-memory sqlite, fixtures

demo/                          the generic demo consumer (in-repo; zero domain coupling)
  app.ts                        tiny Fastify app mounting conversation API + WS events + MCP
  tools.ts                      ~5 generic tools: tasks.query, docs.read, spec.draft,
                                spec.validate (JSON-schema ground truth), note.save
  sources.ts                    file connector over fixture markdown "tickets"
  policy.ts                     draft-only policy; spec.publish registered as the refused
                                act-class example
  fixtures/ + eval/             ticket fixtures; eval set: ticket → spec passes validator

(later, separate plan)          Lionidas consumption layer — seeded from this plan's
                                former Stage 4, in the Lionidas repo
```

**Key seams**
- Core is dependency-injected only; consumers (demo now, Lionidas later) pass implementations in (D7 rule 1).
- Storage contract in core, driver swap-friendly; `butler_*` tables created by the sqlite driver's guarded migrations in a DB the CONSUMER owns (demo: its own file; Lionidas later: alongside its DB via the same driver).
- **Validators are the ground truth** — the demo's JSON-schema spec validator now, Lionidas's yaml validator at integration. The agent never self-validates drafts.

## Data model (sqlite, guarded CREATE IF NOT EXISTS, snake_case)

- `butler_sessions(id, parent_session_id NULL, depth DEFAULT 0, user_id, title, status, created_at, updated_at, tokens_in, tokens_out)` — parent/depth are the orchestration SEAMS (D16): nullable, unused in v1 machinery, but TESTED (session-tree test) so they cannot rot
- `butler_messages(id, session_id, role, content, tool_calls_json, tool_results_json, tokens_in, tokens_out, created_at)`
- `butler_notes(id, scope_key, kind, content, source_type, source_ref, created_by, created_at, superseded_by, superseded_at)` — kinds: pitfall/convention/env-gate/selector-trust/app-behavior; UPDATE-only supersession
- `butler_sources(id, kind, config_json, status, last_synced_at, created_at)` — kind: jira/github/repo/file
- `butler_documents(sha256, source_id, uri, title, content, kind, fetched_at, bytes_path)` — content-addressed, cache-first. TEXT lives in `content` (≤ 2 MB, D12; oversize → chunked then truncated with marker). BINARY attachments (images/PDFs) store bytes under a consumer-provided artifacts dir, row keeps `bytes_path` + sha256 — same pattern as the `evidence` table (review F6)
- `butler_document_chunks(id, doc_sha256, ordinal, heading_path, content, tokens)` — structural chunks

## Implementation stages

### Stage 0 — New repo + package skeleton
- Create PRIVATE repo `MainActorDev/butler` (gh, main branch protected by convention as in Lionidas); pnpm package `@mainactordev/butler`, tsconfig, vitest, empty exports. Deps: `@modelcontextprotocol/sdk` (D11) + `@modelcontextprotocol/fastify` (Fastify wiring — review F8), `better-sqlite3`, `fastify`, `ws` (transports), `yaml` (fixtures).
- Boundary test `test/boundary.test.ts`: scans `src/**` imports; FAILS on any import outside `src/` + declared deps (regression guard — the repo structurally has no app to leak from, review F3).
- `ROADMAP.md` seeded with the `orchestration-L2` entry + trigger conditions (D16 anti-forgetting).
- `check` script: `tsc --noEmit && vitest run`; GitHub Actions CI (billing caveat known from Lionidas PRs — job may not start; local gates are authoritative).
- **Deliverable:** repo exists, boundary test fails a deliberately-bad import fixture, CI (when it runs) green.

### Stage 1 — Provider + loop (mock-driven, TDD)
- `provider.ts`: OpenAI-compatible chat-completions call (fetch), tool-call translate, retry w/ exponential backoff on 429/5xx, usage capture. No SDK dependency — plain fetch, typed.
- Per-call `AbortSignal.timeout` (default 120s, configurable); retry budget = min(remaining wall budget, backoff cap) — a hung provider can never eat the session (review F5).
- `loop.ts`: hop budget, token budget, wall-clock budget, AbortSignal, turn persistence callback, final answer extraction.
- Mock provider fixture: deterministic scripted turns (tool-call → result → final).
- Tests: loop completes; budget exhaustion → named error; abort mid-loop → clean stop; usage rows correct; never-responding provider → `PROVIDER_TIMEOUT` within wall budget, session resumable.
- **Deliverable:** loop + provider green against mock; zero network in CI.

### Stage 2 — Tools + policy + memory (sqlite driver)
- `tools.ts` registry + `policy.ts` classes; refusal = typed error naming the tool + policy.
- Storage contract + sqlite driver + guarded migrations (the six tables).
- `notes.ts`: explicit-write API only; supersession via UPDATE; provenance mandatory (source_ref required, rejects without).
- `retrieval.ts`: BM25 over chunks + notes (fts5 if available at build time, else pure-TS okapi — decide by feature probe, not preference).
- Orchestration SEAMS (D16): `parent_session_id` + `depth` columns ship in the migration; a session-tree test links child→parent and asserts queryability; spawn-tool slot documented in tool-registry types as an extension point pointing at ROADMAP.
- Tests: registry allow/refuse by policy class; migrations idempotent; notes provenance rejection; supersession; retrieval top-k sanity; session-tree seam.
- **Deliverable:** memory + gates usable; all agent state in sqlite.

### Stage 3 — Source ingestion + chunking + retrieval wiring
- `connector.ts` interface; `file.ts` (paths/uploads), `jira.ts` (REST: issue + comments + attachments list; auth: token env), `github.ts` (REST: issue/PR + diff), `repo.ts` (local path tree + grep + file fetch; shallow clone if given a URL).
- `chunk.ts`: structural boundaries (headings, ticket fields, diff hunks, files).
- Ingest → documents + chunks → retrieval serves queries.
- Cache-first: sha256 equal → skip re-fetch work; `fetched_at` tracked.
- Caps per D12: 2 MB text/doc (chunked then truncated with marker beyond), 10k chunks/source; binary attachments → artifacts dir (review F6).
- Tests: file + repo connectors against fixture trees; jira/github against recorded-response fixtures (no live network in CI); chunk shapes; retrieval finds the right fixture doc.
- **Deliverable:** "ingest a Jira ticket fixture → query → right chunk in top-3".

### Stage 4 — Generic demo consumer (replaces the Lionidas layer — D15)
- `demo/app.ts`: tiny Fastify app mounting the conversation API (`/api/agent/*`), a WebSocket channel emitting `butler.*` turn events (D10 pattern), and the MCP streamable-HTTP endpoint via the SDK (D11/D14). Simple bearer/token gate; nothing domain-specific.
- `demo/tools.ts`: ~5 GENERIC tools — `tasks.query`, `docs.read`, `spec.draft`, `spec.validate` (JSON-schema ground truth), `note.save` — plus `spec.publish` registered as the act-class tool that the draft policy REFUSES (condition 5).
- `demo/sources.ts`: file connector over `fixtures/*.md` "tickets"; ingestion → documents → chunks → retrieval, exactly as a real consumer would wire it.
- Live drill (real endpoint creds; mock otherwise, labeled): ticket fixture → session (conversation API AND an MCP tools/call) → agent drafts spec → `spec.validate` PASS → cites doc hashes. This is completion condition 3.
- Tests: conversation API contract (create session, post message, turn events on WS); MCP round-trip (tools/list + 3 tools/call); policy refusal of `spec.publish`; demo boots from a clean clone with `pnpm i && pnpm -C demo dev`.
- **Deliverable:** conditions 3, 5, 6 proven against the demo; drill logged; README quickstart = the demo.

### Stage 5 — Eval harness + CI + docs
- `eval.ts`: fixtures for (a) authoring: N ticket fixtures → validator pass-rate ≥ threshold; (b) retrieval: query set → expected-doc-in-top-3 rate; (c) budget: loops respect caps.
- CI runs evals with the MOCK provider by default; live-endpoint evals behind env flag (creds absent → skip, honestly reported as skipped).
- One canary fixture proves the harness can fail: VALID input whose expected outcome is intentionally wrong in the harness config (e.g. expected doc excluded from the top-k assertion) — the suite must fail ON THE METRIC ASSERTION (message names the metric), not on a parse error (review F7).
- Docs: `README.md` quickstart (run the demo), `docs/api.md` (package API: provider, loop, tools, memory, sources, transports), `docs/consumers.md` (how a second product adopts butler — the reusability contract; Lionidas integration plan will cite this).
- **Deliverable:** completion conditions 7, 8; reusability documented.

## Edge & failure cases (designed, not hoped)

- Provider down / 429 / 5xx → bounded retry then typed `PROVIDER_UNAVAILABLE`; session stays resumable (rows intact). Hung provider (open socket, no bytes) → per-call timeout → `PROVIDER_TIMEOUT`, retry budget capped by remaining wall budget (review F5).
- Model emits invalid tool call → single structured re-prompt, then named error; loop never crashes.
- Tool handler throws → error becomes the tool RESULT (observation), loop continues (ReAct discipline).
- Budget exhaustion mid-turn → `BUDGET_EXCEEDED` with partial transcript persisted.
- Validator rejects the drafted spec → rejection fed back as tool result for one repair round; second rejection surfaces to the user with the validator errors verbatim (review F10).
- Ingestion of a huge file/repo → caps per D12 (2 MB text/doc, 10k chunks/source); oversize docs chunked then truncated with marker; binaries to the artifacts dir, never inline DB blobs (review F6).
- Concurrent sessions on one sqlite → WAL mode (already the server's mode) + serialized writes; sessions are independent rows.
- MCP client sends unknown tool → named error, no crash.
- Credentials absent → agent endpoints return `AGENT_NOT_CONFIGURED` (not a crash); CLI/MCP surface degrades honestly.

## Scientific grounding checkpoints (per D6)

Each stage's review cites the brainstorm's mapping: grounding via tools (RAG/ReAct), bounded context (lost-in-the-middle), validator-as-ground-truth over self-critique (Self-Refine, constrained decoding), structural chunking (RAG survey/RAPTOR), BM25-first retrieval (BEIR), provenance/supersession (attribution literature), eval-gated autonomy (SWE-bench methodology). A stage that cannot cite its checkpoint doesn't ship.

## Open items (non-blocking, need operator input at build time)

- Live-endpoint credentials (base URL, key, model name) for the Stage 4 demo drill — until provided, drills run against the mock provider and are labeled as such.
- Monthly spend ceiling (shapes budget defaults only; per-turn accounting ships regardless).
- ~~D8 revocation window~~ — memory layering stood through plan review without objection; confirmed.
- ~~Repo/name/visibility~~ — resolved D13/D17: private `MainActorDev/butler`.

## Rollout

New private repo `MainActorDev/butler` (D13): created in Stage 0, work on feature branches off `main`, operator merges (same convention as Lionidas). No Lionidas repo changes in this plan — zero-risk to the product. Evals mock-first so CI stays hermetic; live-endpoint drills are local. Versioning: tag-based (`v0.x` while pre-consumer); publish not required (private git dependency is the consumption path until extraction/publication is ever wanted).

## Follow-up plan seed — Lionidas integration (NOT this plan; content preserved from former Stage 4)

When this plan's v1 is proven, a separate plan in the LIONIDAS repo wires butler in: register Lionidas tools against server code (case yaml validate via the EXISTING validator, `case.draft.save` as a REAL `status='draft'` template through the existing create seam — review F1 — screen registry, run history, folder tree, notes with `app:<bundle>/screen:<id>` scope keys); mount conversation API operator-gated + emit `butler.*`→`crucibleBus` events on `/api/events`; MCP endpoint alongside; jira/github source creds from Lionidas env; v1 policy read+draft only, act tools registered-but-refused; live drill = ticket → validating case YAML.
