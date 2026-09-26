# Is the YAML compiler solid? — audit brainstorm

- Source prompt: "Is the YAML compiler solid right now?"
- Created: 2026-09-26T09:57:08Z
- Status: Fact-checked — risk #1 confirmed REAL (ensure-logout destroyed on YAML save, fixed b65dff2); remaining risks stand

## Goal and context

The user asks for a solidity assessment of the case-YAML compiler (`shared/src/case-yaml.ts`, 641 lines: parse/validate + serialize). Recent history: the `point: [undefined, undefined]` emit bug (fixed `15c1d00`), the `when`-on-steps setup-only rule, selector-only taps, `ensure logout` verb — the grammar has grown fast, each addition landing with focused tests but no systematic audit.

## Confirmed facts (measured/read 2026-09-26)

- 56/56 case-yaml tests pass; full suite 982/982.
- 47 of the validator's error pushes report `line: 1` — a documented approximation (`lineOf` is a stub returning 1; real per-step lines only exist for map-shaped steps via `parseDocument`).
- Parse (`parseCaseYaml`) and emit (`caseToYaml`) are separate hand-written functions — round-trip fidelity is enforced only by whatever tests happen to cover each shape.
- Five `JSON.parse` sites on steps_json/setup_json exist in routes (template save path) — parse failures there return generic errors, not YAML-shaped ones.
- The storage format (steps_json) and the YAML are two grammars kept in sync by hand.

## Exploration — known weak spots, ranked by risk

1. **Round-trip gaps (highest).** Every construct must survive YAML → steps_json → YAML. Verified this session for: selector-only tap, point+selector, optional, ensure-logout, expect contains. NOT verified: `at:` probe points on expects, `count`/`atLeast` cardinality, `runFlow` name refs, `alert`, `location`, `swap`/`world` variants, `expect screen` negate form, setup `when` guards combined with optional. Any emit gap resurfaces as `undefined` in YAML (the exact bug class just fixed).
2. **Line numbers are mostly fake.** 47 error sites say `line: 1`. For the split-panel editor UX this means "error somewhere" — users scan the whole doc. Fixable via the CST ranges the lib already exposes (the code comments admit the approximation).
3. **Two-sources-of-truth drift.** steps_json ↔ YAML grammar duplication: today they agree; every new verb must update parse, emit, AND the storage consumers. The `setup_json='null'`-string crash (swallowed as run-abort, 2026-09-26) is the shape of failure when the boundary is loose.
4. **Error taxonomy is strings, not codes.** The UI can style/pattern errors only by message text. A code per error class (like run_steps) would make the editor able to offer fixes (e.g. "drop point", "move when to setup").
5. **Unknown-key hygiene is partial.** `known` lists exist per action family; new keys (the ones we added: `stay`, `button`, `confirm`, `at` on tap?) must be manually appended or users get spurious "unknown key" errors — or worse, typos pass silently where lists lag.

## Proposed audit (smallest useful next step)

A **property round-trip test**: for every action×modifier combination the grammar admits, generate the steps_json, emit YAML, re-parse, assert deep-equal. One table-driven suite closes risk #1 wholesale and turns any future emit gap into a red test instead of a `undefined` in the editor. ~1-2 hours, no behavior change.

Then (separate, optional): real line numbers via CST (UX win), error codes (taxonomy), and a single schema table driving parse+emit (structural fix for drift).

## Open questions

1. Is the round-trip property test wanted now, or is the current 56-test coverage judged sufficient until the next grammar change?
2. Line numbers: worth the CST work, or is `line: 1` acceptable since errors carry step indices in the message text?

## Next step

Operator picks: (a) round-trip property suite now (recommended), (b) full audit + all four fixes, (c) leave as-is and harden on demand.
