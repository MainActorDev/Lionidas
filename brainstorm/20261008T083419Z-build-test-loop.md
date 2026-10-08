# Phase 1 — the build→test loop: a passed build flows into suites automatically

- Source prompt: "Yes. Phase 1" — approving the proposed direction: "Test this build action on a passed ✓⌁ row: install that .ipa, run a chosen suite against it, record runs pinned to the build… scheduled overnight chain: build develop → smoke → run regression suite → morning state is 'build #N: passed, suite X 48/50'."
- Created: 2026-10-08T08:34:19Z
- Status: Questions open

## Goal and context

Everything through the smoke gate produces **verified-runnable artifacts** —
but consuming them is still manual: a human installs the ipa and plays
suites. Phase 1 closes the loop: a passed build can be sent straight into
the existing suite machinery, and the runs it produces are pinned to the
exact artifact that ran. End state: "build #22: passed · smoke ok · suite
'intl regression' 48/50 (2 fails)" with one-click evidence, on demand and
(optionally) overnight.

## Confirmed inputs and decisions (verified facts)

- The user approved the Phase 1 direction (prompt above). Scope: BUILD→TEST
  only; freshness/webhooks/retention are later phases.
- `runBatch` (routes/manual.ts:702) already: resolves booted-sim lanes,
  expands variants, creates run rows with `suite_id`/`batch_id`/
  `triggeredBy`, refuses ghost/deprecated/drifted members honestly
  (`/api/suites/:id/play` → 981).
- `runs` table already carries `app_version`, `app_build`, `suite_id`,
  `batch_id`, `template_id` — but **no build pin** (no `build_id`).
- `builds` rows carry `artifact_path` + `smoke`; a `passed · smoke=ok` row
  is exactly the trigger surface.
- Install machinery exists and is shared (`manual/app-install.ts`, used by
  the smoke gate) — installing a specific ipa on a chosen sim is solved.
- Suités have `app_bundle_id` scoping; the app built from a project has a
  stable bundle id (readIpaIdentity) — matching a build to the suites that
  can test it is a simple join, already the drift-check's job.

## Exploration

### The missing inch: `runs.build_id`

One column, `runs.build_id REFERENCES builds(id) ON DELETE SET NULL`, makes
every run attributable to the exact artifact that executed it. This is the
hinge of the whole phase — without it, "suite 48/50" floats free of "which
binary". With it: run detail shows the build chip, build row shows suite
verdicts, and the overnight chain's morning state is one query.

### The action: `POST /api/builds/:id/test` (server) + "▶ test…" (builds page)

Flow (reusing everything):
1. Guards (honest 409s, the house style): build must be `passed`, smoke
   `ok` (a crash-failed build cannot be tested), artifact on disk; suite
   must be non-empty and its `app_bundle_id` must match the build's bundle
   id (else BUNDLE_DRIFT-style named error).
2. Resolve target device: explicit `udid` or the batch's booted-sim lane
   logic; **install this build's artifact first** (the same call the smoke
   gate makes) so the suite provably runs THIS binary, not whatever was
   previously on the sim.
3. `runBatch({ cases: suiteMembers, triggeredBy: 'build:#N', suiteId,
   buildId })` — one threading change: runBatch stamps `runs.build_id`.
4. Response: `{ runIds, batchId }` — the builds page navigates to the
   runs/batch view it already has.

### Overnight chain (the scheduled pipeline)

- Minimal: an in-server scheduler (setInterval + per-project config row:
  `{ enabled, time: '02:00', suiteId }` on the projects table — admin sets
  it in the project editor). Fire: pull → build → on passed+smoke-ok →
  test. All steps are the existing endpoints' internals.
- Alternatives considered: OS cron calling the API (extra auth surface, no
  benefit for a single-host tool); GitHub webhook (Phase 2's freshness
  story, not this phase).

### Surfacing

- Builds row gains the suite verdict chip after a test run exists for the
  build (`48/50` with pass-color; hover lists failing cases).
- Runs keep living where they live (runs page); a build chip on run rows
  links back. No new page — 029-A stays the CI surface.

## Risks

- Device contention: overnight build tests on the same sims manual QA uses
  at 9am — mitigate: the scheduler only starts when no runs are active,
  and the suite picker lets admin pin a dedicated udid later (defer).
- Suite duration × build time inside one chain: fine — builds are serial
  per project already; the chain is just queued steps.
- `triggeredBy: 'build:#N'` provenance must survive batch bookkeeping
  (batch_id already does; build_id rides the same insert).

## Open questions

1. **Suite selection** — per-project pinned default suite (projects column,
   set in the editor; the overnight chain uses it) with per-run override in
   the ▶ test… picker, or purely ad-hoc per build? *Recommendation: pinned
   default + override — the overnight chain needs a deterministic choice,
   and ad-hoc-only would block it.*
2. **Overnight scheduler now or manual-only first?** *Recommendation: ship
   the manual ▶ test… action first (it is the chain's engine anyway), add
   the scheduler as the second commit once the action is drilled — same
   PR, two steps.*
3. **Failed-suite verdict on the build row** — if the chain's suite fails,
   does the build row show a red suite chip only (build stays passed — the
   BINARY was fine, the CODE failed tests), or does anything cascade?
   *Recommendation: chip only; a build's pass/fail must stay about the
   artifact, suite results are the code's verdict — conflating them undoes
   the honesty we just built.*

## Next step

Answer the three questions → plan round (schema + endpoint + runBatch
threading + row chip + optional scheduler) → build → drill: build #21 →
▶ test → suite runs pinned to #21 → (if scheduler approved) fake-schedule
fire → verify chain output.
