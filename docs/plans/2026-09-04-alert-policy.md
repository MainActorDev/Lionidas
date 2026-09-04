# Alert Policy — `alerts:` run-level dialog handling — Scoped Plan

> **For Hermes:** TDD, small batches, commit per task, live drills at the end.
> **Lineage:** interceptor (named-fail, shipped) → `alert:` step (single-shot, shipped
> tonight, kept for deliberate answers) → THIS: interrupts handled at the two sites
> that already detect them, driven by one run-level declaration. Drills `run_259acdaa`
> (stacked dialogs defeated a positioned alert step) and `run_3f89edca` (stack cleared
> but timing shifted) proved positioned steps can't model interrupts.

## Design (final, user-approved)

**YAML — three forms:**

```yaml
# 1. absent → default: every dialog named-fails the run (today's behavior)
# 2. scalar shorthand:
alerts: dismiss                  # or accept / fail
# 3. map (per-dialog answers; default REQUIRED):
alerts:
  location: accept
  default: dismiss
```

- Values: `accept` | `dismiss` | `fail`.
- Map keys (besides `default`) are **dialog matchers** — lowercased substring
  match against the dialog text the engine returns. Named matchers built in:
  `location` ("use your location"), `notifications` ("send you notifications"
  / "enable notifications"), `camera`, `microphone`, `contacts`, `photos`,
  `tracking` ("tracking" / "Across Other Companies" wording), `bluetooth`,
  `apple` ("sign in to your apple account" / "apple account"), `network`
  ("local network"). Custom keys match literally: `my custom thing: accept`
  matches any dialog containing that substring. First matcher (declaration
  order, default excluded) wins; `default` answers everything unmatched.
- Scalar `alerts: X` ≡ `alerts: { default: X }` — one resolver, zero drift.
- Map without `default` → save error ("every dialog must have a defined
  answer"). Unknown value → save error. Empty map → save error.
- Case-insensitive on both keys and dialog text.

**Resolution at runtime (one function, both sites call it):**

```
resolveAlertPolicy(policy | null, dialogText) → 'accept' | 'dismiss' | 'fail'
  null → 'fail'
  walk entries in order; first matcher whose substring hits (case-insens)
  wins (default only if nothing matched)
```

**Two enforcement sites (detection code already exists there):**

1. **Run-start gate** (playback.ts:451): dialog present → resolve →
   `fail` → current named-fail (unchanged); `accept`/`dismiss` → **drain
   loop**: while inspect ok && cleared < 3: dispatch action, record, re-inspect.
   Each cleared dialog appended to run note:
   `alert-handled (dismiss): "Sign in to your Apple Account" @ start`.
   Drain exceeding 3 → named-fail `alert storm: >3 dialogs at run start`.
2. **Mid-run no-change tap** (playback.ts:738): dialog present → resolve →
   `fail` → current behavior (step fails named, break); else clear once,
   record in note `alert-handled (accept): "…location?" @ step 4`, **retry
   the tap once** (the original touch never reached the app — one retry is
   the honest correction). Retry also no-change → warn-pass as today
   (screenChanged evidence already recorded). Mid-run handlings share the
   same per-run cap of 3 (start + mid combined: one counter).

**Cap:** 3 auto-handlings per run total. Exceeding → named-fail
`alert storm: >3 dialogs auto-handled` at the site that hit #4. Storms are a
real defect signal, never silently absorbed.

**Honesty rails:** default = fail (opt-in policy); every handling in
runs.note (action + quoted dialog text + site); accept-impossible (engine
`ok:false` on an accept that isn't "alert not found") → named-fail, never
masked; gate/interceptor behaviors for `fail`-resolved dialogs are
byte-identical to today (regression-tested).

**`alert:` step keeps existing semantics** — single-shot, deliberate
(e.g. `alert: accept` to grant in-test by intent). Policy handles interrupts;
step declares intent. No interaction: an `alert:` step executes regardless of
policy (it IS the author's explicit answer at a position).

**Interaction with `when:` guards:** a dialog blocking the screen can make a
guard read "not shown" (run_259acdaa step 1). With policy ≠ fail, the
run-start drain clears dialogs BEFORE step 1 — guards then read the true
screen. Mid-run dialogs that appear between guard and dispatch are covered by
the tap-retry site only for tap steps; a guard miss on an expect/type step
mid-run stays a skip (acceptable v1: expects poll up to 8s and dialogs
usually appear at start or after taps).

**Storage:** `templates.alerts_policy TEXT NULL` — JSON of the RESOLVED map
form (`{"entries":[["location","accept"],["default","dismiss"]]}` — ordered
pairs; JSON preserves array order). Scalar + absent both normalize to this
shape at save time; playback reads one shape only.

**Web:** completions: `alerts:` top-key with the three scalar values +
map-form skeleton; outline untouched (not a step). Run-detail note lines
already render (note is free text).

## Self-review findings (verified against code, folded in)

1. **[corrects design] No top-level key allowlist exists** — `parseCaseYaml`
   never rejects unknown top-level keys (only step-body keys are checked,
   case-yaml.ts:243). Task 1.4's "no longer unknown key" is a no-op; the
   parser simply gains an `alerts` reader. Simpler than planned.
2. **[corrects design] Mid-run site must be a LOOP, not clear-once** — the
   no-change correlation sits AFTER the tap returns. Two stacked dialogs both
   swallow the retry too. The tap-retry site therefore drains (same
   loop/counter as the gate) BEFORE retrying, and retries once; if the retry
   is also no-change AND another dialog is up, drain again and retry again —
   bounded by the shared cap of 3 handlings, not by a fixed 1 retry. Cap hit
   mid-run → step fails `alert storm`. Plan Task 2.3 rewritten accordingly.
3. **[corrects design] Note lines must APPEND, not overwrite** — the gate
   and mid-run sites both do `UPDATE runs SET note = ?` today (playback.ts:746
   shape), clobbering each other and the template label. Policy note lines
   must accumulate (read-note-append, or a collected array flushed at
   finish). Task 2.3 gains a `noteLines: string[]` collector appended in the
   existing finally block.
4. **[corrects design] `alert:` step + policy interleave** — run_3f89edca
   shows positioned alert steps still clearing dialogs (step 0/1) while the
   policy also exists. Rule pinned: `alert:` steps dispatch unconditionally
   (author's explicit answer, bypasses policy/resolver entirely); policy
   handles only gate + tap-retry sites. No arbitration needed — sites are
   disjoint. Documented in Design.
5. **[confirmed] retry site ordering** — drain-then-retry sits INSIDE the
   `screenChanged === false` branch, before the warn-pass `insStep.run`
   (playback.ts:733-755); the retried tap recomputes sig-after so the final
   row reflects the retry's outcome. Duration includes retries (honest).
6. **[confirmed] schema pattern** — `alerts_policy TEXT` follows the exact
   `setup_json` migration pattern (ALTER TABLE list in schema.ts:220s);
   INSERT paths in templates.ts:159/172 need no change (column nullable).
7. **[test debt] `templates-yaml.test.ts`** asserts GET-yaml output shape —
   must gain an alerts assertion (scalar emit when default-only); also
   `case-yaml.test.ts` round-trips.

## Tasks

### Task 1 — shared: policy types + resolver + parser + serializer
Files: `shared/src/case-yaml.ts` (+ `alert-policy.ts` new, ~60 lines), tests
`server/test/case-yaml.test.ts` + new `server/test/alert-policy.test.ts`.

1. `alert-policy.ts`: `AlertPolicy = { entries: Array<[matcher, Action]> }`;
   `NAMED_MATCHERS: Record<string, string>`; `resolveAlertPolicy(p|null, text)`:
   null→'fail'; ordered walk, substring case-insens, default fallback; unit
   tests: scalar, map order, default-required at PARSE level not resolver,
   custom matcher, no-match→default, null.
2. Parser: `c['alerts']` — string in {accept,dismiss,fail} →
   `{entries:[['default',v]]}`; map → validate keys non-empty strings, values
   in set, exactly one `default`, ≥1 entry; errors otherwise. Attach to
   YamlCase as `alerts?: AlertPolicy`.
3. Serializer: scalar form when single default-only entry; map otherwise;
   round-trip test both directions.
4. Unknown top-level key `alerts` no longer "unknown key" (top-key allowlist).

### Task 2 — server: storage + playback enforcement
Files: `server/src/db/schema.ts`, `server/src/routes/templates.ts`,
`server/src/manual/playback.ts`; tests extend
`server/test/playback-setup.test.ts`.

1. Schema migration: `ALTER TABLE templates ADD COLUMN alerts_policy TEXT`.
2. Route: PATCH/PUT-yaml persist; rowToTemplate expose `alerts`;
   GET-yaml emits (caseToYaml already handles); INSERT paths default NULL.
3. Playback: read column → parse (tolerate garbage → null = fail).
   Gate site: resolve+drain (cap 3, note lines, storm named-fail). Tap-retry
   site: resolve+clear+retry-once+record. Shared counter. alert-step branch
   untouched. Tests: gate drain multi-dialog; policy fail at gate = today;
   mid-run clear+retry passes; storm cap; accept-impossible; garbage column.
4. Regression: no policy → both sites behave exactly as the interceptor
   commit (existing tests green — they ARE the regression suite).

### Task 3 — web + completions
1. `yaml-completions.ts`: top-key `alerts` (scalar skeleton `alerts: dismiss`);
   `alerts-value` slot offering accept/dismiss/fail; map keys hinted (location,
   notifications, default …) in body-key slot when inside `alerts:`.
   Simplest v1: scalar completion + a map-form detail string; slots keep
   `none` inside the map (fail-safe) unless trivial to add.
2. Tests updated (action-list assertions untouched — alerts is not a step).

### Task 4 — live drills (fresh install each)
1. **Positive full-green:** policy `{location: accept, default: dismiss}` on
   the privacy case (setup drops positioned alert steps; keeps when-guard
   tap). Expect: location accepted, Apple sheet + any second dialog drained,
   case passes to final expect.
2. **Location grant proof:** after drill 1, re-launch app → no location
   dialog (decision persisted), and screenshot/app state shows location-
   dependent UI if cheap to check.
3. **Default-fail regression:** no policy on same device state → named-fail
   at gate (proves opt-in honesty).
4. **Storm cap:** not drilled live (needs a dialog-spamming app); covered by
   unit tests only — noted as such.

## Edge cases

| # | Case | Decision |
|---|---|---|
| 1 | `alerts: {}` | Save error — map needs ≥1 entry |
| 2 | Map missing `default` | Save error — every dialog must have an answer |
| 3 | Two custom matchers, both hit | Declaration order wins (first) |
| 4 | `location: accept` but dialog is Apple sheet | default answers it |
| 5 | accept when engine cannot accept | Named-fail (never masked) |
| 6 | Dialog appears during expect settle-poll | v1: not handled mid-expect (poll may outlast it); tap-retry covers post-tap cases; documented |
| 7 | Policy + `alert:` step both present | Step runs as authored (explicit intent); policy handles everything else |
| 8 | runFlow child raises dialog | Policy is run-level → parent's policy covers child steps |
| 9 | alerts_policy column garbage | Parse-tolerant → null → fail (honest default) |
| 10 | Scalar vs map round-trip fidelity | Scalar→normalized map→scalar re-emitted when default-only |
| 11 | `alerts: FAIL` (case) | Error — exact lowercase values only |
| 12 | Custom matcher with yaml-hostile chars | Allowed — substring match, quoted scalar on emit |

## Out of scope
- Per-step policy overrides.
- Alert-text capture into evidence artifacts (note lines suffice v1).
- Mid-expect dialog handling (edge 6).
- Localizing matcher substrings (EN dialogs only — sim locale is EN).
