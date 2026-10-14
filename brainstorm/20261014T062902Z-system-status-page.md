# System Status page — detailed monitoring surface ("status" in the menu)

- Source prompt: "As a user, I want Lionidas to have a 'system status' page (shows as 'status' in the menu), for monitoring the current systems status in details."
- Created: 2026-10-14T06:29:02Z
- Status: Exploring

## Goal and context

The user wants a dedicated **status** page in the Lionidas menu that shows the current health of every subsystem in detail — one glance answers "is everything working right now, and if not, what exactly is broken?" This rounds out a session where the chat subsystem produced several hidden failures (zombie liveTurn, silent-empty turns, zero-tools races, dead servers) that were only discovered by forensic DB dives. A status page makes that class of problem **visible without forensics**.

Direct statements (confirmed):
- A new page, entry "status" in the menu.
- Purpose: monitor current system status **in detail**.

Interpretations (not confirmed):
- "Systems" = Lionidas' own subsystems (server, agent chat, provider, MCP bridge, DBs, simulators/engine), not external services.
- The audience is the operator (the user) debugging "why is chat slow/dead" — the exact journeys of this session.

## Confirmed inputs and decisions

- User confirmed the page and its menu label ("status").
- Verified facts about existing surfaces (code, this session):
  - `GET /api/health` returns only `{ok, version, uptimeMs}` (server/src/routes/health.ts) — trivial, not detailed.
  - Overview page (`/api/overview`) is run-health analytics, not system health.
  - Monitoring routes (`/api/diagnostics/*`) are MetricKit payload feeds, not system status.
  - The durable agent core (butler event log: `butler_turns`, `butler_turn_events`, `butler_outbox`, command receipts) exists in `crucible.db.agent.db` — rich, currently unexposed status signals (turn states, orphans, outbox backlog).
  - Provider stack: claude CLI child + MCP bridge (54 tools) + GLM backend; its failure modes (cold-start race, MCP pending, context burn) are now well understood and detectable.
  - WS event bus (`/api/events`) already exists for live push.
  - Alloy reconcile already computes orphaned manual sessions/engine leases (server/src/alloy/reconcile.ts) — a status signal that exists but isn't surfaced.
- House rules: sketch-first for new UI; ecosystem tokens (`.a2-*`, agent-theme.css palette); merges are human-only.

## Exploration

### What "status in detail" should cover (subsystem inventory)

1. **Server** — up/down, version, uptime, boot time, DB connectivity (both `crucible.db` and `crucible.db.agent.db`), WAL mode, DB sizes.
2. **Agent chat core** — live turns (per-session `liveTurn` from the fold), turn outcomes last 24h (completed/failed/aborted counts), zombie candidates (active in fold + stale > 15min — the exact sess_e2e40228 shape), outbox backlog (un-retired effects), oldest pending effect age.
3. **Provider/MCP bridge** — provider kind + model, MCP server reachable (tools/list count — 54 expected), last successful turn, last error, claude CLI version, cold-start retries in last hour (MCP_PENDING throws — we now count them or can).
4. **LLM backend** — GLM endpoint reachability (cheap probe), last response latency, token spend today (usage events), context-burn incidents (empty-answer failures count).
5. **Execution engine** — simulators online (from wall/devices data), alloy engine leases, orphaned manual sessions (reconcile output), queued/running runs.
6. **Data freshness** — last run executed, last case edit, last diagnostics payload ingested, repo ingest age (the "stale sources" bug class from this session).

### Shape options

**Option A — single status API + dense dashboard page (recommended).**
One `GET /api/status` aggregator (fan-out to subsystem checks, each with `{name, state: ok|degraded|down|unknown, detail, lastChecked}`) + one Vue page with subsystem cards, each expandable to raw detail. Poll every 10–30s; WS push optional later.
- Fits: the operator-debugging journey; everything in one fetch; cheap checks run in-process, engine checks read existing tables. Matches "in details" with expandable cards.
- Cost: a new route module + page; needs care that checks themselves never block the event loop (all reads are SQLite/local).

**Option B — reuse /api/health, grow it.**
Grow the existing health route with subsystem fields; render in an existing page (Settings).
- Fits: minimal surface. But health is the liveness probe (k8s-style) — stuffing slow checks into it risks probe timeouts and it still has no home for detail UI. Rejected for conflating liveness with diagnostics.

**Option C — push-based event wall.**
Status page subscribes to WS events and derives health from the live stream only.
- Fits: zero polling. But cold-start (page open with everything already degraded) needs a snapshot anyway, and stream gaps look like "unknown" forever. Rejected as the primary source; fine as a live-refresh layer later.

### Risks / edge cases with real effect

- **The observer must not become the failure**: status checks hitting the provider/CLI must be rate-limited and timeout-bounded (e.g. MCP tools/list probe at most every 60s, cached between).
- **Stale status is worse than none**: every card shows `lastChecked`; a hung check shows "checking…" not old data (the page must not repeat the zombie-lie pattern it exists to catch).
- **Secret hygiene**: provider config shown without keys (endpoint host, model, key-present bool only).
- **Scope creep**: no alerting/notifications in v1 — visibility only (house preference: plan-first for improvements; explicit > silent).

## Open questions

1. **Engine depth in v1** — should simulator/alloy engine status be live-probed (spawn simctl queries, slower) or read-from-tables (fast, slightly stale)? Affects page latency and how much new server code lands.
2. **Placement in menu** — top-level "status" next to overview (interpreted), or under Settings? User said "shows as status in the menu" — top-level assumed but not explicit.
3. **Degrade thresholds** — what counts as "degraded" vs "ok" per subsystem (e.g. outbox backlog > 0? > 10? last-error age?). Can default sensibly; user taste may differ.

## Next step

Pick answers to the three questions (defaults: engine = read-from-tables in v1; top-level menu next to overview; thresholds — degraded only on real signals like backlog>0 or stale>15min), then run the house flow: sketch 2–3 page variants → plan → review → implement (server `GET /api/status` aggregator + StatusPage.vue + menu entry + tests).
