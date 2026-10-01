# Step 4 — Case lifecycle: edit guard, revise-from-copy, deprecate

- **Status:** Ready
- **Plan:** rev 2, Stage S4, conditions 5, 6; review F5 (revise name-flow)
- **Repo:** Step 3 head
- **Depends on:** Step 3 (config-tools.ts; revise edits the copy via draft-tools' machinery)

## Outcome

`case.draft.edit` refuses non-draft targets; new `case.draft.revise` (active/deprecated → validated draft copy with the user's edits); new `case.deprecate`. Activation remains impossible for the agent. Out of scope: activate tool (never), route changes.

## Implementation

### edit guard — `draft-tools.ts`, `case.draft.edit` (one line at the top of the target lookup)

```ts
// after row lookup, before any parsing:
if (row.status !== 'draft')
  return `INVALID: case "${key}" is ${row.status} — use case.draft.revise to edit it as a new draft (activation stays human)`;
```

(`row` select must now include `status` — extend the SELECT if the existing one doesn't return it.)

### case.draft.revise — in `config-tools.ts` (F5 name flow)

```ts
// 1. lookup by idOrName → 404-ish verbatim 'error: no case "X"'
// 2. if row.status === 'draft' → 'INVALID: already a draft — use case.draft.edit'
// 3. COPY (duplicate-route semantics, templates.ts:395-420): fresh tpl_ id,
//    collision-loop name `${row.name} (copy)`/`(copy 2)`…, FULL field copy
//    (steps/setup/alerts/variants/tags/entry/app/udid/logical/folder…),
//    status='draft', created_by='agent', one transaction.
// 4. EDIT the copy with the user's yaml through the SAME chain as
//    case.draft.edit: parseCaseYaml (app recipe hooks, fallback app =
//    copied row's app_bundle_id) → resolveCaseRefs → rename-collision check
//    → UPDATE (reuse case.draft.edit's execute body by calling the registry:
//    execute('case.draft.edit', { idOrName: newId, yaml }, ctx, DRAFT) —
//    the guard from this step now PASSES because the copy is a draft).
// 5. F5 pin: if the yaml omits `name`, the copy keeps its "(copy)" name —
//    returned object says which name landed: { templateId, name, status:'draft' }.
// 6. failure AFTER the copy landed (yaml invalid): the copy SURVIVES as a
//    plain duplicate — return INVALID + the copy's id so nothing is lost:
//    `INVALID: … (a plain draft copy was saved as ${newId} — edit it and retry)`
```

Step-4 design choice (author, flagged): reuse-via-registry-execute rather than extracting a shared function — one definition of edit semantics, zero duplication; costs one registry round-trip (in-process, negligible).

### case.deprecate

```ts
// lookup; if already deprecated → { ok: true, note: 'already deprecated' } (idempotent, route PATCH allows same-status);
// if draft → 'INVALID: drafts aren't deprecated — they're simply never activated (delete is human)';
// else UPDATE templates SET status='deprecated', updated_at=? WHERE id=?
// return { templateId, status: 'deprecated' }
// NEVER accepts a status argument — the tool signature has none.
```

## Verification (TDD — extend `agent-draft-tools.test.ts`)

- edit on active case → refusal naming revise; nothing written.
- revise with yaml name "X v2" → new id, draft, "X v2", original row UNTOUCHED (status still active).
- revise with yaml omitting name → copy keeps "(copy)" name (F5 pin).
- revise with INVALID yaml → INVALID + copy id returned; copy exists with original steps.
- deprecate active → status flips; deprecate again → idempotent ok; deprecate draft → refusal.
- Registry sweep: `registry.list()` contains NO tool whose name includes 'activate' or 'delete' (condition 6 negative).

```bash
cd server && pnpm vitest run test/agent-draft-tools.test.ts test/agent-config-tools.test.ts && npx tsc --noEmit -p tsconfig.json
```

## Completion gate

- [ ] active cases immutable to the agent except via revise (both paths pinned)
- [ ] revise never loses data (invalid-yaml copy survival test green)
- [ ] no activate/delete tool names exist in the registry
- [ ] full suite green; commit pushed
