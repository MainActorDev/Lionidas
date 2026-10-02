## Variant A — skeleton scan

### Design stance
The screen already knows what it will become: app-shaped placeholder blocks (nav, hero card, rows, grid, tab bar) with a single light band sweeping across them — the classic skeleton loader, tuned to the Axiom palette.

### Key choices
- Layout: 9 graphite blocks mirroring a real app layout at phone proportions
- Motion: one 105° diagonal gradient band traversing all blocks in one 1.8s ease (background-position sweep, GPU-cheap)
- Color: graphite blocks on void; band peaks at 12% paper
- Status: none — the shapes themselves communicate progress

### Trade-offs
- Strong at: instantly readable as "content loading"; preserves layout space so there's no jump when the stream lands
- Weak at: presumes an app layout (our stream can land on any screen); busiest of the three

### Best for
Operators who want maximum "it's working" signal and don't mind decorative structure.

### Integration note
Renders as an absolutely-positioned layer inside `.bezel-screen` shown when `stream.state` is `connecting | reconnecting`; blocks sized by % so they scale with zoom.
