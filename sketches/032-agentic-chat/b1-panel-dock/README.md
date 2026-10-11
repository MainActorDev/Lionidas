# 032 B1 — panel dock (a3-2 with collapse)

## Variant: the picked artifacts-split, collapsible

### Design stance
Identical to the picked a3-2, plus the panel respects the times there's no run to watch: close it (») and it slides away (width→0, 240ms); while a run is live, a floating ember pill ("● run live — open panel") keeps the thread full-width and the state one click away.

### Working interactions
» collapses the panel; the floating pill reopens it; everything from a3-2 still works (tabs, answer, author ✓).

### Trade-offs
Strong: the split when you want it, the full thread when you don't. Weak: one more control; the collapse state needs remembering per user.
