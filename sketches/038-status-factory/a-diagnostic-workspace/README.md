# A — Diagnostic workspace

**Stance:** Keep a complete subsystem selector beside one readable explanation pane. This updates the previously selected split journey to Factory without changing what the status API means.

- Hierarchy: overall state and observation time → all system states → selected system’s full details and thresholds.
- Interaction: select any of seven sample systems; details, summary, state and threshold update together. Keyboard focus is visible. Mobile uses a two-column selector grid with detail immediately below.
- Strong at: diagnosing one incident and preserving operator context.
- Weak at: seeing several systems’ full reasons simultaneously.
- Best for: an operator investigating one failure. **Recommended proposal**, subject to the user’s pick.

The HTML includes a shell approximation of the existing `App.vue` for composition review. The implementation should keep the actual shell, not replace it. Data is illustrative, not a claim about live health. In production the payload can have six or seven systems; the build-config canary is conditional.
