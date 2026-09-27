# Branching test cases by UI state — "if/else" for logged-in vs logged-out paths

- Source prompt: "regarding the privacy policy and tnc test cases, currently they 'only' work for non-login flow. Meanwhile, when logged in, when tapped the Account tab bar, there are also privacy and tnc that we can open. What if we're implementing an 'if else' for the test case for this kind of case? While still maintain the speed"
- Created: 2026-09-26T10:27:00Z
- Status: Exploring

## Goal and context

Both legal-doc cases currently end with the logged-OUT flow (Account tab → Sign Up → disclaimer link). When a session exists, the same documents are reachable from the logged-IN Account screen (Legal & policies rows: "Terms & conditions", "Privacy policy" — AccountFeature.swift:26-33). The user proposes case-level branching (if/else) so one case covers both session states, without paying the speed built this arc.

## Confirmed inputs and decisions

Verified facts (2026-09-26):
- Logged-out path works end-to-end: pp (`run_1ff37d8e`, 7/7) and tnc (`run_30079c57`, 5/5), identifier/label selectors, no coordinates.
- `ensure logout` setup verb exists and no-ops in 0.08s when logged out; the full logged-in walk (button → sheet → verified gone) is implemented but not yet live-drilled (needs a real session on a drill sim).
- Logged-in Account exposes "Terms & conditions" / "Privacy policy" rows (title-only, no identifiers yet).
- Existing grammar conditionals: `when:` guards (setup-only, skip-if-absent, one-shot), `optional: true` (skip-on-miss), `ensureLogout` (self-normalizing setup verb). There is NO if/else construct today.

## Exploration — options for "one case, both states"

### Option 1 — Self-normalizing setup (extend the existing pattern) — RECOMMENDED

Invert the problem: instead of branching mid-case, the SETUP normalizes state so the steps never branch. We already do this with `ensure logout`. The symmetric verb is `ensure logged-out OR use the logged-in entry`… but the honest version is simpler: the case declares which flow it tests, and setup enforces it. For coverage of BOTH states, use TWO variants of one case (the variant system exists: variants share steps_json with different env/scenario — but steps differ here, so variants don't fit; two small cases or runFlows do).

- Speed: unchanged (setup no-op 0.08s when already in the target state).
- Grammar: zero new constructs. Two cases: `pp (logged-out)` and `pp (logged-in)` — the logged-in one's setup does nothing (or `ensure login` someday), steps tap the Legal row directly.
- Cost: a little duplication; the login state itself has no seam yet (no credentials in CI) — the real blocker for ANY logged-in case.

### Option 2 — First-class `if:` branching steps

Grammar: `if: { shows: <label>, then: [steps], else: [steps] }` (or a `group` with a condition). The engine snapshots once, picks a branch, executes.

- Pros: one case covers both; reads naturally for the Account screen case.
- Cons: new grammar in parse+emit+engine (+ the round-trip suite), nested step indices (evidence/reporting need sub-indices), branch coverage becomes invisible per run (a green run only proves the branch it took — you'd need BOTH states anyway to prove both branches). This is the XCUITest-`skip-if` trap: conditionals feel like coverage but halve it per run.
- Speed: one extra snapshot at the branch point (~0.1-0.3s) — fine.

### Option 3 — `when:`-style guarded step pairs (poor man's if/else)

Both paths as consecutive steps, each `when:`-guarded on a state marker (e.g. the Sign Up button vs the profile card). Wrong branch's steps skip.

- Pros: almost no grammar change (extend `when:` to steps? it's setup-only today).
- Cons: steps always run "in order" semantics get muddy; the skip rows pollute the report; extending `when:` to steps reopens the grammar rule we deliberately set (validator rejects it today).

### The speed question (all options)

Branching itself costs ~one snapshot. The REAL speed risk is the logged-in path's own steps — none of which exist yet. Nothing in this arc's optimizations is lost by any option; the quiet window, Link last-line aim, and selector-only taps all apply to both flows.

## Recommendation (proposal, not accepted)

Option 1 (self-normalizing + two cases) for now: zero grammar growth, honest coverage accounting (each case's runs prove exactly what its steps say), and it matches how `ensure logout` already works. Revisit Option 2 only if logged-in/logged-out pairs proliferate across screens and the duplication hurts — at which point the branch construct pays for itself. The immediate blocker for ANY logged-in coverage is a login seam (seeded credentials or an `ensure login` verb against a test account) — worth deciding before any grammar work.

## Open questions

1. Is there (or can there be) a stable test account + login seam for drills — without which logged-in cases can't run at all regardless of grammar? (Blocks everything logged-in.)
2. Coverage intent: do you want BOTH states proven per case (two runs), or is "whichever state the sim is in" acceptable? (Determines whether if/else even helps.)
3. If branching is still wanted: `if/else` groups (Option 2) vs `when:`-on-steps (Option 3) — I recommend against 3.

## Next step

Answer Q1 (login seam) — if it exists, I add the logged-in twin cases (tap Legal rows by label) alongside the current ones, both under the existing grammar; if/else grammar becomes a separate decision with real usage to justify it.
