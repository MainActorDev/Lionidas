# Acceptance Criteria in Gherkin — making test cases human-reasonable

- Source prompt: "Right now, for testcases it's all about the YAML. The only concern of it is it's not descriptive. Each test cases just executes specific steps but it's hard for human user to reason about what each steps are doing. The idea is I want to introduce Acceptance Criteria description in Gherkin format. Brainstorm how we can add this." (invoked with /hms-brainstorm-rough-ideas)
- Created: 2026-09-29T03:07:22Z
- Status: Exploring

## Goal and context

Cases today are pure execution grammar — `tap {identifier}, expect {identifier}` — machine-perfect but narratively opaque. A human scanning the tnc (logged-in) case sees `ic_tabbar_account_inactive → account_legal_terms_row → legal_doc_terms_screen` and must reverse-engineer intent. The operator wants **Acceptance Criteria in Gherkin** (Given/When/Then) so a case also states, in human language, what it accepts. Interpretation: Gherkin is a DESCRIPTION layer that travels with the case (docs, review, audit, future agent authoring) — not a new execution engine unless the operator says otherwise.

## Confirmed inputs and decisions

- User-confirmed: the problem (steps not descriptive / hard to reason about), the direction (Gherkin AC), the request (brainstorm how to add it).
- Verified facts (2026-09-28/29):
  - `templates` already carries a `description` TEXT column (schema.ts:465) — currently unused by the case yaml (caseToYaml emits name/tags/app/folder/alerts/variants/entry/steps; no description). Other tables (scenarios, suites?) use theirs.
  - The case yaml round-trip (parseCaseYaml/caseToYaml) is the single document surface; steps carry no per-step narration field today.
  - Step `when:` exists as a conditional qualifier, not prose.
  - User profile standing rule: "TICKETS: FDB sections EARN place… AC behavior-level" — AC is already the operator's native review vocabulary (Jira-side today).
  - North-star (memory): the registry+grammar will be consumed by a future AI agent authoring cases — a Gherkin layer is exactly the artifact an agent can write/verify against.

## Exploration

### The core question: where do Gherkin AC live, and are they linked to steps?

**Option A — AC block in the case document (description layer)**
A `criteria:` (or `acceptance:`) top-key in the case yaml holding a Gherkin block:
```yaml
name: tnc (logged-in)
criteria: |
  Given I am logged in
  When I open the account tab and tap Terms & conditions
  Then the terms document screen is shown
steps: …
```
Stored in the existing `description` column (guarded, zero schema change) or a dedicated column; rendered in the editor (a criteria pane/field) and the run report header. No execution semantics — steps remain truth, criteria are the human contract.
- Strong: smallest honest step; pure documentation; agent-authorable; zero execution risk; answers "what does this case accept" on every surface (list preview, run detail, export).
- Weak: nothing keeps criteria and steps in sync (drift risk — the yaml says one thing, steps do another).

**Option B — per-step Gherkin fragments (intent column)**
Each step gains a `narrate:`/`intent:` field ("open the account tab"); the editor renders the case as interleaved prose+steps.
- Strong: kills the reasoning problem at the exact point of confusion (per-step); drift is local and visible.
- Weak: verbose yaml; not Gherkin (the operator asked Gherkin); Given/When/Then structure doesn't map 1:1 to steps (setup steps = Given, first actions = When, expects = Then, but multi-phase cases blur).

**Option C — full BDD: Gherkin AS the executable spec**
Steps derive from Gherkin lines; the runner maps Then-clauses to expects. The TestRail-class heavy road.
- Strong: drift impossible (one document).
- Weak: a new execution engine — contradicts the settled machine-rulebook direction (yaml steps with identifiers are the executable truth); enormous build; loses the proven step grammar.

**Drift mitigation (applies to A)**: an optional coverage hint — the editor shows the Gherkin keywords beside the step list (Given≈setup/ensure steps, When≈taps/types, Then≈expects) as a visual pairing aid, without enforcing anything. Cheap, honest, keeps description-layer status.

### Recommended direction (proposal)

**A, with the drift-mitigation pairing view.** The case document gains `criteria:` (Gherkin prose, stored in `description` — the column already exists); the CaseEditorPanel grows a criteria field (form left, beside name; also editable in yaml with round-trip); the run detail + case list preview render it; export carries it. A later stage (only if wanted) adds the pairing aid. This matches "AC behavior-level" review culture, costs no execution risk, and gives the future agent author a human-language contract to target.

### Surfaces touched (for the plan)

- shared case-yaml: parse/emit `criteria:` (multi-line literal block, Gherkin-shaped soft validation — warn, not reject, on non-Gherkin content)
- editor: criteria textarea (mono, Given/When/Then hint) + yaml round-trip
- list row preview + run detail header: first line (`When …`) as the human gist
- export/import: rides the yaml automatically
- templates.description as storage (verify the column is truly free; else guarded ALTER)

## Open questions

1. **Linkage appetite** — description-only (A), or do you want the per-step intent layer too (B) at some point?
2. **Validation strictness** — should non-Gherkin `criteria:` text be rejected, warned, or accepted silently? (Recommend: warn only.)
3. **Field name** — `criteria:` / `acceptance:` / `gherkin:`? (Recommend `criteria:` — matches your FDB vocabulary "AC".)

## Decisions log

- 2026-09-29 user (chat): **per-step Gherkin, but OPTIONAL** — "It is per step but perhaps optional. I just want the AC to be rendered when we run a test case."
- 2026-09-29 user (chat, implied by the same message): the RENDER target is the RUN — AC must appear in run output (run detail / run panel), not just the editor. This reshapes the direction: **B-flavored** — steps carry an optional `narrate:`-style Gherkin fragment; at run time, the step stream renders the AC (Given/When/Then lines interleaved with step execution in the run panel + persisted for the run detail).
- Agent interpretation (flag if wrong): each step may carry an OPTIONAL Gherkin line; steps without one render as today. A step-level Given/When/Then keyword rides the step, e.g. `narrate: Given I am logged in` on the ensure-login setup step, `Then the terms document is shown` on the expect. No case-level block (A) unless wanted as a summary later; validation: warn-not-reject on non-Gherkin text; field name to confirm (`narrate:` vs `criteria:` per step).

## Next step

Confirm the interpretation + field name → plan: step grammar gains optional `narrate:` (case-yaml parse/emit + round-trip), run-time rendering (RunPanel step stream shows the AC line above/beside each narrated step; run detail persists it via run_steps), editor affordance (optional per-step field in the yaml + a compact form hint). Drill on tnc (logged-in) with real AC lines.
