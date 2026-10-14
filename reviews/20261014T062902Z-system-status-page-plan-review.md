# Review: system status page plan

- Plan reviewed: `plans/20261014T062902Z-system-status-page-plan.md` @ Ready
- Evidence: server/src/routes/{health,overview,monitoring}.ts, server/src/alloy/reconcile.ts, web/src/App.vue nav groups, butler event tables in crucible.db.agent.db, session forensics (sess_e2e40228, sess_88de6757).

## Verdict

**Approve with corrections** — the direction is sound, sources are real, and the user's three decisions are honored. Two findings must be fixed in the plan before implementation; one is a correctness risk.

## Findings

### PR1 (High) — "MCP tools expected-vs-last-known" needs a real source; as written it's unfetchable

The plan says the provider-mcp card reads "the strong-oracle verify: last init tools[] snapshot stored in a tiny `agent_meta` table or derived from recent events" — but neither exists today. The oracle runs inside the butler provider (child process events, in-memory only). Nothing persists the last known MCP tool count, and butler's event log records tool *calls*, not init tool lists.

**Effect**: implementer would either invent data or skip the card's key signal.
**Correction (pick one, testable)**:
- (a) Drop the "expected-vs-last-known" signal in v1; keep last successful turn time + MCP_PENDING retry count (both derivable from the agent event log/turn outcomes).
- (b) Add the persistence explicitly to the plan as a butler change (write last init tool count on each boot into a status table), which widens scope into butler.
Recommend (a) for v1 — the retry count already catches the race's symptom; tool-count drift without failures is not actionable today.

### PR2 (Medium) — Fold-derived "live turns" is per-session replay; cost needs a bound

The agent-core card derives live turns by folding each session's events. Sessions grow unboundedly (2,400+ events in one session already). Folding ALL sessions per status poll is O(total events) every 10s.

**Effect**: status endpoint becomes the slowest route on the box; TTL cache mitigates but each refresh pays it.
**Correction**: derive from SQL, not folds: `turn.started` events whose `turn_id` has no terminal event (`turn.completed|failed|aborted`) — one indexed query over recent events (`at > now-24h`), exact same semantics as the fold for this purpose, O(recent). State the query in the plan.

### PR3 (Low) — Sketch-first is listed but sequenced after the plan

House rule: sketch 2–3 variants, user picks, then 1:1. The plan mentions it inside Step 2. Fine, but the acceptance criteria should include "sketch chosen by user before page implementation" so the gate is checkable.

### PR4 (Low) — `agent-core` 24h window vs `engine`/`data-freshness` thresholds inconsistent

Card windows: 24h outcomes, 15min zombie, 1h MCP retries, 7d freshness. Not wrong — but list them in ONE place (a thresholds table in the page's detail view) so "why is this degraded?" is always answerable from the UI itself.

## Questions

None blocking — PR1(a) is a decision the implementer can make per this review's recommendation.

## Result

Apply PR1(a), PR2, and fold PR3/PR4 notes into the plan; then implement. No re-review needed for these mechanical edits.
