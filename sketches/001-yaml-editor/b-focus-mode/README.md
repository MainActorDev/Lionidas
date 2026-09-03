## Variant: B · focus mode (single-case immersion)

### Design stance
Editing YAML is writing code — give it the whole screen, dim the table behind, and add a stats rail instead of an outline column.

### Key choices
- Layout: near-fullscreen sheet over a dimmed+blurred table; editor ~840px wide + 260px rail (steps count, asserts, env refs, verdict, mini step list, keymap)
- Feedback: dirty dot ("● unsaved") in the header; ⌘↵ save; esc returns to the table
- Entry: row action opens the sheet

### Trade-offs
- Strong at: long cases (max vertical space, widest lines, no wrap); the rail gives case-level context the YAML itself doesn't show
- Weak at: one case at a time — comparing/editing two cases means esc, find row, reopen; heavier motion per edit

### Best for
Hand-authoring a new case from scratch, or surgery on one long case.
