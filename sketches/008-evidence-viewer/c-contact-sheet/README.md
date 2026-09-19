## Variant C: Contact sheet

### Design stance
Film contact sheet: EVERY world's evidence visible at once as grouped thumbnail rows — overview is the interface, detail one click deeper.

### Key choices
- Layout: full-page takeover (no drawer/modal), header + lane filter pills + scrollable grouped grid
- Lanes: GROUP ROWS — lane header (name · env · run · status · counts) with its shots as auto-fill contact cards underneath
- Failed lane/cards dashed-bordered; expect/fail stamped on the thumbnail
- Video is one more card (▶ whole run) — same grid, same click
- Filter pills jump between lanes (all / sg / my / empty / failed)
- Click a card → zooms into the per-world cinema view (layered, not sketched)

### Trade-offs
- Strong at: total visibility — all worlds, all steps, one glance; zero navigation to see everything; scales to many lanes × many steps
- Weak at: thumbnails are small (the actual pixels need the zoom-in step); full-page takeover loses table context

### Best for
Multi-variant triage and evidence review meetings — "show me everything this case produced."
