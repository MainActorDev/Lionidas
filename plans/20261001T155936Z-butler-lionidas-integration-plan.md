# Butler → Lionidas integration — implementation plan

- Source brainstorm: `brainstorm/20261001T155936Z-butler-lionidas-integration-scope.md` (all scope questions answered 2026-10-01)
- Status: **Ready** (rev 2, 2026-10-01 — review F1–F5 applied; feasibility probe executed: butler installed via file: link, imported under Lionidas tsx, exercised in Lionidas vitest — see `reviews/20261001T155936Z-butler-lionidas-integration-plan-review.md`)
- Plan date: 2026-10-01
- Repo: Lionidas (this plan's work lands here; Butler is consumed, not modified)

## Decision log

| # | Decision | Source |
|---|---|---|
| I1 | Integrate Butler into Lionidas NOW (direction reversed from demo-first) | operator 2026-10-01: "I changed my mind. Let's integrate it into Lionidas" |
| I2 | Butler pinned at main (merged PR #1 `4c6ebb2`); tag `v0.2.0` at integration | operator 2026-10-01: "It's merged."; scope Q2 |
| I3 | Jira creds NOT yet — file/repo connectors live; Jira connector fixture-tested only; real-Jira drill = env-triggered open item | operator 2026-10-01: "Not yet." |
| I4 | **No chat UI in v1 — HERMES is the test client.** The operator exercises the integrated agent through Hermes's MCP client against the local Lionidas server; MCP registration of Lionidas into Hermes config is part of acceptance. A Lionidas chat panel remains a future plan | operator 2026-10-01: "Let's use hermes for now for the test" |
| I5 | v1 autonomy = read + draft (D2 discipline): act tools registered but policy-REFUSED; `case.draft.save` writes a REAL `status='draft'` template through the existing seam (no shadow store — Butler-plan review F1, carried) | Butler plan rev 2/3 decision log |
| I6 | Memory/storage: butler sqlite driver on the Lionidas DB file; notes scoped `app:<bundle>/…`; screens registry = Layer-0 ground truth | scope §surfaces 4 |
| I7 | Auth: agent routes ride the existing operator gating (session/PAT hook), no new gate | scope risk list; verified `requireRole` pattern (manual.ts:6,742) |

## Objective

Lionidas gains an agent layer: **sessions over the conversation API and MCP that read Lionidas state + ingested sources and draft VALIDATING test cases** (real yaml validator as ground truth, saved as real `draft` templates), with act-class execution refused under v1 policy — and the operator tests the whole thing by chatting through Hermes.

## Completion conditions (measurable)

1. `@mainactordev/butler` installs from the private git pin; `pnpm check` green in Lionidas with the new code; Butler's own repo untouched by this plan.
2. Lionidas tool registry (`server/src/agent/tools.ts`): read tools return REAL data (cases list, rendered case yaml, run history/steps with reasons, screens registry, folder tree, source search via BM25) — proven by contract tests against the real server harness (buildApp pattern).
3. `case.draft.save` (draft-class): validates via the EXISTING `POST /api/templates/yaml/validate` path logic, then creates a REAL template `status='draft'` (existing seam); a contract test creates a session → drafts → the row exists with `status='draft'` and renders in `GET /api/templates`. Act tools (`case.play`, `device.power`, `run.abort`) registered and REFUSED with typed named errors under the v1 policy — proven by test.
4. Conversation API mounted at `/api/agent/*`, operator-gated via the existing auth hook: anonymous → 401; PAT/session → 200 (contract tests + live curl with the drill PAT). MCP endpoint mounted at `/mcp` on the same app: `tools/list` policy-filtered; `tools/call` round-trips ≥3 tools.
5. `butler_*` tables created (guarded, idempotent) in the Lionidas sqlite; note provenance + supersession invariants hold; note injection into the agent system prompt works (note saved in session 1 → visible in session 2's provider messages — assert on persisted rows).
6. Turn events bridge to the existing bus: agent turn events appear on `/api/events` as `agent.*`-shaped events (typed additions to AppEvents) — proven by a WS test.
7. Source ingestion live for file + repo connectors: fixture tickets ingest → documents + chunks → `sources.search` retrieves them; the Jira connector is wired with recorded-response fixture tests only (I3).
8. **The Hermes drill (the operator's test path):** with the Lionidas server running and Hermes configured with the Lionidas MCP server, the OPERATOR asks Hermes to "draft a test case from ticket DEMO-101 (fixture)" — the agent searches sources, drafts yaml, the validator passes, and a draft case appears in the Lionidas case list. Logged in `docs/drills.md`-equivalent (Lionidas convention: `docs/agent-drills.md`).
9. Live provider (z.ai key in Lionidas env) for the manual drill; hermetic CI uses the mock provider (Butler's env-gating, proven pattern). No keys in code or DB.

## Out of scope (v1)

- Any Lionidas web UI (chat panel = future plan; I4)
- Agent-initiated execution (play/abort/device = refused act-class; graduation is a future eval-gated plan)
- Real Jira ingestion (connector ships fixture-tested; creds later — I3)
- Embeddings/hybrid in the product path (BM25); orchestration fan-out; Butler core changes (gap → Butler repo PR, pinned forward)
- Multi-tenant agent authz beyond the existing operator gate

## Architecture

```
server/src/agent/                  the Lionidas consumer layer (all new code lives here)
  tools.ts        ToolRegistry build: read (cases.list, case.yaml.get, runs.history,
                  run.steps, screens.registry, folders.tree, sources.search, notes.read)
                  + draft (case.draft.save [validator→real draft template],
                  case.draft.edit, note.save, sources.ingest)
                  + act-registered-refused (case.play, run.abort, device.power)
  policy.ts       v1 policy = DRAFT constant + builder (ACT for future graduation)
  system-prompt.ts  Lionidas domain prompt: step-grammar summary, narrate/AC
                  conventions, "never claim validity — the validator tool decides"
  sources.ts      file + repo connectors over Lionidas-owned paths; Jira connector
                  factory (env-gated; fixture tests until creds exist)
  routes.ts       mounts butler's registerConversationApi at /api/agent/* behind the
                  existing operator hook; mountMcp at /mcp; turn-event bridge →
                  crucibleBus as typed agent.* events
  storage.ts      SqliteStorage over the Lionidas DB path (butler_* tables; guarded)
```

**Key seams (verified 2026-10-01):**
- Ground truth = the yaml validator logic at `templates.ts:817` (`parseCaseYaml` + `resolveCaseRefs`) — invoked server-side (no HTTP self-call).
- Draft seam = template creation with `status='draft'` (templates POST + yaml PUT path, `schema.ts:148` CHECK).
- Auth = `requireRole('operator')` equivalent for the agent routes (session/PAT both flow through `registerUserResolution`).
- Events = `crucibleBus` typed events (`server/src/ws/bus.ts` AppEvents) — add `agent.turn.*` shapes.
- Storage = the same sqlite file `server/src/db/client.ts` opens; Butler's driver runs its guarded migrations on it.

## Implementation stages

### Stage 0 — Dependency + skeleton
- Tag butler `v0.2.0` at `4c6ebb2`; `pnpm add @mainactordev/butler@github:MainActorDev/butler#v0.2.0` in server; allowBuilds already covers better-sqlite3.
- `server/src/agent/` skeleton (empty modules), imports resolve, `pnpm check` green.
- **Deliverable:** dependency wired, zero behavior change.

### Stage 1 — Storage + registry + policy (TDD)
- `storage.ts`: SqliteStorage on the Lionidas DB (env override for tests); migrations idempotent on a copied real DB (guard test).
- `tools.ts` READ tools first, each backed by existing server code paths (SQL + renderTemplateYaml for `case.yaml.get`); `policy.ts` with DRAFT.
- Contract tests via buildApp: each read tool returns real rows from seeded fixtures.
- **Deliverable:** condition 2 (read half).

### Stage 2 — Draft + act-refused tools (TDD)
- `case.draft.save`: validate (the real validator, in-process) → create template `status='draft'` (the real seam) → return `{templateId, status:'draft'}`; invalid yaml → validator errors verbatim as the tool result (one repair round is the loop's behavior, proven in Butler).
- `case.draft.edit` (validating yaml PUT on existing case — folder/app-scope and name-collision 409s surface VERBATIM, review F4), `note.save` (provenance mandatory), `sources.ingest` (file/repo).
- ACT tools registered; refusal test: `case.play` under DRAFT → typed `PolicyRefusal` naming tool+policy.
- **Deliverable:** conditions 2 (draft half) + 3.

### Stage 3 — Transports + events + auth
- `routes.ts`: conversation API behind the operator hook (401 anonymous / 200 PAT — tests with the PR-#13 harness pattern); MCP at `/mcp` (tools/list filtered, tools/call round-trip); turn events → `agent.turn.*` on the bus → `/api/events` WS test.
- **Hermes-MCP auth verification (review F2):** check whether Hermes's HTTP MCP client sends an Authorization header against the gated `/mcp`; if not, build the designed fallback — `server/src/agent/mcp-stdio.ts`, a localhost stdio wrapper mounting the SAME registry that injects the PAT from env (pattern: butler's bin + the operator's existing atlassian wrapper). Whichever path authenticates becomes the drill path.
- Note injection rides Butler's B.0 behavior (assert via persisted provider messages).
- **Deliverable:** conditions 4, 5, 6.

### Stage 4 — Sources live + system prompt
- `sources.ts`: fixture tickets + repo connector (Lionidas's own `shared/src` as a seeded repo source with symbol chunks — the step grammar as code); `sources.search` over BM25; Jira connector fixture tests (recorded responses; live path env-gated).
- `system-prompt.ts`: the Lionidas domain prompt (grammar summary from `shared/src/case-yaml.ts` reality, narrate/AC convention, validator-first rule).
- **Deliverable:** condition 7 + the prompt that makes drills behave.

### Stage 5 — Live drill + Hermes registration (the operator's test)
- Boot the real server with the z.ai env; seed a fixture ticket source.
- Register the Lionidas MCP server in Hermes config — PRIMARY: the mounted HTTP endpoint (`url: http://127.0.0.1:<port>/mcp` shape); FALLBACK (if the HTTP client can't authenticate): the Stage-3 stdio wrapper. Review F1: butler's own stdio bin serves the DEMO registry and is NOT this integration's path.
- THE DRILL (with or for the operator): ask Hermes to draft a test case from the fixture ticket → agent searches, drafts, validator passes, draft case lands in the real list → operator inspects. Log to `docs/agent-drills.md`.
- Authoring eval port: fixture ticket → drafted yaml passes the real validator (Lionidas-side eval file, mock-provider for CI; the gate any future autonomy graduation must pass).
- **Deliverable:** conditions 8, 9; drills logged; eval in CI.

## Edge & failure cases

- Butler pin install fails (private repo) → ssh-agent/deploy-key note in README-agent; CI note that tests requiring the package are skipped honestly if unset (prefer: vendored checkout in CI).
- Draft yaml invalid after one repair → validator errors surfaced to the session verbatim (tool result), session continues; no half-written template (create happens only post-validation).
- Validator passes but create collides on name → UNIQUE error surfaces as the tool result (the existing 409 semantics).
- Anonymous hits `/api/agent/*` → 401 via the existing hook; PAT without operator role → 403.
- Note without source_ref → rejected (Butler invariant; no Lionidas bypass).
- Provider env absent → `AGENT_NOT_CONFIGURED`-style honest degradation (mock for tests; drills labeled).
- Bus event shape drift → typed AppEvents additions, compile-time catch.
- Hermes MCP registration failure → drill blocked; document the config shape + verify with `tools/list` before the drill (Stage 5 does this first).
- **better-sqlite3 major split (review F3, disclosed):** Lionidas pins 11.10.0, Butler 12.x — pnpm nests butler's copy today (probe passed with both coexisting); Stage 1's migration-guard test is the canary if a future upgrade misbinds the native module.
- **CI without private-repo credentials (review F5):** tests requiring `@mainactordev/butler` skip HONESTLY (counted skips, not failures) when the package is absent; vendored checkout remains the CI option.

## Validation & acceptance checks

Per-stage `pnpm check` (server suite + typecheck); contract tests against buildApp for every tool and route; the refusal test; the WS event test; migration guard on a DB copy; the live drill logged; the eval file in CI (mock provider, hermetic). Final gate: full server suite + web build + CLI suite green (no regressions), Butler repo untouched (`git -C ../butler status` clean).

## Rollout

Branch `feat/butler-integration` off Lionidas `main`; operator merges (create-only PR per convention). Butler tagging (`v0.2.0`) is the only Butler-repo action — done first, before the branch. Env additions documented (`BUTLER_PROVIDER_BASE_URL/BUTLER_API_KEY/BUTLER_MODEL`, later `JIRA_*`); nothing else changes for existing Lionidas users until the routes land behind the operator gate.
