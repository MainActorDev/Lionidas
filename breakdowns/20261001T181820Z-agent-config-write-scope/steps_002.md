# Step 2 — Suite write tools (transaction-catch mirrored)

- **Status:** Ready
- **Plan:** rev 2, Stage S2, condition 2; review F4 (tx-catch mirroring)
- **Repo:** `feat/butler-integration` @ Step 1 head
- **Depends on:** Step 1 (config-tools.ts exists, test harness seeded)

## Outcome

`suite.draft.save` and `suite.draft.edit` create/update real suite rows in-process. Out of scope: deletes, activation, scenarios/presets (Step 3).

## Implementation (in `config-tools.ts`)

### suite.draft.save — mirrors `routes/suites.ts:125-161` EXACTLY

```ts
// 1. name required: !name?.trim() → 'INVALID: name required'
// 2. bundle resolution BEFORE validation (route order — the 400 must not lie):
//    explicit appBundleId (non-empty string) OR first member's template's
//    app_bundle_id (SELECT app_bundle_id FROM templates WHERE id = first).
// 3. member validation (mirror validateMembers, suites.ts:103-124):
//    - Array, ≤64; each { templateId: string } required
//    - template must exist; variantIds must ⊆ that template's variants_json ids
//    - every member's app_bundle_id === suite bundle, else the route's 400:
//      `member ${i}: template ${tid} belongs to ${t.appBundleId}, suite is ${bundle}`
//      (use the route's exact wording — read it at write time, don't trust memory)
// 4. INSERT + members in ONE db.transaction; try/catch → 'INVALID: suite name already exists'
//    (F4: mirror the tx-catch; NO name pre-check — the UNIQUE constraint is the gate)
// 5. return { suiteId, name, memberCount }
```

### suite.draft.edit — mirrors PATCH (`suites.ts:163-191`)

- `appBundleId` change → verbatim `appBundleId is immutable — create a new suite to change app scope`.
- members REPLACE wholesale inside the transaction (position = array order); name/description partial.
- Same tx-catch → verbatim `suite name already exists`.

### Registration

`permission: 'draft'`; parameters: `{ name, description?, members: [{templateId, variantIds?}], appBundleId? }`, edit takes `idOrName`.

## Verification (TDD — add to `agent-config-tools.test.ts`)

- Happy: 2-member suite saved; row + suite_members correct, positions 0,1.
- Mixed-bundle member → the verbatim 400 text (assert against the literal string from the route).
- Variant pin not in the case's vocabulary → verbatim error; **members count unchanged** (F4's no-partial-write check).
- Duplicate name → `INVALID: suite name already exists`; first suite's members untouched.
- Edit: rename ok; appBundleId change refused verbatim; member replace drops stale rows.

```bash
cd server && pnpm vitest run test/agent-config-tools.test.ts && npx tsc --noEmit -p tsconfig.json
```

## Completion gate

- [ ] save/edit land real rows; verbatim error strings asserted literally
- [ ] no partial writes on any failure path (counts asserted)
- [ ] full suite green; commit pushed
