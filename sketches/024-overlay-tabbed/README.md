## Variant: B — transient rail tab

### Design stance
The overlay isn't an overlay at all: `environment` / `inspect` become *third and fourth tabs* in the watcher rail. Transient tabs carry a ✕; watch and chat are permanent.

### Key choices
- Layout: same rail, extra tab slots — the rail's own chrome does the work
- Chrome: ember underline marks the active tab; ✕ only on transient tabs
- Motion: none needed (tab switch)
- Dismissal: ✕ on the tab, or switching back to watch/chat (tab stays until ✕)

### Trade-offs
- Strong at: most discoverable, reuses the WatcherPanel component wholesale, width is consistent
- Weak at: NOT really "overlaying" — inspect-as-tab competes with watch/chat for the same slot (you asked for overlay); tab row can feel busy at 4 tabs
- Weak at: ✕ ≠ switch-away semantics need care (closing inspect should return to watch)

### Best for
If the panels turn out to be long-lived companions rather than burst tools.
