## Variant: R2 · Spotlight

### Design stance
The run is the main event: full-screen stage, big device stream, the CURRENT step rendered huge beside it.

### Key choices
- Layout: stage view (device left, "now executing" panel right, compact step strip far right)
- The active step gets headline treatment (26px, ember accent) with its resolved detail (point, selector ✓)
- Timeline of segment-blocks (done/active/pending) under the current step
- Verdict replaces the footer bar; panel unlocks

### Trade-offs
- Strong at: presentations, demos, watching a critical first run; impossible to miss a failure; best readability of what's happening right now
- Weak at: full-attention consumption — you can't do anything else while it's up; heaviest to build

### Best for
Critical releases, onboarding demos, debugging a specific failing run with the team watching.
