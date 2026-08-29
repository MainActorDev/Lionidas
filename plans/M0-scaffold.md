# M0 — Scaffold (Crucible Phase 0)

**Status: READY — no build until approved.** · Parent: [../PLAN.md](../PLAN.md)
Duration: ½ day · Gate at bottom is the only definition of done.

## 0. Scope

Monorepo skeleton, tooling, CI, empty-but-serving UI + API. **No Alloy integration,
no DB migrations beyond `schema_meta`, no domain logic.**

Non-goals: auth, streaming, Forge, any feature screen beyond a placeholder wall.

## 1. Repository layout (exact)

```
ai/crucible/
  package.json               # pnpm workspaces: ["server","web"]
  pnpm-workspace.yaml
  tsconfig.base.json         # strict, NodeNext, exactOptionalPropertyTypes
  .oxlintrc.json             # correctness=error (same as Alloy)
  .gitignore                 # node_modules, dist, *.db, artifacts/, .env
  scripts/scan-signatures.mjs  # port of Alloy's scanner (self-exempt)
  server/
    package.json  tsconfig.json  drizzle.config.ts
    src/index.ts              # buildApp(): Fastify instance (exported for tests)
    src/config.ts             # PORT=8787, DB_PATH, ARTIFACTS_DIR, ALLOY_CONFIG_PATH
    src/db/client.ts          # better-sqlite3 + drizzle, WAL pragma
    src/db/schema.ts          # schemaMeta only (M1 adds tables)
    src/routes/health.ts      # GET /api/health -> {ok, version, uptimeMs}
    src/ws/bus.ts             # TypedEventBus<E> (pub/sub, M1 fills taxonomy)
    test/health.test.ts
  web/
    package.json  tsconfig.json  vite.config.ts   # proxy /api -> :8787
    index.html  src/main.ts  src/App.vue
    src/stores/session.ts     # pinia: WS connection state
    src/pages/WallPage.vue    # placeholder tile grid, "no devices (M1)"
    src/router.ts             # / -> WallPage
  .github/workflows/check.yml # typecheck → lint → scan → unit (macos-latest)
```

## 2. Interfaces fixed in M0 (do not drift later)

```ts
// server/src/ws/bus.ts
export interface TypedEventBus<E extends Record<string, unknown>> {
  emit<K extends keyof E & string>(type: K, payload: E[K]): void;
  on<K extends keyof E & string>(type: K, fn: (p: E[K]) => void): () => void;
}
// server/src/index.ts
export function buildApp(cfg: Config): Promise<{ app: FastifyInstance; bus: TypedEventBus<AppEvents> }>;
```

`AppEvents` starts as `{ 'app.ready': { version: string } }` — M1 extends the
interface; the bus implementation never changes.

## 3. Tasks (ordered)

1. Root scaffold: workspace files, base tsconfig, oxlint, scanner port (verify
   self-exemption test), CI workflow.
2. Server: `buildApp()` factory (NOT a top-level side-effect server — tests need
   the instance), health route, db client with WAL, schema_meta migration via
   drizzle-kit (`pnpm --filter server db:migrate`).
3. Web: Vite + Vue3 + Pinia + router; WallPage placeholder; `/api` proxy.
4. `pnpm dev` orchestration: `concurrently` server (tsx watch) + web (vite).
5. Unit tests: bus emit/on/unsubscribe; health route via `app.inject()`.

## 4. Tests (named, all must exist and pass)

| File | Asserts |
|---|---|
| `server/test/health.test.ts` | inject → 200 `{ok:true,version}` |
| `server/test/bus.test.ts` | emit reaches subscriber; unsubscribe stops delivery; no listener = no throw |
| `scripts/scan-signatures.test.mjs` | seeded temp file with a banned string → exit 1; clean tree → exit 0 |

## 5. Invariants

- Server entry is a factory; nothing listens in module scope.
- Web never imports server code; server never imports web code (lint boundary —
  oxlint `no-restricted-imports` per package).
- Engine signature scan runs on the whole repo; CI order fixed.

## 6. GATE (all must pass, executed, not assumed)

```bash
pnpm install && pnpm check          # typecheck+lint+scan+unit green
pnpm dev &                          # both processes up
curl -s localhost:8787/api/health   # {"ok":true,...}
open http://localhost:5173          # WallPage renders, no console errors
```

Commit: `chore: crucible scaffold (M0)` — single commit, pushed after user review.


## Build notes (recorded during execution)

- drizzle-kit deferred to M1 (first real migration set); M0's single
  `schema_meta` table uses an idempotent `CREATE TABLE IF NOT EXISTS` at db
  open — zero-config, same end state, M1 supersedes with drizzle-kit.
- pino logging on from M0 (§17 quality bar), `SILENT` in tests.
