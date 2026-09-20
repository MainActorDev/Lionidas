# 011 — /suites parity redesign

**Ask (user):** the `/suites` page should use the same UI as test cases, with a slight
modification/difference — familiar beats novel.

**Shared DNA (all options):** the test-cases anatomy — one-row header (title · count ·
summary glyphs · `⌘F` search · `+ new` · `▶ run filtered`), sticky column header
(`suite · bundle · members · updated · trend · verdict · actions`), row-cards with the
same typography and status system (✓ ◆ ✕ ◌), same button styles.

**The one axis that varies — where editing lives:**

| option | edit surface | notes |
|---|---|---|
| 1 — inline editor | expands below the clicked row | the yaml-panel motion, verbatim |
| 2 — drawer | right-side overlay panel | table never reflows |
| 3 — grouped rows | read-expand inline + deliberate edit | bundle bands tell the scoping story |

All three keep: variant chips (multi-toggle), case dropdowns (single-select), bundle scope
locked at creation, drift surfaced per member.

Open any `index.html` in a browser. Data is the live DB's real shape (2 suites, 2 bundles,
1 drifted member, 1 failing lane).
