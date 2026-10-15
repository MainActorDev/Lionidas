# B — Signals ledger

**Stance:** Read every subsystem and its most relevant signal in one dense scan, then expand one row inline for complete details.

- Hierarchy: overall state and observation time → system/state/summary/signal columns → expanded observations and threshold.
- Interaction: native `<details>` summaries support pointer and keyboard; opening a row closes the previous one. Mobile moves summary below the name/state without horizontal scrolling.
- Strong at: comparing several faults before choosing a diagnostic target.
- Weak at: inline expansion shifts neighboring rows; monitoring long detail values requires scrolling.
- Best for: a scan-heavy operations view.

The HTML includes a shell approximation of the existing `App.vue`; production keeps the actual shell. Sample values are illustrative, not live telemetry. System count is dynamic; the build-config canary may be absent.
