## Variant: Scope inspector

### Design stance
Master-detail: scope tree on the left (global / apps / plans with counts), the selected scope's vars on the right, and a persistent bottom editor pane — inspect one scope deeply at a time.

### Key choices
- Layout: left scope tree (250px) / right list + always-open editor panel below
- Resolution line: a context bar showing which global keys the selected app overrides
- Add: bottom bar, scope inherited from the tree selection
- Edit: inline bottom editor (no modal) — value + note + delete in one place

### Trade-offs
- Strong at: scales to many apps/plans without page growth; editor always visible = fastest edit loop; the override summary teaches the resolution chain
- Weak at: one scope at a time — cross-scope key audit needs hopping; two-pane layout is heavier than the page probably needs today (4 scopes, ~6 vars)

### Best for
The future state — many bundles, many plans, frequent credential rotation. Over-built for today's size, right-built for growth.
