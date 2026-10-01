# Step 1 — Branch + Butler tag + git-pin dependency + agent skeleton

- **Status:** Ready
- **Plan:** `plans/20261001T155936Z-butler-lionidas-integration-plan.md` rev 2 (Ready)
- **Review:** `reviews/20261001T155936Z-butler-lionidas-integration-plan-review.md` (Ready for implementation; this step carries F5's honest-skip groundwork)
- **Repo revision:** Lionidas `a7477f8` (main); Butler main `4c6ebb2` (clean, probe-verified importable)
- **Addresses:** plan Stage 0; completion condition 1

## Outcome and boundaries

Butler is installable from a tagged private-git pin; `server/src/agent/` exists with empty modules that typecheck; the full suite stays green; zero runtime behavior change. Out of scope: any tool, route, or migration logic (Steps 2+).

## Implementation instructions

1. **Tag Butler** (in `../butler`, main, clean — verified):
   ```bash
   cd ../butler && git tag v0.2.0 4c6ebb2 && git push origin v0.2.0
   ```
2. **Branch** (Lionidas): `git checkout -b feat/butler-integration` off `main`.
3. **Pin the dependency** in `server/`:
   ```bash
   cd server && pnpm add @mainactordev/butler@github:MainActorDev/butler#v0.2.0
   ```
   Confirm `node -e "console.log(require('@mainactordev/butler/package.json').version)"` resolves 0.1.0 (package version is independent of the tag name; record both).
   `allowBuilds` already covers `better-sqlite3` (workspace policy, verified).
4. **Skeleton modules** (empty exports, real seams documented):
   ```
   server/src/agent/tools.ts        // export function buildToolRegistry(...) { throw new Error('step 2') }
   server/src/agent/policy.ts       // export const V1_POLICY = ... (import DRAFT from butler) — can land now, it's one line
   server/src/agent/system-prompt.ts// export function buildSystemPrompt(): string
   server/src/agent/sources.ts      // export function buildSources(...)
   server/src/agent/routes.ts       // export function registerAgentRoutes(app, db, deps)
   server/src/agent/storage.ts      // export function agentStorage(dbPath): SqliteStorage
   ```
   Import style: `import { DRAFT, ToolRegistry, SqliteStorage } from '@mainactordev/butler';` (barrel — all 16 integration symbols verified present by the review probe).
5. **No index.ts wiring yet** — routes mount in Step 4. Skeleton files only typecheck.

## Verification

```bash
cd server && pnpm typecheck && pnpm vitest run   # full suite green, zero regressions
node -e "import('@mainactordev/butler').then(m => console.log(typeof m.ToolRegistry))"
# expect: function  (run under tsx: npx tsx -e "…")
git -C ../../butler status --short | grep -v '^??' | wc -l   # expect 0 (butler untouched after tag)
```

## Completion gate

- [ ] tag `v0.2.0` pushed on butler `4c6ebb2`
- [ ] `feat/butler-integration` branch exists
- [ ] server/package.json pins `@mainactordev/butler` at the tag; lockfile committed
- [ ] `pnpm typecheck` + full vitest green
- [ ] six skeleton files exist and compile; nothing mounted
