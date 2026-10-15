# 038 — Factory status migration concepts

Phase 3 decision sketches for the existing `/status` UI. **No production status UI has been changed.** All three are complete shell-inclusive, interactive HTML previews using Factory dark tokens and representative values in the real `/api/status` shape. The global shell is shown for visual context; production continues to use `App.vue`.

| | A — diagnostic workspace | B — signals ledger | C — system board |
|---|---|---|---|
| First answer | Why is this selected system degraded? | Which systems are degraded and why? | What is the overall health footprint? |
| Detail | Persistent side pane | Expand one row inline | Separate panel after tiles |
| Mobile | Selector grid + immediate detail | Stacked expanding rows | Long stack; detail below tiles |
| Fit for operator triage | Strong | Strong for scanning | Weaker; more vertical travel |

**Recommendation, not approval:** A preserves the previously chosen diagnostic journey and presents the selected system’s thresholds without a second click. B is a strong alternative if comparing all failure signals at once matters more. C is weakest for mobile triage.

Open the full interactive variants from the project-root sketch server (`python3 -m http.server 8794 --bind 127.0.0.1`):

- `sketches/038-status-factory/a-diagnostic-workspace/index.html`
- `sketches/038-status-factory/b-signals-ledger/index.html`
- `sketches/038-status-factory/c-system-board/index.html`

All three were browser-checked at 375, 768, 1024 and 1440: seven sample systems, 56px topbar, no document horizontal overflow; selection/expansion works. The mobile menu opens/closes. Vision review found no visual overlap; C’s detail begins below the first mobile viewport (a real trade-off, not a clipping defect). Axe WCAG 2 A/AA reported zero violations for all three variants at 375 and 1440; this automated check is not a claim of full accessibility.

Prototype nav and sign-out show a “preview only” notice; they do not mutate the real session. The production API and page behavior (15s visibility-aware polling, checkedAt/cached truth, operator gate) remain the implementation constraints. A choice here is a choice of **composition**, not approval to alter the status backend or shell.
