## Variant: A2 · split panel, viewport-locked (the many-cases refinement of A)

### Design stance
Keep A's "stay in context" but make it scale: when the panel opens, the page locks into three regions — header / table (scrolls inside itself, ~34vh) / anchored YAML panel filling the rest. List length stops mattering.

### Key choices
- Layout: `100vh` flex column; table region has its own scrollbar + sticky header; panel is `flex: 1` (never moves)
- The edited row highlights (ember left-border) and `scrollIntoView`s inside the table region — always visible without hunting
- ‹ › case hopper in the panel header: move through cases in filter order WITHOUT leaving the editor ("17 / 214")
- ⌘F search box jumps the table; close (esc) restores normal page scroll

### Trade-offs
- Strong at: any list size; the editor never jumps; hopping cases is one keystroke
- Weak at: table shows fewer rows while editing (~6-8 at 34vh); one extra layout mode to reason about (open vs closed)

### Best for
The real world — suites grow; this is A with the assumption "the list fits" removed.
