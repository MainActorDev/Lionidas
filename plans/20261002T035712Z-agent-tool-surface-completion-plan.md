# Agent tool-surface completion — plan

- Source: `brainstorm/20261002T035712Z-agent-tool-surface-completion.md` (Direction selected)
- Decision log (operator, this session): "If we can have all those from the list. Do that. Except the 'activate/delete/play/device'" · "as proposed" (both design questions: screens = full-list-or-refuse Option A; evidence = descriptor+path default, `inline:true` ≤1MB base64)
- Status: **Ready**
- Baseline: `feat/butler-integration` @ `cf10692` (agent v1 + config-author; 1195/1195)

## Objective

Complete the agent tool surface per the brainstorm's three tiers — 14 new tools — every one mirroring an existing route/CLI path in-process with verbatim errors. Act-class (activate/delete/play/device) remains nonexistent.

## Completion conditions

1. **Tier 1 — failure knowledge:** `evidence.get` (descriptor + absolute path; `inline:true` returns base64 when ≤1MB), `run.triage.get` (per failed step: reason, timing split, joined evidence rows — the route's shape), `case.versions` (revision, yaml_canonical, scenario pin per version), `flakes.list` (flow, score, recent statuses, quarantine state).
2. **Tier 2 — organization:** `folder.create/rename/move` across the three trees (kind param: cases app-scoped; scenarios/presets global — sibling-name uniqueness + cycle/depth guards verbatim from the folder routes), `case.duplicate` (route mirror: full copy, fresh id, `(copy)` collision-loop name, status draft), `cases.search` (filter by tags/app/status; returns id/name/status/app), `case.validate` (dry-run: parseCaseYaml with app recipe hooks + resolveCaseRefs; saves NOTHING; returns `{ok}` or verbatim errors).
3. **Tier 3 — unlocked gates:** `screens.draft.save` (Option A: requires `revision` echo + FULL screen list; `validateRegistry` through the shared validator; omitted-existing-screens → refusal naming the missing ids; 409 REGISTRY_STALE semantics verbatim; revisionless writes refused — the echo is mandatory), `recipes.get` (login/logout for a bundle; read-only).
4. All tools: `permission` per class (reads = read; writes = draft), real JSON schemas in the registry, no partial writes, nothing silent.
5. System prompt + MCP instructions updated (evidence/triage/versions/flakes awareness; screens full-list rule; validate-before-save nudge). Smoke: initialize instructions contain the new sections.
6. Tests: per-tool TDD in `test/agent-config-tools.test.ts` (+ evidence inline test with a real temp file); full suite green; live drill through Hermes exercising at least evidence.get + case.validate + screens.draft.save, logged in `docs/agent-drills.md`.
7. Docs: `docs/agent.md` tool table + drill log updated.

## Out of scope

Act-class (activation, deletes, play, devices), user/admin management, forge mode/MITM, queue, matrix. Registry drafts (Option B) — deferred.

## Interfaces

- All in `server/src/agent/config-tools.ts` (+ reads may land in `tools.ts` where they share helpers): `ConfigToolDeps` unchanged except `evidence.get` needs nothing new (reads path from evidence table).
- `screens.draft.save` uses `validateRegistry` from `@crucible/shared/app-screens` (already the route's validator) and `replaceRegistry`-equivalent inline (the route's helper is module-private — mirror its INSERT-or-replace semantics per screen row, bump revision).
- `case.validate` composes the SAME exported chain as `case.draft.save` (parseCaseYaml hooks + resolveCaseRefs) minus persistence.
- `recipes.get` reads the app_login/app_logout tables via the same queries the GET routes use.

## Stages

- **S1 Tier 1** (4 tools + tests). → 1
- **S2 Tier 2** (8 tools + tests; folder tools are 3 registrations sharing one implementation). → 2
- **S3 Tier 3** (screens full-list rule + recipes; tests incl. stale-revision 409 verbatim + omission refusal). → 3
- **S4 Prompt/instructions + docs + drill + closeout gates.** → 4–7

TDD per stage; commit per stage; suite green before push.

## Edge and failure cases (pinned)

- `evidence.get` missing file on disk (row exists, path gone) → honest `error: evidence file missing at <path>` (not a crash).
- `run.triage.get` on a passing step → returns the row with empty evidence + a `note: no failure` field (route returns 200 for any step).
- `case.duplicate` on a draft → allowed (route has no status gate); name loop proven against collisions.
- `cases.search` with zero matches → `[]` (not error).
- `folder.move` into its own descendant → the route's cycle refusal verbatim.
- `screens.draft.save` missing revision → `INVALID: revision is required (echo the current registry revision — fetch with screens.registry)`; stale → route's 409 body text; omitted screens → refusal listing missing ids; unknown bundle → registry created at revision 1 (route behavior for new bundles — verify at write time).
- `case.validate` on yaml whose app lacks recipes → hook fallbacks mirror draft.save exactly (same behavior, no persistence).

## Validation

Per-stage vitest; negative checks (no partial writes, verbatim strings asserted literally); S4 full repo gates (server + web + cli) + Hermes drill logged with tool names and results.

## Rollout

Continue on `feat/butler-integration` (PR #14 stream); commits per stage; operator merges.
