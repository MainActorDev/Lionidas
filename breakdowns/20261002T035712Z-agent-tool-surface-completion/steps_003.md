# Step 3 — Tier 3: screens registry write + recipe reads (the unlocked gates)

- **Status:** Ready
- **Plan:** rev 2, Stage S3, condition 3; review F3 (revision arithmetic + verbatim stale text)
- **Repo:** Step 2 head · **Depends on:** Step 2

## Outcome

`screens.draft.save` (Option A — operator-approved) and `recipes.get`.

## Implementation

### screens.draft.save — mirror `PUT /api/apps/:bundle/screens` (app-screens.ts:84-101)

```ts
// parameters: { appBundle: string, revision: number, screens: AppScreen[] }
// 1. revision REQUIRED: missing → 'INVALID: revision is required (echo the current registry revision — fetch with screens.registry)'
// 2. validateRegistry(screens) from '@crucible/shared/app-screens' → errors → 'INVALID: ' + each (route 422 shape)
// 3. FULL-LIST RULE (operator Option A): current ids = SELECT screen_id FROM app_screens WHERE app_bundle_id=?
//    missing = current − submitted → if any: 'INVALID: refused — this write would DROP screens: <ids>. Submit the FULL list (fetch with screens.registry, edit, resubmit).'
// 4. Stale check (F3): cur = COALESCE(MAX(revision),1); body revision !== cur →
//    'INVALID: registry changed while you were editing (REGISTRY_STALE) — current revision is ' + cur + '; fetch screens.registry and resubmit'
// 5. Replace (replaceRegistry mirror): tx { DELETE all rows for bundle; INSERT each with revision = cur+1, updated_at }
//    (login recipes are app-level — never touched; verified comment in replaceRegistry)
// 6. return { appBundle, revision: cur+1, count }
```

New-bundle arithmetic (F3): cur reads 1 (COALESCE), first write lands 2 — same as the route.

### recipes.get — mirror `GET /api/apps/:bundle/login|logout` (app-screens.ts:242+,275+)

`{ appBundle, kind: 'login' | 'logout' | 'both' (default both) }` → parsed login_json/logout_json + revision + updated_at per kind present; absent recipe → honest `none registered` field (route returns what? verify at write time — mirror exactly).

## Verification (TDD)

- Happy: register 2 screens on a fresh bundle → revision 2, rows correct, GET via screens.registry shows them
- Omission refusal: existing bundle with 2 screens, submit 1 → refusal naming the dropped id; rows unchanged
- Stale: submit revision 1 when cur=2 → verbatim REGISTRY_STALE + current revision; then echo-retry succeeds
- Validation: bad screen key → the validator's 422 error text
- recipes: seeded app_login row → parsed recipe returned; bundle without → honest none

```bash
cd server && pnpm vitest run test/agent-config-tools.test.ts && npx tsc --noEmit -p tsconfig.json
```

## Completion gate

- [ ] screens write cannot silently drop screens (omission test); stale-retry loop proven; recipes read green
- [ ] full suite green; commit pushed
