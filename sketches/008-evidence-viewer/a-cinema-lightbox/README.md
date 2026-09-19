## Variant A: Cinema lightbox

### Design stance
The evidence IS the show: media owns every pixel between a thin header and a thin rail; navigation lives in the rail, chrome at the edges.

### Key choices
- Layout: full-viewport overlay, 3-row grid (head / stage / rail) — portrait shot gets maximum height (the thing today's 560px card starves)
- Lanes: one row of quiet mono chips in the bottom rail (status dot per lane), steps as a horizontal thumbnail strip — lane and step navigation in ONE place
- Ember accent only on: active lane chip, selected step chip, and a 1px frame on the shot. Everything else is iron/ash
- Keyboard-first: ←/→ steps, ↑/↓ lanes, esc closes (legend in header)
- Video = one more chip at the end of the strip (▶), same rail

### Trade-offs
- Strong at: big readable shots, fast keyboard walk-through of all worlds, no table context needed
- Weak at: comparing two worlds side-by-side (one world at a time); 7 lanes makes the chip row wrap

### Best for
Reviewing one case's evidence deeply — the QA "did every world actually pass?" ritual.
