## Variant: R3 · Console log

### Design stance
The run as a live terminal: a compact stream thumbnail + an auto-scrolling log where each step is a line that appears the moment it starts.

### Key choices
- Layout: 260px stream column (with verdict box beneath) | log lines fill the rest
- Lines: timestamp + tag (▸ active / ✓ done / ✕ fail) + step text; the active line is ember-highlighted with a blinking cursor
- Pending steps don't render — the log grows as the run progresses (true chronology, not a checklist)
- Verdict box under the stream; unlocks

### Trade-offs
- Strong at: timing intuition (timestamps + durations inline); failure context reads like a stack trace; lightest chrome; scales to long cases without pre-rendering 50 pending rows
- Weak at: no at-a-glance "how far along" without reading; the step list isn't visible upfront (your requirement of showing the case's steps argues against pure-append)

### Best for
Engineer-flavored debugging and long suites; pairs well with a progress bar (hybrid with R1's footer).
