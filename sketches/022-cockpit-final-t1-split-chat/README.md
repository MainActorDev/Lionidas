# 022-Final — Cockpit: T1 + split + chat + logs

## Design stance
The confirmed composition: T1 menu bar (word-menus + status right), 3-device split stage (watch all / control ONE — click a cell to take control), reusable right rail with **watch | chat** tabs, environment drawer from the menu. The AI chat lands here as a rail tab with device context visible ("agent sees what you see").

## Key choices
- Menu bar carries: file / device (layout switch + split add) / app / environment / run (quick-play) / view; status cluster right (session chip, active device, live count)
- Split: `auto-fit minmax(240px,1fr)` grid — 3-across at wide, wraps gracefully; active cell = ember border + CONTROLLED chip, others dimmed WATCH + "click to take control"
- Rail tabs: **watch** (session / run steps / logs tail / traffic) and **chat** (agent transcript, tool-call chips, device-context footer, composer)
- Logs: compact tail in the rail (active device), ember highlights on hits
- Env drawer opens from the environment menu's items (fixed a click-race in wiring)

## Verification
Browser-measured: cells all same row at 1280px, drawer not clipped (vision's clip note was a screenshot crop), control transfer + tab switching + menu→drawer all interactive. Vision critique: "composition is successful… neat, clean, and intuitive" — balance fix applied (3-across instead of 2×2-with-gap), secondary labels up-sized.

## Trade-offs
- Chat in a rail tab keeps the composition stable; full-height chat would need a drawer (future variant if wanted)
- 3-cell split at narrow widths wraps to 2+1 — acceptable; MAX 3 is the operator rule
