## Variant: Flat ledger

### Design stance
One dense table for every var in the system — scope as a filterable column, not a navigation axis. The whole env surface in a single scan.

### Key choices
- Layout: full-width table, scope chip + owner (bundle/plan) in column 1
- Filters: text (key), scope dropdown, secret/plain dropdown
- Add: single bottom bar with inline scope/app/plan selectors
- Edit: modal dialog (blank value keeps an existing secret)
- Secret: `•••••` + `set` badge, value column never shows plaintext

### Trade-offs
- Strong at: grep-like findability ("where is DRILL_PHONE set?"), cross-scope comparison in one view, minimal clicks to filter
- Weak at: no notion of "this app's world"; with many apps/plans the table gets long even filtered; add-bar scope switching is clunky

### Best for
Power QA who think in keys, not scopes — "which key, what value, where from" answered in one glance.
