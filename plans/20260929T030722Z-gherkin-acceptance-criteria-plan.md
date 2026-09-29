# Gherkin acceptance criteria per step — narrate (plan)

- Source brainstorm: `brainstorm/20260929T030722Z-gherkin-acceptance-criteria.md` (+ its Decisions log)
- Status: Ready (rev 2 — review findings F1-F5 applied; review `reviews/20260929T030722Z-gherkin-acceptance-criteria-plan-review.md` verdict: Ready)
- Created: 2026-09-29

## Decision log (provenance)

| When | Source | Decision |
|---|---|---|
| 2026-09-29 | user, chat | "It is per step but perhaps optional. I just want the AC to be rendered when we run a test case." → per-step OPTIONAL Gherkin; render target = the run |
| 2026-09-29 | user, chat | "I like that format better." (reply to the `narrate:` sample) → field name **`narrate:`**, format = `narrate: When I open the account tab` |
| 2026-09-29 | user, chat | "But oversee the impact to the existing implementation" → impact survey delivered (18 push sites, key whitelist :489, emitter :620-741, run_steps 11-col, insStep playback.ts:537, RunPanel.vue:76-83, runs.ts:172); plan invoked after survey → direction accepted |
| 2026-09-29 | agent default, flagged | Non-Gherkin `narrate:` text → **warn, never reject** (prose in a human field must not hard-fail a case). Reversible one-liner if operator objects |
| 2026-09-29 | agent default, flagged | `narrate:` is a single-line scalar; embedded newlines are a parse error (emitter stays one-line-per-step; multi-line AC is a case-level feature, out of scope). Recognized keyword prefix set for the warning: `Given / When / Then / And / But` |
| 2026-09-29 | agent default, flagged | Editor is yaml-only this round (round-trip gives the field for free — survey conclusion); no form widget |

## Objective and completion conditions

A case author can write an optional Gherkin line on any step; when the case runs, that line renders in the live run panel beside its step and persists on the run's step rows, so a human reading a run sees *what the step accepts*, not just `tap 212,796`.

Done when:
1. Every action kind round-trips `narrate:` through parse→emit without loss; steps without it emit **byte-identical yaml to today**.
2. A live run of `tnc (logged-in)` carrying real AC lines shows them in the run panel while executing and in the persisted run detail after reload.
3. Old runs and cases are untouched (NULL narrate renders as today); full suite green; web build clean.

## In / Out of scope

**In:** case-yaml grammar + emitter; `run_steps` persistence (+guarded ALTER); SSE step events; RunPanel live render; persisted run-detail render; drill with real AC on tnc (logged-in).
**Out:** case-level `criteria:` block (revisit later if wanted); any execution semantics for Gherkin (narrate never affects pass/fail); editor form widget; per-step narrate in recordings auto-capture (authors write AC by hand); localization (Lionidas UI is English-only).

## Verified facts (code survey, 2026-09-29)

- `shared/src/case-yaml.ts`: 18 `stepsOut.push` sites each build fresh step objects — a generic lift is required or narrate is silently dropped at every site; the body-key whitelist (:~489) `known = [point, on, text, optional, id, name, contains, ignoreCase, when, at]` (+expect-only `count, atLeast`) would reject `narrate` as "unknown key" today.
- Emitter (:620-741): per-action one-line emitters with suffix idioms (`optSuffix`, `whenSuffix`); :741 throws on any action without a yaml form — loud, not silent.
- `run_steps` schema: 11 columns, no prose column; `insStep` INSERT fixed at `server/src/manual/playback.ts:537`.
- RunPanel fetch maps `run_steps` rows at `web/src/components/RunPanel.vue:76-83` (`Row extends PlanStep`); step identity is `stepName()` (playback.ts:135) — narrate is presentation, never identity.
- `runs.ts:172` uses `SELECT * FROM run_steps` — the new column rides for free; the persisted run-detail view is the component fetching that route.
- Guarded-ALTER precedent exists in `server/src/db/schema.ts` (folder columns landed this way in PR #6/#7).

## Architecture

`narrate` is a **display-only step attribute**: parsed once generically, carried on the step object, persisted per run-step row, shipped on step events, rendered by the UI. It never touches `stepName()`, matching, dispatch, or pass/fail.

Data contract: `narrate?: string` on the parsed step (single line, trimmed, non-empty after trim or dropped); `run_steps.narrate TEXT NULL`; SSE `step.started`/`step.finished` payloads gain `narrate: string | null`.

## Implementation stages (TDD, each stage green before the next)

### Stage 1 — grammar + round-trip (`shared/src/case-yaml.ts`)
1. RED: extend the existing round-trip suite — every action kind × {narrate present, absent}, covering BOTH the `steps:` list and the `setup:` list (parseStepList is shared by both sections). Assert: present → survives parse→emit→parse identical; absent → emitted yaml **byte-identical to pre-change output** — capture pre-change emitter output for the full action-kind matrix as fixtures FIRST (review F4: re-parse tests would mask formatting-only drift; the fixtures are an explicit acceptance artifact).
2. Parse — stamp-at-iteration-end (review F1: most push sites `continue` immediately, so a post-loop tail stamps nothing): at each iteration top capture `const lenBefore = stepsOut.length`; at iteration end (and before every `continue` that follows a push — equivalently: one stamp point at the iteration's end covering all paths) stamp `narrate` on every step pushed this iteration (`for (let j = lenBefore; j < stepsOut.length; j++)`). This handles all 18 push sites including the `continue` paths, in both setup and steps sections. Add `narrate` to the `known` body-key list for every action. Non-string or empty-after-trim → parse error naming the step; embedded newline → parse error (single-line contract).
3. Gherkin soft check — via a NEW `warnings` array on the parse result (review F2: no warnings channel exists today; `parseCaseYaml` returns `{ ok, case, errors, runFlowNames }` only): add `warnings?: YamlError[]` (additive, defaulted `[]`) to the result; emit `step N: narrate is not Gherkin (expected Given/When/Then/And/But) — prose accepted` there when the line lacks a keyword prefix (case-insensitive). Never an error; `ok` unchanged; callers ignore today. Server test asserts warnings present with ok:true for a prose narrate.
4. Emit: `narrateSuffix(n)` in the established `, key: value` idiom — `narrate: <yamlScalar(text)>` — appended in EVERY action emitter; missed kinds surface via the round-trip tests and the :741 throw.
5. GREEN locally: `server/test/case-yaml-roundtrip.test.ts` family.

### Stage 2 — persistence + events (server)
1. Guarded `ALTER TABLE run_steps ADD COLUMN narrate TEXT` in schema.ts beside the existing guarded-ALTER block; old rows NULL.
2. `insStep` (playback.ts:537) gains the column; every insert call site passes `step.narrate ?? null` (skip-marking inserts pass null). The OTHER two INSERT sites (`alloy/runner.ts:262,291` — review F3) stay **untouched by design**: their lanes (probe/recording) don't carry case yaml steps, narrate NULL is correct there, and named-column INSERTs are unaffected by the new nullable column.
3. SSE: the step.started/step.finished emitters include `narrate` from the step object; run_steps SELECTs that already `SELECT *` ride free.
4. RED→GREEN: server test — run a seeded case with narrated steps against the fake-alloy harness; assert `run_steps.narrate` persisted per idx and the step.started event payload carries it; old-format case (no narrate) → NULL everywhere, statuses unchanged.

### Stage 3 — render + drill (web)
1. RunPanel.vue: extend the row fetch mapping (:76-83) with `narrate: x.narrate`; live SSE row construction likewise. `narrate` is OPTIONAL in the UI types (`narrate?: string | null` on Row / PlanStep — review F5: `Row extends PlanStep` at :20) and the SSE handler (:135) must tolerate absence (old-server events during rolling restart → undefined renders as today). Render above/inside the step row as a muted Gherkin line — keyword (`Given|When|Then|And|But`) subtly colored (Axiom tokens), rest `--color-steel`; NULL/undefined → render exactly as today. Persisted run-detail view (the component fetching `/api/runs/:id` steps): same row treatment.
2. `pnpm run build` clean.
3. **Live drill on 30B28173 (iPhone 14 Plus):** author real AC on `tnc (logged-in)` — e.g. idx 0 `When I open the account tab`, idx 1 `When I tap Terms & conditions`, idx 2 `Then the terms document screen is shown` — save, run, verify: panel shows the three lines while executing; reload run detail → lines persist; a narrate-free case renders unchanged; yaml round-trip in the editor loses nothing.
4. Full gate: `pnpm vitest run` under nvm 24.12.0 (baseline 1077 + new), web build, `node scripts/scan-signatures.mjs` clean (mind doc wording).

### Branch / PR
Fresh branch `feat/step-narrate-gherkin` off synced main (never commit to main directly — operator rule 2026-09-28). Single PR after Stage 3 gate. Docs commit separate if any (`docs/` page update for the case grammar — separate commit, per standing preference).

## Edge and failure cases

- **Old runs / old cases** — NULL narrate; all render paths treat NULL as absent. No backfill.
- **runFlow sub-flows** — sub-steps insert with their own `flow_name`; narrate rides each identically; no special case.
- **Variants/swaps** — narrate lives on the base step; variant swaps replace selectors/steps wholesale (existing semantics), narrate of the swapped-in steps applies. No new interaction.
- **Export/import** — rides the yaml; import validates via the same parse (warn-only stance preserved).
- **Unicode/quotes in narrate** — `yamlScalar` handles quoting; round-trip tests include a quoted-string case.
- **Skip-marking inserts** (not-reached steps) — narrate still persisted (it's the author's AC; a skipped Then is exactly what a reviewer wants to see).

## Validation and acceptance

| Check | Pass condition |
|---|---|
| Round-trip matrix (all action kinds × narrate ±) | identical re-parse; absent → byte-identical emit |
| Parse guardrails | non-string/empty/multiline narrate → clear parse error; non-Gherkin → warning only |
| Persistence test | run_steps.narrate per idx; step.started carries it; no-narrate case → NULL |
| Live drill | tnc (logged-in) AC visible live + after reload on run detail; narrate-free case unchanged |
| Full gate | vitest all green (nvm 24.12.0), web build clean, signature scan clean |
| Zero regression | suite count = 1077 + new; existing run rows untouched |

## Rollout / handoff

Single PR; no migration beyond the guarded ALTER (idempotent, old rows NULL); no config or env changes; operator merges. Follow-up candidates (NOT in scope): case-level `criteria:` summary block; narrate-aware export styling; the Given↔setup/When↔action/Then↔expect pairing aid from the brainstorm.
