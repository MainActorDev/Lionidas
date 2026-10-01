# Step 4 — Transports: conversation API + MCP + events + auth

- **Status:** Ready
- **Plan:** rev 2, Stage 3; completion conditions 4, 5 (injection), 6
- **Review:** F2 carried — Hermes-MCP auth verification + stdio-wrapper fallback design
- **Depends on:** Steps 2–3 (registry with all tools, storage)

## Outcome and boundaries

`/api/agent/*` and `/mcp` mounted on the real app behind the existing operator gate; turn events bridged onto `crucibleBus`; note injection verified against persisted provider rows. Out of scope: Hermes registration + live drill (Step 6), sources seeding (Step 5).

## Implementation instructions

### 4a. `routes.ts` — the mount
```ts
import { registerConversationApi, mountMcp } from '@mainactordev/butler';
import { requireRole } from '../auth/roles.ts';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type Database from 'better-sqlite3';

export function registerAgentRoutes(app: FastifyInstance, db: Database.Database, deps: AgentDeps): void {
  // gate FIRST — operator tier (session + PAT both resolve through
  // registerUserResolution; bots pass operator routes by existing policy)
  app.addHook('onRequest', ... ) // NO — see note
```
**Auth wiring note (grounded):** `requireRole('operator')` is a per-route `preHandler`, not a prefix hook. Butler's `registerConversationApi` registers its own three routes (+ B.0 list/abort routes) without preHandlers. Two workable options — **choice A (adopted, minimal):** wrap each butler-registered path with a fastify plugin that adds `{ preHandler: requireRole('operator') }` via `app.addHook('preHandler', …)` scoped inside a `app.register(async (scope) => { scope.addHook('preHandler', requireRole('operator')); await registerConversationApi(scope, …); })` — scoped hooks apply only to routes in that scope. Same for `/mcp` POST. Mark: if the SDK transport mishandles 401 JSON, return 401 with the same body the rest of the API uses (consistency test).
- Provider construction: `BUTLER_PROVIDER_BASE_URL` + `BUTLER_API_KEY` + `BUTLER_MODEL` env → `OpenAICompatProvider`; env absent → `MockProvider` with a labeled script AND a `/api/agent/health`-style flag `{ configured: false }` on session create (honest degradation, plan edge list).
- System prompt from `system-prompt.ts` (Step 5 fills content; here: exported constant placeholder so routes compile).
- `emit` bridge: `(e) => bus.emit('agent.turn', { sessionId: e.sessionId, type: e.type, hop: e.hop, detail: e.detail })` — add ONE typed event to `AppEvents` (`server/src/ws/bus.ts`): `'agent.turn': { sessionId: string; type: string; hop?: number; detail?: unknown }` (matches how run.* events are shaped).

### 4b. index.ts wiring (one call, after existing route registrations)
```ts
import { registerAgentRoutes } from './agent/routes.ts';
// …inside buildApp, after registerManualRoutes etc.:
registerAgentRoutes(app, db.raw, { storage, retriever, registry, bus, artifactsDir });
```
`storage`/`retriever`/`registry` built once via a small `server/src/agent/context.ts` (constructed from env in buildApp — same lifecycle as other deps).

### 4c. MCP mount
`mountMcp(app, { registry, policy: V1_POLICY, serverInfo: { name: 'lionidas-agent', version } })` inside the SAME operator-gated scope (F2 note: the gate applies; Step 6 verifies Hermes can authenticate, fallback is `mcp-stdio.ts` — build it only if Step 6's verification fails).

### 4d. Tests (`server/test/agent-routes.test.ts`)
- anonymous POST `/api/agent/sessions` → 401 `sign in required` (exact body — consistency with the rest).
- with operator session cookie (harness `seedOperator`) → 201; message turn with MockProvider → turn.ok, messages persisted in `butler_messages`; abort route on active turn → clean outcome (mock hang).
- `/mcp` POST initialize + tools/list (operator auth) → tool names exclude `case.play`/`device.power`; tools/call `cases.list` returns seeded rows.
- WS: connect `/api/events` (existing pattern), run a turn, assert an `agent.turn` frame arrives with the session id.
- note injection: save note via `note.save` in session A; start session B; capture provider messages (MockProvider echo or persisted rows) → note content present in the system prompt block.
- mock-only hermetic: the suite force-strips `BUTLER_PROVIDER_*` (the butler stage-4 guard pattern).

## Verification

```bash
cd server && pnpm vitest run test/agent-routes.test.ts
pnpm typecheck && pnpm vitest run   # full suite + web build + cli suite (repo gate)
```
Negative: PAT with viewer role → 403 `requires role: operator`.

## Completion gate

- [ ] 401/403 anonymous+viewer; 200 operator — exact bodies
- [ ] MCP round-trip gated identically; act tools invisible in tools/list
- [ ] `agent.turn` events on `/api/events` (WS test green)
- [ ] note injection asserted on persisted rows
- [ ] full repo gates green (server + web + cli)
