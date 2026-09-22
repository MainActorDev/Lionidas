## Variant A — verdict-first

### Design stance
The health word owns the page top: a large left verdict block + stat grid, everything else flows below in one column.

### Key choices
- Layout: hero (verdict block + 2×2 stat grid) → attention → coverage → latest runs, single column
- The verdict word is the biggest element on the page; delta/build context rides under it
- Attention rows are full-width with kind label inline

### Trade-offs
- Strong at: one-glance build answer; reads top-to-bottom like a sentence; simplest possible structure
- Weak at: attention list can push coverage/latest far down the page on busy days; hero eats vertical space

### Best for
"Is the build safe?" as the dominant daily question — verdict first, drill-down second.
