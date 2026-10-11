# 032 C — guided runs (agent-in-cases-page)

## Variant: a wizard above the cases list — control shape

### Design stance
No chat surface at all (control variant isolates whether CHAT is the fix): a step panel above the existing cases list — refs → knowledge status → planner question answered inline → drafts land IN the list live. Structure alone carries the flow.

### Key choices
- Layout: step panel (numbered circles 1-2-3) + the normal list; drafts enter as ember-bordered rows with provenance (`· agent draft · wfr_…`)
- The question is a step, answered in a single input — no transcript
- Draft rows are reviewable in place (same page, same columns)

### Trade-offs
- Strong at: smallest build; zero new surface; agent output lands exactly where it's consumed; review-in-context
- Weak at: no conversation (follow-ups, "also cover X" impossible); only one flow (author pipeline); no run history home

### Best for
Shipping agent value fast without a chat surface — and an honest test of whether chat earns its complexity.
