## Variant B — aurora veil

### Design stance
No fake content — two soft light veils (cool paper-white, warm ember) drift slowly behind smoked glass with a fine scanline texture. Calm and premium; says "waking up", not "painting a layout".

### Key choices
- Layout: zero structure — 2 blurred radial veils (38px blur, ~14% opacity) + repeating 1px scanlines
- Motion: two independent 5–7s alternate drifts (translate/rotate/scale) — never synchronous, never frantic
- Color: paper + ember at whisper opacity on void; a breathing "stream connecting" caption
- Status: centered bottom caption with breathing ember word

### Trade-offs
- Strong at: elegant at any duration (short or 10s+); content-agnostic; cheapest to read
- Weak at: least informative — no sense of *what* is loading or how far along

### Best for
The spacious single-device cockpit aesthetic; premium feel during reconnects.

### Integration note
Single overlay div per veil + one `::after` scanline layer; pauses via `prefers-reduced-motion` (falls back to the static breathing caption).
