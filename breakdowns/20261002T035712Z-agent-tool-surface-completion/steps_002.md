# Step 2 — Tier 2: organization tools (folders ×3, duplicate, search, validate)

- **Status:** Ready
- **Plan:** rev 2, Stage S2, condition 2; review F4 (two folder implementations)
- **Repo:** Step 1 head · **Depends on:** Step 1 (test harness)

## Outcome

8 tools: `folder.create`, `folder.rename`, `folder.move` (kind-aware: cases | scenarios | presets), `case.duplicate`, `cases.search`, `case.validate`.

## Implementation

### folder tools — F4: mirror the right route per kind

| kind | mirrors | key semantics |
|---|---|---|
| cases | `routes/folders.ts` (bespoke) | app-scoped (`appBundleId and name required` verbatim; parent same-app 409 `parent folder belongs to X — folders are app-scoped`; depth cap; sibling 409 `a folder named "X" already exists here`) |
| scenarios / presets | `folder-routes-factory` semantics | global tree; parent 409 `folder "X" not found`; depth cap 8; sibling-unique (UNIQUE index — catch → same 409 wording the factory uses; read it at write time) |

- `folder.create {kind, appBundleId?, parentId?, name}` → id; `folder.rename {kind, idOrPath?, id, name}` → trim/empty 400 verbatim; **`folder.move` = MOVE ITEMS** (the cases route moves *cases*: `templateIds[] + folderId`), so expose `case.move {templateIds, folderId?}` for kind=cases semantics (app-scope mismatch 400 verbatim from the tx catch) and `folder.move {kind, folderId, parentId?}` for re-parenting a FOLDER in the global trees (cycle guard verbatim from the factory). Two distinct operations — name them for what they do, don't overload.
- One shared registration helper parameterized by kind → three thin registrations (avoid copy-paste ×3).

### case.duplicate — mirror `POST /api/templates/:id/duplicate` (templates.ts:395-420)

Full field copy, fresh `tpl_` id, `(copy)`/`(copy 2)` collision-loop, status `draft`, one transaction. No status gate (route has none).

### cases.search — `SELECT id, name, status, app_bundle_id FROM templates` + filters

tags (LIKE on tags_json — mirror `selectTemplates` filter semantics: tag substring), app exact, status exact (draft|active|deprecated); order name; cap 200.

### case.validate — DRY-RUN of the save chain

parseCaseYaml with the app recipe hooks (same fallbacks as `case.draft.save`: lookup bundle from the yaml's `app`) → resolveCaseRefs → return `{ok: true}` or `INVALID: <verbatim>` — NO writes. Reuse by extracting the shared "validate yaml" closure from `case.draft.save`'s execute body into a module function both call (one definition of validation semantics).

## Verification (TDD)

- folder.create ×3 kinds happy + parent-missing 409 + sibling 409 + depth-cap; cases kind requires appBundleId verbatim
- case.move mixed-app → verbatim 400, count unchanged; folder.move into own descendant → cycle refusal
- duplicate: name loop proven with a pre-existing `(copy)`; copy is draft; original untouched
- search: tag/app/status filters; zero matches → `[]`
- validate: valid yaml → ok + NO template row created (count pinned); invalid → verbatim error, no row

```bash
cd server && pnpm vitest run test/agent-config-tools.test.ts && npx tsc --noEmit -p tsconfig.json
```

## Completion gate

- [ ] 8 tools green with verbatim strings; no partial writes; full suite green; commit pushed
