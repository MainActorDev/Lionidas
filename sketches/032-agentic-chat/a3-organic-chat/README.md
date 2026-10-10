# 032 A3 — organic chat

## Variant: the conventional layout, softened — circles, glows, a serif voice

### Design stance
Same ChatGPT/Claude anatomy as A2 (operator direction stands), but explicitly OUT of the box-grid: the agent feature earns its own visual register while keeping the Axiom palette. Circles, pills, 14–24px radii, ember glow, a serif for the agent's voice — rectangles only where text needs them.

### What leaves the token box (and what stays)
- **Stays**: void/carbon/ember palette, mono type for UI text, hairline iron borders (as inset rings, not stroked boxes)
- **Leaves**: 2px corners → 14–24px + `999px` pills; flat surfaces → soft radial ember gradients + ambient page glow; one font → **Georgia serif for the agent's questions/brand voice** (mono stays for machine text); status "steppers" → a **flow of circular nodes** with a glowing current stage; buttons → pills with hover lift + glow shadows

### Key choices
- Pipeline = node-flow line (✓ circles done, ember-glow pulse on current) — state without dashboard chrome
- Question card: gradient ember wash + serif question + glowing focus ring
- Drafts: rounded stack with a 2px ember left-glow (validator ✓ shown)
- Composer: floating blurred pill-bar, focus glow; round send button
- Brand orb ("butler") instead of a wordmark box

### Trade-offs
- Strong at: the agent feels like a *presence*, not a tool; distinctive; still readable as chat on day one
- Weak at: departs from the house system (scoped to THIS feature by design); serif may read less "terminal" than the rest of the app

### Best for
The operator ask: conventional layout, allowed to breathe. This is A2 with a soul.
