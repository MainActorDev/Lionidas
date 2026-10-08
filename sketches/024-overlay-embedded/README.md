## Variant: A — embedded overlay (rail-replacing card)

### Design stance
The overlay is a card *inside* the rail column: it covers the watcher completely while open, exactly the rail's width, and slides away to reveal watch/chat untouched.

### Key choices
- Layout: absolute inset panel within the rail column — zero layout shift, watcher state preserved underneath
- Chrome: uppercase mini-header + ✕, hairline border, soft left shadow for lift
- Motion: 180ms rise-in, reduced-motion honored
- Dismissal: ✕ or clicking the same menu item again

### Trade-offs
- Strong at: clear single-panel ownership (your spec, literally), stable width, watcher scroll position survives
- Weak at: hides the watcher entirely while open (no side-by-side glance), overlay width capped at rail width (320px — inspect's 25-node tree is tight)

### Best for
Supplementary panels you use in *bursts* — set a scenario, close, watch events resume.
