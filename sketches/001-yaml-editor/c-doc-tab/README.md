## Variant: C · dual view (a case is a document with tabs)

### Design stance
Promote the case to its own page with tabs: steps (structured editor), yaml (text editor), runs, plans — YAML becomes a first-class view, not an overlay.

### Key choices
- Layout: case header (name, tags, verdict pill, run/save) + tab bar; the mockup shows BOTH panes side-by-side to demonstrate they're the same data — in-app the tab switches between them (or a "split" toggle keeps both)
- Feedback: "✓ in sync" note — both panes render the same steps_json; the ● on the yaml tab = unsaved changes
- Entry: clicking a case row navigates to the case page (deeper change: the table becomes a list view)

### Trade-offs
- Strong at: clearest mental model (document + views); room to grow (runs tab already exists elsewhere; plans tab is natural); deep-linkable per case
- Weak at: biggest build — a new route/page + table-to-page navigation change; leaves the "edit in place" lightness of the current table behind

### Best for
The long-term home of case authoring if you want cases to feel like documents (closest to TestRail's case detail page).
