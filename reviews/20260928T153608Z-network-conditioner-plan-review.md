# Review — network conditioner plan (20260928T153608Z)

- Reviewed: `plans/20260928T153608Z-network-conditioner-plan.md` (status Ready, 2026-09-28)
- Sources: brainstorm `20260928T153608Z-network-conditioner.md` (all questions answered), Baguette `docs/features/network.md` + LIVE CLI verification on 30B28173 (set/status/clear cycle, this session), verified against `server/src/manual/playback.ts` (done closure, location hygiene precedent at :452/:1184/:1773, `alloy_apps open` at :582, PlaybackDeps seam at :59-74), `server/src/routes/manual.ts` (variant lanes :481-505 — SEQUENTIAL per play; runBatch device-lane parallel :608+), `server/src/manual/session.ts:130` (QUEUE_ACTIVE single-run-per-device), live DB (templates columns).
- Verdict: **Needs revision** — 1 High, several Mediums; all corrections are plan edits, no operator decisions blocked.

## Traceability summary

Operator answers (manual+run-scoped / CLI / presets-varied) → plan covers all three; preset set matches Baguette's doc verbatim; CLI contract verified live, not just read. Coverage gaps are enumerated below. No extra commitments found beyond: run-stamp `net:<preset>` in the note (consistent with the plan's own provenance goal, disclosed).

## Findings

### F1 — HIGH: case-level `network:` storage claim contradicts the template schema the plan itself cites

Plan §Case grammar says the case-level pin "rides the YAML round-trip's stored form: extend `snapshotCaseVersion` inputs, NOT a new column" — but verified: templates carry `steps_json`/`setup_json` only; there is NO stored case-yaml column, and `snapshotCaseVersion` (case-versions.ts) snapshots steps+scenario, not arbitrary top-level yaml keys. Where the case-level `network:` would PERSIST is unspecified — parseCaseYaml could accept it, but nothing stores or forwards it to playback today.
**Correction**: pick one concrete carrier, in the plan: (a) **variant-only pins** (drop case-level for this round — variants_json already round-trips), or (b) case-level via a guarded `templates.network_profile TEXT` column (one column, one read in playback — cheap and explicit). Option (a) is the smaller honest cut; (b) matches the operator's "case/variant" wording. The plan must state which and adjust grammar/stages accordingly.
**Verify**: grammar round-trip test names the storage carrier; playback test reads the pin from that carrier.

### F2 — MEDIUM: playback ordering claim needs the exact seam, and the "before open" window is wider than stated

The plan says set happens "AFTER env/TCC setup, BEFORE the `alloy_apps open` (:582)". Verified the real constraint is stronger: the app must not be running when `set` fires — and playback may RELAUNCH an app that's already running (open with terminate). The pre-open window (:559-582) is correct, but the plan should also state: if a run pins NO condition, playback must NOT clear an existing manual condition (the user may have set one deliberately from the UI — a run clearing it would be sabotage). Symmetric rule: pinned → set+clear; unpinned → touch nothing. Add to §Playback + a test.
**Verify**: playback tests: (1) pinned run sets before open and clears in finally; (2) unpinned run leaves an existing condition untouched.

### F3 — MEDIUM: the finally-clear race with parallel batch lanes

Plan's race note says the single-active-run queue serializes — TRUE for same-device plays (QUEUE_ACTIVE, session.ts:130) and variant lanes are sequential per play (manual.ts:486-505, awaited chain). BUT runBatch runs lanes CONCURRENTLY across DIFFERENT devices, and a lane's finally-clear targets ITS udid — safe. The residual risk is narrower than the plan implies and worth stating precisely: two concurrent lanes on the SAME udid cannot happen (queue); concurrent DIFFERENT-udid set/clears are independent processes — no cross-clear. No code change; fix the plan's wording so the acceptance test can assert the actual invariant (per-udid isolation under runBatch parallelism).
**Verify**: test seeds two fakes (different udid shims) in one batch; assert each lane's clear hits only its udid.

### F4 — MEDIUM: shim status parsing pins on human-readable output

The plan parses `network status` stdout ("iPhone 14 Plus network: 200 ms latency, 780 kbps") — prose the Baguette CLI formats for humans, including the device name; a wording change breaks the parser silently. Mitigation without touching Baguette: treat status as BEST-EFFORT display (set/clear rely on exit codes, which are contracts); if parsing fails → show raw line, never an error state. State that in the plan. (A `--json` flag in Baguette would be the durable fix — out of scope here; note as follow-up.)
**Verify**: shim test feeds a malformed status line → result is `{conditioned:'unknown', raw}` not a throw.

### F5 — MEDIUM: PLAY of a `network:`-pinned case without Baguette fails pre-flight — but batch plays (play-all/plans/suites) must SKIP-with-reason, not halt the batch

The plan specifies NETWORK_CONDITION_FAILED honest stop for a single play. For runBatch (plans, suites, folders), one unpinnable case aborting the whole batch is disproportionate — the established pattern is named-skip (dead variant pins skip with a reason). Amend: single play → fail; batch lane → skip the case with reason `network conditioner unavailable: <detail>`, batch continues.
**Verify**: batch test with a fake-absent shim → lane skipped with named reason, siblings run.

### F6 — LOW: device picker data source unnamed

UI stage says "devices API the page can fetch" — name the endpoint (`/api/devices`) and the booted-only filter, so the drill has a concrete check. Trivial plan edit.

### F7 — LOW: Baguette path resolution config name invents a file

Plan says "`~/.alloy/baguette.json {baguettePath}`" — that file doesn't exist today (the alloy config pattern is `~/.alloy/crucible.json` with `alloyPath`). Either reuse `~/.alloy/crucible.json` with a new `baguettePath` key (one config file for tool paths — fits the existing pattern) or drop the config tier. Name the exact file+key in the plan.

## Questions for the operator

1. **F1 carrier** — variant-only pins this round (smaller), or the guarded `templates.network_profile` column for case-level pins (matches your "case/variant" wording, one column)? Recommend (b) column: the case-level pin is the natural home ("this case tests slow-network behavior") and the cost is one guarded ALTER.

## Required plan edits

- F1: name the storage carrier (or cut case-level to variants-only).
- F2: unpinned-run-must-not-clear rule + test.
- F3: precise per-udid isolation wording + the two-lane test.
- F4: status parse is best-effort display; exit codes are the contract.
- F5: batch lane → named skip, not batch abort.
- F6: `/api/devices` + booted filter.
- F7: `~/.alloy/crucible.json` `baguettePath` key (or drop tier).

## Verdict (rev 2 update, 2026-09-28)

Operator resolved F1: **variant-only pins** (no `templates.network_profile` column; carrier = variants_json). All seven findings applied to `plans/20260928T153608Z-network-conditioner-plan.md` rev 2 — F1 (variant-only grammar + carrier named), F2 (unpinned-run-touches-nothing rule + test), F3 (per-udid isolation wording + two-lane test), F4 (status = best-effort display, exit codes the contract), F5 (batch lane named-skip), F6 (`/api/devices` booted filter), F7 (`~/.alloy/crucible.json` `baguettePath` key). **Revised verdict: Ready for implementation.**

## What remains to validate during implementation

Execution-level: the live drill (set→status→clear on 30B28173; a `network: edge` case play incl. abort-mid-run clear), CI, and Baguette-side behavior under a running app (the ~100ms pickup claim is doc'd, not tested by us).
