## Variant: R1 · Observer dock

### Design stance
Watch without taking over: a fixed right dock (stream on top, step list below) while the page stays fully usable beside it.

### Key choices
- Layout: 420px right column; stream ~260px tall, steps scroll under it
- Steps: checkmark prefix on done, ember bar+border on the executing one, per-step duration appears as it finishes
- Lock: 🔒 chip in the header; progress bar + step counter in the footer
- Verdict: status card replaces the progress footer (pass/fail variants, "open run ↗" link)

### Trade-offs
- Strong at: multitasking — run a case and keep browsing/editing others; consistent placement builds muscle memory
- Weak at: stream is small (420px col); least dramatic; easy to ignore a failure

### Best for
The everyday QA loop — running regression batches while prepping the next case.
