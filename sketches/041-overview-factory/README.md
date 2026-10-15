# 041 — overview Factory concepts

Phase 4 decision sketches for `/` — same data, same actions (run-all, plans, deep links), three verdict treatments in the established scoped-CSS Factory language. The shell shown is context; production keeps the real `App.vue`. Prototype actions show a "preview only" notice.

| | A — band verdict | B — hero verdict | C — verdict ledger |
|---|---|---|---|
| Verdict | `/status`-style band: 17px word + dot + mono sub-line | current page's feel: 72px display word + stacked subs | one bordered ledger: verdict row + coverage row joined |
| Coverage strip | separate strip below band | separate strip below hero | fused into the ledger box, hairline-joined |
| Register | quiet, consistent with migrated pages | loudest; front-door drama | densest; instrument-panel |
| Mobile | wraps cleanly; word stays 17px | word drops to 44px; still dominant | verdict row stacks; coverage 2-col |

All three share: plan chips, 6 coverage cells (orange only on failed/not-run), attention + latest-runs hairline lists, day-style mono metadata. Factory rules hold everywhere — no bright fills, no shadows, ≤500 weight.

Serve from repo root: `python3 -m http.server 8794 --bind 127.0.0.1` → `sketches/041-overview-factory/{a-band-verdict,b-hero-verdict,c-verdict-ledger}/index.html`.
