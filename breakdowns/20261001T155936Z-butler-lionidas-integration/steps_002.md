# Step 2 — Agent storage on the Lionidas DB + read tools + policy (TDD)

- **Status:** Ready
- **Plan:** rev 2, Stage 1; completion conditions 2 (read half), 5 (storage/invariants)
- **Review:** F3 canary lives here (migration guard = the sqlite-split detector)
- **Depends on:** Step 1 (dependency + skeleton)
- **Repo grounding (verified):** `openDb(path)` at `server/src/db/client.ts:9` (WAL); route modules receive `(app, db: Database.Database, deps)` (manual.ts:28-31); `renderTemplateYaml` is MODULE-PRIVATE at `templates.ts:162` — do not import it; re-render via `parseCaseYaml`+steps or call the GET route's logic. `parseCaseYaml` comes from `@crucible/shared/case-yaml` (templates.ts:11).

## Outcome and boundaries

Butler's sqlite driver manages `butler_*` tables on the SAME DB file; every read tool returns real Lionidas data; V1 draft policy exported; the act-class refusal contract is testable. Out of scope: draft tools (Step 3), transports (Step 4).

## Implementation instructions

### 2a. `storage.ts`
```ts
import { SqliteStorage } from '@mainactordev/butler';
import { openDb } from '../db/client.ts';

/** butler_* tables live in the Lionidas sqlite (consumer owns the DB).
 *  The migrations are guarded/idempotent (butler Stage-2 semantics). */
export function agentStorage(dbPath: string): SqliteStorage {
  // NOTE: SqliteStorage opens its OWN better-sqlite3 handle (v12) against the
  // same file — WAL allows multi-handle; the F3 canary test below proves the
  // binding works on every run.
  return new SqliteStorage(dbPath);
}
```
DB path resolution: reuse the server's env (`CRUCIBLE_DB_PATH`) — read it the same way `server/src/index.ts` does via `loadConfig`; pass through, don't re-derive.

### 2b. `policy.ts`
```ts
import { DRAFT } from '@mainactordev/butler';
/** v1 autonomy: read + draft. Act tools register but are REFUSED (I5). */
export const V1_POLICY = DRAFT;
```

### 2c. `tools.ts` — read tools (each backed by existing server code, no HTTP self-calls)
Registry shape: `new ToolRegistry().register({ name, description, parameters, permission: 'read', execute })`. Tools (JSON-schema `parameters` objects, concise `description` strings — they are model-facing):

- `cases.list` — `db.prepare('SELECT id,name,status,folder_id,app_bundle_id FROM templates ORDER BY updated_at DESC LIMIT 50')`; return JSON rows (include `status` so drafts are visible).
- `case.yaml.get` — input `{ idOrName: string }`; resolve like the GET route does (exact id, else unique name); render: rows→steps via `JSON.parse(steps_json)` + a minimal emitter OR call the same helpers the yaml GET route uses **in-process** (the route builds on `renderTemplateYaml(db,row)` which is not exported — **design choice**: export it from templates.ts (one-line `export`) rather than duplicating the emitter; that is a Lionidas-side change, allowed by this plan). Return the yaml string.
- `runs.history` — input `{ status?: 'failed'|'passed'|'aborted', limit?: number }`; `SELECT id,status,template_id,started_at FROM runs WHERE …ORDER BY started_at DESC LIMIT ?` (mirror runs.ts filters minimally).
- `run.steps` — input `{ runId: string }`; `SELECT idx,name,status,reason,narrate FROM run_steps WHERE run_id=? ORDER BY idx` (reasons are the triage knowledge).
- `screens.registry` — input `{ appBundle?: string }`; read `app_screens` rows (same query shape as app-screens.ts `screensFor`); return the screens + states JSON — the machine rulebook.
- `folders.tree` — `SELECT f.id,f.name,f.parent_id, (SELECT COUNT(*) FROM templates t WHERE t.folder_id=f.id) n FROM folders f`; nested client-side.
- `sources.search` — input `{ query: string, topK?: number }`; `StorageRetriever.retrieve` over registered chunks (seeding happens Step 5; empty corpus returns "no documents ingested yet").
- `notes.read` — `storage.activeNotes(prefix?)`.

`buildToolRegistry(deps: { db: Database.Database; storage: SqliteStorage; retriever: StorageRetriever })` returns the registry. Handlers take `(args, ctx)`; return strings (JSON.stringify rows) — Butler loop contract.

### 2d. Tests (`server/test/agent-tools.test.ts`, buildApp harness like the CLI suite)
- storage: `butler_*` tables created on a tmp DB; second `agentStorage()` on same file = idempotent (**F3 canary**); note insert without `source_ref` rejects; supersession audit row persists.
- each read tool: seed real rows → execute → assert real data (e.g. `screens.registry` returns the seeded screen; `runs.history` filters by status).
- `case.yaml.get`: seed a template with steps → returned string contains `steps:`.
- act-refusal precondition: register a dummy act tool → `registry.execute(name,…,V1_POLICY)` throws `PolicyRefusal` naming tool+policy (full set lands Step 3).

## Verification

```bash
cd server && pnpm vitest run test/agent-tools.test.ts   # all green
pnpm typecheck
```
Negative checks: provenance rejection test fails if butler's invariant is bypassed; idempotent-migration test is the F3 canary — if it reds, STOP and reconcile the better-sqlite3 split before continuing.

## Completion gate

- [ ] `renderTemplateYaml` exported (one-word diff) and used by `case.yaml.get`
- [ ] 8 read tools registered, each returning real data in tests
- [ ] V1_POLICY exported; refusal contract proven
- [ ] F3 canary green (double `agentStorage()` on one file)
- [ ] full server suite green
