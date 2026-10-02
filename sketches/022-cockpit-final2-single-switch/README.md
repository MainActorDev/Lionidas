## Variant: Final2 — one spacious device + switcher

### Design stance
Show ONE device at a time, large and centered; a switcher tab strip moves BOTH view and control between devices. Chosen over the 3-split after operator review ("only show a device so it's spacious — but we can switch").

### Key choices
- T1 menu bar unchanged (file/device/app/environment/run/view + status)
- Switcher strip: one tab per device with live-state sublabels (session · world-sg / run 4/7 / idle); active tab outlined in ember; ember dot = has live activity
- Stage: single bezel (340×680), session chip + screen-state chip; control follows the active tab (single manual-lease model)
- Rail tabs watch|chat unchanged — reusable component; all rail data rebinds to the active device (rail meta honest: 'no session' when idle)

### Trade-offs
- Strong at: spacious device, unambiguous control, simpler stream bandwidth (one full stream)
- Weak at: no side-by-side visual comparison (accepted — the operator chose focus over compare; compare can return as a picture-in-picture later)
- Verified: switching updates status bar, rail meta, state chip, session chip, chat context footer; vision pass — "spacious, focused, far less cramped"; the idle/live semantic mismatch vision caught is fixed (rail meta follows state).
