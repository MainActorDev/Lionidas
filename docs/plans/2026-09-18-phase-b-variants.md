# Phase B — Test Variants: the `variants:` YAML Key (Implementation Plan)

> **For Hermes:** parent plan `docs/plans/2026-09-18-testcase-management.md`
> (Phase B section). Implement task-by-task, per-task verify + commit.
> Phase B is PARSER-SURFACE ONLY — parse, validate, serialize, store,
> autocomplete, vocabulary. The RUNNER DOES NOT EXPAND variants in this
> phase (Phase C). A case with `variants:` that is RUN during the gap
> executes exactly once, ignoring variants — an honest, documented interim
> behavior (not silent: the plan records it, the guide row says it).

**Goal:** A case can declare state coverage — one flow, N deterministic
worlds (network scenario + env values) — in a single YAML key that parses,
validates with line errors, round-trips through the editor, and arrives in
the vocabulary. Nothing executes differently yet.

**Architecture:** One new top-level key `variants:` in case-yaml, following
the established grammar of the format — explicit body keys, no sigils, no
conventions hidden in values. Storage rides `templates.steps_json` as a
sibling `variants_json` column (management metadata lives beside steps,
matching the house layout). Validation is line-carrying like every other
error. The editor gets slot-aware completions (variant ids, scenario names)
through the EXISTING yaml-slots/yaml-completions pipeline.

**Tech Stack:** `@crucible/shared/case-yaml` (parse/serialize), a new
`yaml-variants.ts` pure module (validation + env-merge rules, exported for
Phase C reuse), `migrateM1` guarded ALTER, vocabulary endpoint, CM6
completions, vitest.

---

## Verified facts (receipts, 2026-09-18)

1. **Parser anatomy** (case-yaml.ts:60-137): top-level keys handled
   key-by-key (`name`, `tags`, `app`, `alerts`, `setup`, `steps`); errors
   are `{line, message}` via a `lineOf` helper that currently pins line 1
   for top-level keys (approximation documented in-source); step lists
   parse through one `parseStepList(section, prefix, errors)` seam.
2. **Serializer** (case-yaml.ts:351-376): `caseToYaml` emits top-level keys
   in fixed order, omits absent ones — variantless cases are byte-stable
   (the round-trip test corpus proves it).
3. **Top-level keys are NOT unknown-key-checked today** — `parseCaseYaml`
   ignores unrecognized top-level keys silently (only STEP body keys are
   strictly checked, case-yaml.ts:285-288). So `variants:` parsing must be
   added explicitly; nothing today rejects it.
4. **Vocabulary endpoint** (templates.ts:345-380): aggregates selectors,
   caseNames, apps, tags from all templates; malformed-steps tolerant.
   Scenarios are NOT in the vocabulary yet — variant `networkScenario:`
   completions need them (new aggregation + `EditorVocabulary` field).
5. **Completions pipeline**: `yaml-slots.ts` `slotAt(doc, cursor)` →
   slot enum (has `top-key`, `body-key`, `runflow-name`, …; NO variant
   slots) → `yaml-completions.ts` `buildCompletions(slot, vocab, …)` →
   `top-key` list is a hardcoded array (case-yaml grammar).
6. **Storage**: `templates` gains columns via the guarded-ALTER list
   (schema.ts:207+); steps_json is the executable truth; Phase A put
   provenance in sibling tables, management metadata in columns
   (tags_json precedent).
7. **Env machinery already exists**: `${env.X}` refs resolve at playback
   via `template-env.ts` (REF :16, missing-key = honest step error).
   Variant env merges INTO that map in Phase C — Phase B only validates
   shape.
8. **YamlCase shape** (case-yaml.ts:37-46): `{name, tags, app?, setup?,
   alerts?, steps}` — adding `variants?` is additive; `caseToYaml`'s
   input type must grow the field (it takes a structural arg, so callers
   unaffected).

---

## The format (settled by the parent plan + this plan's decisions)

```yaml
name: Render account status
tags: [account, smoke]
app: com.example.app

variants:
  - id: active
    networkScenario: account-active      # scenario NAME (UNIQUE → total resolution)
    env:
      expected_title: "Account Active"
  - id: pending
    networkScenario: account-pending
    env:
      expected_title: "Verification Pending"

steps:
  - tap:
      on: Masuk
  - expect:
      equals: "${expected_title}"
```

Decisions (each rejecting an alternative):
- **`networkScenario`** (camelCase, joins `runFlow`/`labelContains` house
  style; rejects `network_scenario` snake and `scenario:` bare — the key
  must say WHAT it references).
- **`env:`** sub-map (not `variables:` — the runtime concept is already
  named env everywhere: template-env.ts, plans env_json, batch env).
- **`id` required, `[a-z][a-z0-9_-]*`, unique in-case** — matches variant
  shape used across the industry and our own identifier rule; rejects
  free-text variant names (they become run labels, not ids).
- **`variants:` lives ABOVE steps** in canonical serialization order
  (name, tags, app, alerts, setup, variants, steps) — read-before-the-flow,
  same reason setup precedes steps.
- **`env` values are strings only** — `${…}` refs inside them are data,
  not nested substitution (single-level, deterministic; rejects recursive
  interpolation, which the brief's determinism rule forbids).

## Validation rules (all line-carrying)

| # | Rule | Error shape |
|---|---|---|
| 1 | `variants` not a list → error naming the shape | `variants must be a list (- id: …)` |
| 2 | empty `variants: []` → error (remove the key) | `variants, when present, needs at least one — remove the key if the case has no variants` |
| 3 | variant entry not a mapping → error | `variant 1 must be a mapping (- id: …)` |
| 4 | `id` missing / bad shape → error with the shape | `variant 1: id must match [a-z][a-z0-9_-]* (got "Active State")` |
| 5 | duplicate `id` → error naming both | `variant 3: duplicate id "pending" (also variant 2)` |
| 6 | unknown keys in a variant → error listing allowed | `variant 1: unknown key "scenario" — did you mean networkScenario?` |
| 7 | `env` not a string map → error | `variant 1: env must be a map of strings (expected_title: "…")` |
| 8 | `networkScenario` not a string → error | `variant 1: networkScenario must be a scenario name (string)` |
| 9 | MAX variants = 12 (runaway guard, same spirit as max-8 tags) | `too many variants (13) — max is 12` |
| 10 | scenario NAME unresolvable → NOT a parse error (parse can't see the DB — same split as runFlow names): surfaced by the SAVE path + Phase C expansion | save-time 422 naming case+variant |

(Scenario-name resolution is total because `scenarios.name` is UNIQUE —
same argument as runFlow-by-name.)

---

## Tasks

### T1 — `shared/yaml-variants.ts` (pure validation, TDD)

**Files:** create `shared/src/yaml-variants.ts`, test in
`server/test/yaml-variants.test.ts` (same home as parser tests).

- `export interface YamlVariant { id: string; networkScenario?: string; env?: Record<string, string> }`
- `export function parseVariants(raw: unknown, errors: YamlError[]): YamlVariant[] | null`
  — implements rules 1–9; returns null on any error (never partial).
- `export function mergeVariantEnv(variant: YamlVariant | null, invocationEnv: Record<string, string>): Record<string, string>`
  — the Phase C precedence in ONE tested place today:
  `{...invocationEnv, ...variant.env}` (variant wins; narrowest scope
  last). Pure, property-testable.
- `export const VARIANT_ID_RE = /^[a-z][a-z0-9_-]*$/;`
- Tests: all 9 rules (one test each, red→green), happy path of 3 variants
  (the brief's account-status example verbatim), env-merge precedence
  (variant overrides invocation; disjoint keys union; null variant =
  passthrough).

### T2 — case-yaml integration (parse + serialize, TDD)

**Files:** `shared/src/case-yaml.ts`, tests in `server/test/case-yaml-variants.test.ts`.

- `YamlCase` gains `variants?: YamlVariant[]` (import from
  yaml-variants — shared module, no export-map entry needed, case-yaml
  re-exports the type).
- `parseCaseYaml`: after `alerts`, before `setup` — `if
  (c['variants'] !== undefined) { variants = parseVariants(c['variants'],
  errors) }`; result carries `...(variants ? { variants } : {})`.
- `caseToYaml`: emit `variants:` between `alerts` and `setup` blocks
  (order: name, tags, app, alerts, variants, setup, steps) using a
  `variantScalar` helper; absent ⇒ zero bytes (byte-stability kept).
- Serializer shape per variant: `- id: active` + indented
  `networkScenario: account-active` + `env:` block (yamlScalar every
  value — quoting rules already handle `${…}` braces).
- Tests: round-trip parse(caseToYaml(x)) === x for the 3-variant example;
  variantless round-trip byte-stability (parse→serialize→string equal);
  variants-with-env-only / scenario-only minimal shapes; unknown
  top-level key still ignored (unchanged behavior receipt).
- **⛔ NOT in T2**: unknown-TOP-KEY strictness (whole-format change,
  out of scope — noted in DEFERRED at phase end).

### T3 — storage + routes (variants_json, TDD)

**Files:** `server/src/db/schema.ts` (guarded ALTER:
`'ALTER TABLE templates ADD COLUMN variants_json TEXT'`),
`server/src/routes/templates.ts` (save/load), tests.

- Save path (both POST create and PUT yaml): parse already yields
  `variants` via T2 — persist `JSON.stringify(variants ?? null)`;
  scenario-name resolution check happens HERE (rule 10): every
  `networkScenario` must SELECT 1 FROM scenarios WHERE name = ? — else
  422 line error `variant "active": unknown scenario "account-active"`.
- Load path (`GET /:id/yaml`): parse variants_json, feed through
  caseToYaml (which now emits the key). `rowToTemplate` (table view)
  exposes `variants: string[]` (ids only — the table needs labels, not
  worlds).
- Migration note: backfill unnecessary — NULL variants_json ≡ no variants
  (absence IS the value).
- Tests: create-with-variants round-trips through GET yaml; save with
  unknown scenario → 422 naming variant+scenario; table shape carries
  ids; variantless case saves/loads unchanged (compat receipt).

### T4 — vocabulary + autocomplete (the editor closes the loop)

**Files:** `server/src/routes/templates.ts` (vocabulary endpoint),
`shared/src/yaml-slots.ts` + `shared/src/yaml-completions.ts`,
`web/src/composables/useYamlEditor.ts` (vocab type), tests.

- Vocabulary endpoint adds `scenarios: string[]` (SELECT name FROM
  scenarios ORDER BY name) and `variantIds: string[]` (from all
  templates' variants_json — malformed-tolerant like selectors).
- `EditorVocabulary` gains both fields (optional — old callers
  grammar-only safe).
- Slots: `variant-id` (after `- ` inside the `variants:` block),
  `variant-key` (the `- id:` line's sibling keys), `scenario-name`
  (after `networkScenario: `). Detection mirrors `runflow-name`'s
  regex approach (line-shaped format — same assumption, same fallback).
- Completions: `variant-key` → `id`/`networkScenario`/`env` skeletons;
  `scenario-name` → vocab scenarios; `top-key` list gains
  `variants` skeleton (`variants:\n  - id: \n    networkScenario: `);
  `variant-id` → vocab variantIds (cross-case reuse aid).
- Tests: slotAt classifies the three new contexts (cursor positions
  pinned); buildCompletions returns skeletons/scenarios; vocab endpoint
  shape (real DB via buildApp).
- Browser drill (real keyboard, per the CM6 lesson): type `var` at top
  level → `variants` completes; inside the block, `net` → `networkScenario`;
  scenario name completes; save validates.

### T5 — docs + DEFERRED + gates

- Guide: extend the Phase A provenance paragraph's sibling section with
  one variant sentence + the honest interim note (variants don't execute
  until Phase C — visible in the editor, validated on save).
- DEFERRED: Phase B shipped; runner expansion = Phase C (separate plan);
  unknown-top-key strictness noted as rejected-for-now.
- Gates: full server suite `--maxWorkers=2`, `vue-tsc`, `vite build`,
  lint. Existing corpus MUST stay green unchanged (compat receipt).

---

## Explicitly OUT (Phase B)

- Runner/batch expansion of variants (Phase C — including
  `runs.variant_id` writes, per-variant provenance versioning, cost
  estimation ×N).
- Variant × runFlow interaction policy (Phase C decision: flows inherit
  variant env — recorded in parent plan).
- Suite/matrix surfaces (Phase D).
- Any UI beyond editor autocomplete (the case table's variant count
  column, variant chips on runs — Phase C/D when execution makes them
  real).
- Changing `EditorVocabulary` consumers beyond the new optional fields.

## Edge cases (walked)

| # | Case | Behavior |
|---|---|---|
| 1 | `variants:` present, case run during the B→C gap | executes once, variants ignored — documented interim, not silent |
| 2 | variant id collides with an env key name | namespaces differ (`env.` prefix on refs) — no clash possible |
| 3 | `${expected_title}` in steps but case has no variants | unchanged behavior: resolves from invocation env or missing-key step error |
| 4 | variant env key that no step references | harmless (unused map entry); NOT an error — same as unused plan env |
| 5 | two variants, same scenario, different env | valid — scenario choice is not the variant's whole identity |
| 6 | variants on a case used AS a runFlow child | Phase C policy (flows inherit); Phase B: parses, stores, ignores |
| 7 | scenario renamed after save | save-time validation catches on NEXT save; stored name keeps resolving while the row exists (UNIQUE); deletion → Phase C expansion honest error |
| 8 | 12 variants each with env | max guard passes; expansion cost lands in Phase C's planner |
| 9 | `variants: null` (explicit null in yaml) | treated as absent (yaml null ≡ missing key — same as tags) |
| 10 | editor dirty-state with variant parse error | existing outline-stale + line-error surface (unchanged machinery) |

## Gates

`pnpm typecheck && pnpm lint && pnpm vitest run --maxWorkers=2` (server);
`vue-tsc && vite build` (web). The pre-existing case-yaml test corpus is
the backward-compat receipt — zero modifications to existing tests.

---

## Self-review (findings folded back)

1. **(a) executed each planned test mentally:** the byte-stability test
   must build its input from `caseToYaml` of a parsed FIXTURE (not a
   hand-written string) — else serializer drift passes vacuously. The
   env-merge test needs the SAME key in both maps (override visible) plus
   a disjoint key (union visible) — my first draft only tested override.
2. **(b) both ends of every data link:** variants_json written by save
   (T3) ↔ read by GET yaml (T3) + vocabulary endpoint (T4) + Phase C's
   expansion (future — the column is the contract). `EditorVocabulary`
   new fields produced by the endpoint ↔ consumed by buildCompletions
   via useYamlEditor's fetch — both optional so the T4 endpoint change
   and composable change can land in EITHER order (no lockstep deploy).
3. **(c) receipts re-checked:** no unknown-top-key check exists today
   (fact 3) — which means WITHOUT T2, a `variants:` case would silently
   save today with variants dropped by the round-trip. Caught: T2 is not
   just additive, it FIXES a silent-data-loss path for early adopters.
4. **(f) schema placement:** column-add in the guarded-ALTER list only;
   no CREATE, no backfill (NULL ≡ absent). Matches the migrateM1 contract.
5. **(g) determinism:** no wall-clock asserts; slot tests pin cursor
   offsets in literal strings; vocab test uses buildApp with an
   in-memory DB.
6. **CM6 verification honesty (lesson from the read-only bug):** T4's
   drill must use REAL keyboard events (`pressSequentially`-class input),
   never synthetic KeyboardEvent dispatch — pinned in the task text.
7. **Honesty audit:** the interim "parses but doesn't execute" state is
   called out in THREE places (this plan's header, the guide row, DEFERRED)
   — a user reading any one of them cannot be surprised. Save-time
   scenario validation is the only new failure mode, and it's
   line-carrying + names the variant.
8. **Vocabulary scale:** scenarios table is small (tens); variantIds
   across all cases bounded by 12×cases — no aggregation risk. Endpoint
   stays one query per source.
9. **Serializer ordering decision re-walked:** placing `variants` BEFORE
   `setup` puts world-definition before preconditions — but `setup` steps
   THEMSELVES may reference `${env…}` variant values at Phase C time.
   Order in the FILE is cosmetic (yaml mapping, not positional); kept
   variants-before-setup for readability, noted that execution order is
   unaffected.
