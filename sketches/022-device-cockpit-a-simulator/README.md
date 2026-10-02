## Variant: A — Simulator.app stance

### Design stance
The canvas dominates; everything else is a slim toolbar or an on-demand drawer. Maximum device, minimum chrome.

### Key choices
- Layout: top device-bar + one toolbar row + bottom watch bar; drawers slide over the stage from either edge
- Device: centered bezel, ~340×700, session chip on the stream
- Controls grouped by domain in the toolbar (drive / capture / device / app / environment)
- Watchers live in a right drawer opened from the bottom bar — invisible until wanted

### Trade-offs
- Strong at: biggest possible device, zero distraction, familiar Simulator.app feel
- Weak at: watchers are hidden by default (two clicks to see traffic); toolbar crowding as capabilities grow

### Best for
Hands-on manual driving where the screen IS the work; occasional checks.
