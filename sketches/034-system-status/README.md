# 034 — system status

Three variants, real house tokens (tokens.css), sample data drawn from the session's real incidents.

- **A — cards grid**: glance-first. Overall state banner + 3×2 cards, each with dot/summary/sub. Degraded cards get ember border. Fastest "is everything ok" read.
- **B — ledger table**: scan-first. One dense row per subsystem with state badge + signals column. Best when you want everything in one scroll with no clicking; detail inline.
- **C — split master-detail**: drill-first. Subsystem list (with live counts at right) + detail pane showing the selected card's key/values AND the thresholds footer (PR4: "why is this degraded" answered in place). Best for the debugging journey — pick a sick subsystem, read everything about it.

All three share: overall state + `checkedAt` + cached-age in the header, state dots (ok/degraded/down/unknown), 15s refresh.

Open `variants.html` in the served sketches (or file://) and pick A/B/C.
