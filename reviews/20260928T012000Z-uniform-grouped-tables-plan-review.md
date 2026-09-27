# Review — uniform grouped tables plan

- Reviewed plan: `plans/20260928T012000Z-uniform-grouped-tables-plan.md` (Ready, 2026-09-28T01:35:00Z)
- Evidence: plan + brainstorm rev 2; TestCasesPage.vue (a2-group-head scoped block), SuitesPage.vue:292-461 (su-table; header actions), EnvPage.vue:45/199-266 (scope-block/openSections/toggleSec), ScreensPage.vue:426+ (section-label bundle-row + actions); PageHeader.vue shared
- Verdict: **Ready for implementation** — findings folded below; no operator questions.

## Findings

### F1 — Medium · EnvPage already HAS collapse semantics with its own state
The plan says "reusing its existing collapse Set/keys" — correct, but EnvPage's heads also carry INLINE ACTIONS (+ var) inside the head. Adopting `.a2-group-head` must keep those actions clickable (the head's click-to-collapse will swallow them without @click.stop on the action buttons). Folded into stage 4: every in-head action gets @click.stop.
### F2 — Medium · the sticky-thead claim vs suites' expanded-row editors
SuitesPage rows expand into preview/edit panels INSIDE the table (inline editor idiom). Group heads between rows are fine (test cases proved it with its editor), but thead stickiness with grid `1 / -1` heads is already handled in the reference — no new risk. No edit needed; noting the drill must open a suite editor under a head to prove it.
### F3 — Low · screens' header actions live ON the bundle head
ScreensPage's `+ screen`/`yaml`/`login flow` are per-bundle head actions (not page header) — they must survive the head restyle with stopPropagation (same class of fix as F1). Folded into stage 3.
### F4 — Low · "header navbar buttons" scope
Operator's added requirement is read as: PageHeader action buttons on suites/screens/env match test-cases' rhythm (classes/size/order). Screens/env already use `.btn`; the audit in stage 5 (grep page-scoped `.btn` overrides) covers drift. No further decisions needed.

## Traceability
All four operator answers → stages (env all-scope restyle → 4; suite count → 2; no persistence → all; header buttons → 5). Extraction-last order preserved (stage 1 first here deliberately: the class must exist before the other pages adopt it — plan order is extraction FIRST then pages; correct).
