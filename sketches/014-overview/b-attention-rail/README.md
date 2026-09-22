## Variant B — attention-rail

### Design stance
A compact verdict strip, then the page becomes a workspace: grouped attention rail LEFT (the work queue), detail/coverage side panel RIGHT.

### Key choices
- Layout: thin verdict strip → two-column grid (rail 3fr / side 2fr), side is sticky
- Attention grouped with headers (recurring · 1, infra · 3, stale · 0) — the grouping IS the triage order
- Selected row gets an ember inset; side panel shows the drill-down facts (run link, build, tag)

### Trade-offs
- Strong at: triage workflow — pick a row, facts appear beside it; grouped counts answer "how bad is it" instantly
- Weak at: verdict is smaller; two columns cost horizontal room on narrow screens; more moving parts to build

### Best for
Days with real failure lists — the overview as a work queue, not a dashboard.
