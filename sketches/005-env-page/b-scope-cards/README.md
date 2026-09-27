## Variant: Scope cards

### Design stance
The scope IS the mental model — one bordered card per scope (global, each app, each plan), vars listed inside, add-form inline per card.

### Key choices
- Layout: vertical stack of cards; card header = scope tag + owner name + "+ var" button
- Add: inline row that expands inside the owning card (scope pre-decided by placement)
- Edit: modal dialog (blank keeps secret), delete per row
- Empty apps/plans show as "no vars" cards — the registry of scopes is visible even when unused

### Trade-offs
- Strong at: matches the resolution-chain mental model directly; scope-correct adds with zero selector fiddling; empty scopes discoverable; matches ScreensPage visual rhythm
- Weak at: cross-scope key comparison needs scrolling; many apps = long page; no filtering

### Best for
Operators who manage env per-app ("set up int-dev's creds") rather than per-key — the common QA setup flow.
