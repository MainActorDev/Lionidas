## Option 2 — Drawer editor

### Stance
Same parity table as option 1 (header, glyphs, columns, row anatomy — identical). The edit
surface changes: clicking a suite slides a **right-side drawer** over the table instead of
expanding inline. Table stays put; the drawer owns editing exclusively.

### The modification
Drawer = full-height panel: name/description fields, locked bundle field, ordered member rows
with the same `[case ▾][chips][↑↓✕]` anatomy, save/abort footer. Scrim click closes.
The row you're editing tints ember so the target is never lost under the drawer.

### Trade-offs
+ Table never reflows — scanning other suites while editing is uninterrupted
+ Roomier surface for long member lists (drawer scrolls independently)
− Introduces an overlay pattern the cases page doesn't use (the artifact modal is the only precedent)
− Keyboard/screen-reader flow jumps out of the table into the drawer

### Best for
Suites with many members, or when you edit one suite while watching the others.
