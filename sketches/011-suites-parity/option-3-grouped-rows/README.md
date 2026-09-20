## Option 3 — Bundle-grouped table with expandable members

### Stance
Same parity table, but the table itself tells the bundle story: suites grouped under
**bundle band headers** (icon + bundle id + "+ suite in this bundle"), and each suite row
**expands to reveal its member cases as read-only sub-rows** — the same inline-below-the-row
motion as the yaml panel, minus the editing.

### The modification
- Band headers replace the rail's bundle grouping — the page reads as "apps → packs"
- Member sub-rows show per-member verdict + variant subset + drift flag at a glance
- `edit` opens the member editor (the same panel anatomy from options 1/2) — expansion is for
  READING, editing stays a deliberate act

### Trade-offs
+ The whole hierarchy is visible without touching an editor — best at-a-glance density
+ Bundle scoping is self-explanatory: bands make the invariant visible
− Two expansion concepts (read-expand vs edit-panel) — slightly more to learn than option 1
− Band headers add vertical rhythm; with many bundles the page gets taller

### Best for
Browsing/monitoring first, editing second — the "wall" reading of suites.
