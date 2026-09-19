## Option 1 — Sidebar + detail board

### Stance
Suites are a PLACE: a dedicated `/suites` surface — list left, detail board right. Mirrors the app's
sidebar-nav mental model (devices, cases, runs… suites).

### Key choices
- Left rail: every suite with inline rollup (`2 pass · 1 fail · 1 never`), `+ new` in the header
- Detail board: name/description, rollup KPI line, ordered member rows with per-variant chips
  (`all 3 · sg my empty` dashed = default-all; solid = pinned subset), per-variant trend squares
- Run button in the board header; edit members + suite-runs links in the footer
- **Collision:** home's button → `▶ run all cases`; the word "suite" moves here. Sidebar gains `/suites`

### Trade-offs
+ Room to grow (filters, sorting, suite runs history on the same board)
+ Separation of concerns — home stays the all-cases health board
− One more page + nav entry; the two surfaces (home board vs suite board) render similar member/verdict rows
− Switching suites leaves the page you were on

### Best for
Many suites treated as first-class long-lived artifacts (nightly, per-app, per-release trains).
