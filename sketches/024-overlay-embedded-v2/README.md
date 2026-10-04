## Variant: embedded rail — v2, redesigned panel content

### Design stance
Same container decision as v1-A (overlay card inside the rail column), but the two panels get real information design instead of bare lists.

### The reusable container
Icon + UPPERCASE title + status badge + ✕. One panel at a time by construction. The rail's watch/chat tabs stay visible but dimmed under the overlay — you always know what you'll return to.

### Environment panel redesign
- **Live strip**: pulsing dot + "shaping lp1042-payment-error" — the first line answers "what world is the device in right now?"
- **Scenario cards** instead of bare radio rows: name + tag (payments/geo) + one plain-English line of what the scenario actually does to traffic ("POST /v2/payments → 502 · 3s delay — checkout fails with retryable state")
- Active card: ember border + filled radio; footer keeps clear-scenario + hints that chat sees the active scenario

### Inspect panel redesign
- **State strip** (aligned · picking live · session chip) replaces the old floating state label
- Breadcrumb → compact tree (selected in ember, label excerpts) → detail:
  - Identity as `<Button> btn_quote_cta` + quoted label + hittable chip
  - **Geometry as a 4-cell grid** (x/y/w/h) instead of stacked rows
  - Paint rows with **color swatches** and hex + font weight
  - Selector in a dark code box, value highlighted, "click to copy" affordance
  - Actions row: ember **tap** primary + copy selector + copy spec
- The bezel keeps the live selection ring (numbered) while inspect is open

### Trade-offs
- Strong at: both panels answer their question in the first 2 lines; density without clutter; matches LP evidence-capture vocabulary
- Weak at: scenario descriptions must be authored (server has presets; descriptions come from preset metadata — short generic fallback if absent)
