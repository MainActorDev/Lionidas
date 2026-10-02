# Butler → Lionidas integration — scope of implementation

- Source prompt: "I changed my mind. Let's integrate it into Lionidas. Create the scope of the implementation."
- Created: 2026-10-01T15:59:36Z
- Status: Direction selected, all scope questions answered 2026-10-01 (Hermes-as-test-client · pin butler main/v0.2.0 · Jira deferred)
- Parent decisions: Butler plan `20261001T035356Z-agentic-infrastructure-core-plan.md` (rev 3.1) follow-up seed; roadmap-completion plan (shipped, all conditions); `docs/consumers.md` (the adoption contract Butler was built to serve)

## Goal and context

Wire **Butler** (the shipped, tested agent runtime at `../butler`, `@mainactordev/butler`, commit `f271535`) into **Lionidas** as the product's agent layer — replacing the "generic spec-drafting demo" story with the real one: **an agent inside Lionidas that reads sources (Jira tickets, repos, attachments) and drafts validating test cases a human then plays.** This is the integration both repos have been shaped for: Butler's follow-up-plan seed (Lionidas plan, final section) and Lionidas's own memory note ("FUTURE: AI agent authors test cases from registry + grammar").

Operator explicitly reversed the earlier "demo first, integration later" order: integration NOW.

Deliverable requested at this stage: **the scope of implementation** (this artifact), which then feeds `hms-plan-from-brainstorm`.

## Confirmed inputs and decisions

- **DECIDED (2026-10-01, operator):** "Let's integrate it into Lionidas" — the integration is ON, now.
- **DECIDED (2026-10-01, operator):** "Create the scope of the implementation" — this brainstorm defines scope; the detailed plan comes next via the plan skill.
- **DECIDED (2026-10-01, operator):** Butler's roadmap branch is MERGED to main — Lionidas pins a main commit (tag `v0.2.0` at integration time).
- **DECIDED (2026-10-01, operator):** Jira creds NOT yet available — sources v1 = file/repo connectors + Jira wired against recorded fixtures; real-Jira drill is a later env-triggered open item.
- **DECIDED (2026-10-01, operator):** "Let's use hermes for now for the test" — NO chat UI and no raw-curl-only testing in v1: the operator tests the integrated agent THROUGH HERMES (this assistant's own runtime) as the MCP/agent client. Consequence: the MCP surface at `/mcp` is the primary test path; the acceptance drill runs as a Hermes-driven session against the local Lionidas server.
- Verified state (2026-10-01):
  - Butler: main history through `f271535` sits on branch `feat/roadmap-a-tour` (roadmap stages A–H) — **unmerged to butler main**; private repo `MainActorDev/butler`; 91/96 tests green; exports provider/loop/tools/policy/memory/sources/transports/orchestration/embeddings/pg-driver/symbols via one barrel.
  - Lionidas: on `main` at `a7477f8` (PR #13 CLI merged); server/web/cli/shared packages; the yaml validator at `server/src/routes/templates.ts` (POST `/api/templates/yaml/validate`) is the ground-truth seam; PAT auth (PR #13) exists; websocket bus `crucibleBus` on `/api/events`; `case status='draft'` lifecycle exists (schema CHECK `schema.ts:148`).
  - Butler's own `docs/consumers.md` defines the adoption contract (what you bring / what you get / rules of engagement / checklist) — this integration is its first real exercise.
  - The original Butler plan's follow-up seed already sketches: Lionidas tools registered against server code, conversation API operator-gated, `butler.*` events → `crucibleBus`, jira/github creds from Lionidas env, v1 policy read+draft only, live drill = ticket → validating case YAML.

## Exploration — the scope

### What "integrated" means, concretely (the six integration surfaces)

1. **Dependency wiring.** Lionidas server depends on `@mainactordev/butler` via the private git repo (no npm publish). Workspace choice: NOT a pnpm workspace merge — Butler stays its own repo (its own CI/tests); Lionidas pins a commit. `pnpm add @mainactordev/butler@github:MainActorDev/butler#<commit>` (+ `allowBuilds` if any native deps ride along — better-sqlite3 already allowed).
2. **The Lionidas tool registry** (the heart). Tools registered against Lionidas server code, mapped to permission classes:
   - **read:** `cases.list` (templates), `case.yaml.get` (render + read), `runs.history`/`run.steps` (failures + reasons — the triage knowledge), `screens.registry` (the machine rulebook: screens + states), `folders.tree`, `notes.read` (butler notes scoped `app:<bundle>/…`), `sources.search` (BM25 over ingested docs)
   - **draft:** `case.draft.save` (validating PUT — the yaml validator is the ground truth; saves a REAL template with `status='draft'` per the F1 decision, NO shadow store), `case.draft.edit`, `note.save` (provenance mandatory), `sources.ingest` (register + fetch a Jira ticket / repo path)
   - **act (registered, REFUSED under v1 policy):** `case.play`, `run.abort`, `device.power` — the human-presses-play guarantee is the policy, exactly as Butler's demo proved
3. **Transport surfaces.** Butler's `registerConversationApi` mounted at `/api/agent/*` on the Lionidas Fastify app, operator-gated via the existing session/role hook (PAT works — proven pattern from the CLI); `mountMcp` at `/mcp` (same registry) so Claude Code/Codex/Hermes can drive Lionidas through the identical gates; turn events `butler.*` bridged onto the existing `crucibleBus` → `/api/events` (the D10 model).
4. **Memory + storage.** `butler_*` tables in the SAME sqlite file via Butler's sqlite driver (consumer owns the DB — checked against Lionidas's guarded-migration pattern); notes scoped by Lionidas keys (`app:<bundle>/screen:<id>`, `app:<bundle>/flow:<name>`); note injection into the agent's system prompt (the B.0 work) + the screens registry as Layer-0 ground truth.
5. **Sources.** `agent_sources` registry rows in Lionidas: Jira (creds from Lionidas env — the same JIRA_* vars the evidence-attach feature uses), GitHub, repo paths (the Lionidas repo itself can be a source: symbol chunks over `shared/src` give the agent the step grammar as code). Attachments ride the artifacts dir.
6. **The web surface (minimal, v1).** NO new chat UI: the conversation API is the surface (curl-able, MCP-able); Lionidas web gets at most a stub page later. Rationale: the operator's chat-panel direction stands, but UI was explicitly deferred (D4) and the fastest proof is API-level. (Flagged as a scope question below — confirm or override.)

### What integration does NOT include (v1)

- No web chat UI — the OPERATOR tests through Hermes (MCP client) per the 2026-10-01 decision; a Lionidas chat panel stays a future plan
- No agent-initiated run/triage autonomy (act tools refused; run-and-triage is the NEXT graduation, eval-gated)
- No embeddings in Lionidas retrieval (BM25 first; hybrid toggle exists if ever needed)
- No orchestration/fan-out in the product path (L2 shipped in Butler but no Lionidas use case yet)
- No changes to Butler's core (if a gap appears, it goes back to the Butler repo as a versioned fix, not a fork)

### The acceptance story (what "done" proves)

The F1-faithful live drill, in the Lionidas repo, with real creds: **register a Jira source → ingest a real ticket → agent session drafts a test case as YAML → `case.draft.save` validates against the real validator → the case appears in the real case list with `status='draft'` → a human promotes/plays it.** Plus: act-tool refusal proven through the Lionidas registry; MCP round-trip against the mounted endpoint; butler events visible on `/api/events`.

### Risks / open edges (for the plan to handle)

- **Butler's unmerged branch:** `feat/roadmap-a-tour` (stages A–H) must merge to butler main first — Lionidas should pin a merged commit, not a branch head. (Or pin the branch temporarily; ugly.)
- **Versioning:** pin by commit; a tagged `v0.2.0` in butler would be cleaner. Propose tagging after merge.
- **Auth seam:** conversation API must ride the existing `requireRole('operator')`-equivalent (session/PAT), not a new gate.
- **Prompt content:** the agent's system prompt is Lionidas domain knowledge (step grammar summary, narrate/AC conventions) — lives in the Lionidas consumer package, never in Butler.
- **Cost:** live drills spend real tokens; per-session budgets default conservative; the z.ai key lives in Lionidas env (never in code/DB).
- **Eval adaptation:** Butler's authoring-eval shape ports to "ticket fixture → case YAML passes the REAL validator" — the Lionidas-side eval gate for any future autonomy graduation.

## Open questions

1. ~~Web surface v1~~ — **answered 2026-10-01: no chat UI in this scope; HERMES is the test client.** The conversation API + MCP surfaces ship operator-gated; the operator exercises the agent through Hermes (MCP client) against the local server. A Lionidas chat panel remains a future plan (the deferred D4 direction).
2. ~~Butler pinning~~ — **answered 2026-10-01: merged; pin main.** Tag `v0.2.0` at integration time.
3. ~~Jira for the drill~~ — **answered 2026-10-01: not yet.** File/repo connectors live; Jira connector fixture-tested; real-creds drill deferred to an env-triggered open item.

## Next step

Answer Q1–Q3 (or accept all recommendations). Then `hms-plan-from-brainstorm` in the LIONIDAS repo produces the implementation plan against this scope — stages, tests, gates — and it goes through your review gate before any code.
