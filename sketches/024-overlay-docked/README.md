## Variant: C — floating dock over the seam

### Design stance
A floating panel anchored at the top of the seam between stage and rail — wider than the rail (340px), max-height 70% — *hovering* over both, watcher still peeking below.

### Key choices
- Layout: absolutely positioned card at the stage/rail seam, drops in with a 180ms fade
- Chrome: bordered card with real shadow (the only shadowed surface — signals "supplementary, temporary")
- Dismissal: ✕; one-at-a-time by construction (single slot)

### Trade-offs
- Strong at: width free of rail constraints (inspect tree breathes), watcher visible underneath, feels like a proper inspector popover (Xcode-ish)
- Weak at: occludes part of the stage (bezel edge) while open; two "floating" surfaces (modal pickers + this) can stack visually; strongest departure from the terminal-flat aesthetic

### Best for
Dense supplementary content — the inspect element tree — where 320px is genuinely tight.
