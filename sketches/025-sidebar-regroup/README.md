# 025 — sidebar regroup

Revamp of the app-shell sidebar (`web/src/App.vue` nav) — regroup the 11
destinations for better hierarchy; nesting allowed.

**Shared taxonomy across all variants** (the round's real variable is the
nesting mechanism, not the grouping):

| group | items |
|---|---|
| testing | overview, suites, runs, devices |
| library | test cases, screens, env, network |
| system | monitoring, users, guide |

Kills today's three single-item groups (`access`, `network`, `help`) and the
`network/network` label duplication.

## Variants

| dir | stance |
|---|---|
| `a-collapsible-tree/` | 3 groups as caret-collapsible sections (house `.a2-group-head` idiom), children indented 30px |
| `b-index-flyout/` | rail shows overview + 3 group heads only; children fly out on hover (graphite panel), ember marker shows the active child's group |
| `c-flat-merged/` | control — same taxonomy, no nesting; tests whether regrouping alone is enough |

All three link the round's shared `../tokens.css` (verbatim copy of
`web/src/styles/tokens.css`) — one palette, Axiom idioms (2px corners, hairline
iron borders, mono, ember accent, 220px rail).

## Notes

- `run detail`, `cockpit`, `matrix`, `login` stay out of the nav (unchanged from
  today: cockpit is wall-entered, matrix is deep-link only).
- Serve: `python3 -m http.server 8791` from `sketches/` →
  `http://localhost:8791/025-sidebar-regroup/<variant>/`
- Brainstorm: `brainstorm/20261005T035716Z-sidebar-regroup.md`
