# System Status page — PLAN

- Source brainstorm: `brainstorm/20261014T062902Z-system-status-page.md` (`32bf8e5`)
- Created: 2026-10-14T06:33:51Z
- Status: Ready

## Goal and context

A "status" page under a NEW nav group "system" that shows detailed, current health of every Lionidas subsystem in one glance. Answers "is everything working — and if not, what exactly is broken?" without DB forensics. Every hidden-failure class from this session (zombie liveTurn, silent-empty turns, zero-tools races, dead server, stale data) becomes a visible card.

Audience: operators debugging chat/infra health. Constraints: house rules — sketch-first, `.a2-*`/agent-theme tokens, no secrets, human-only merges, tests required.

## Confirmed inputs and decisions

From the user (this round, verbatim answers to the brainstorm's open questions):
1. **Engine depth: "Read from tables"** — v1 status reads SQLite tables only; NO live simulator probing.
2. **Menu: "Create a new group 'system' and the 'status' under it"** — new nav group `system`, entry `status`.
3. **Thresholds: "yes"** — degraded on real signals: outbox backlog > 0, stale-active turn > 15min, plus analogous honest signals below.

From the brainstorm (verified code facts): existing `/api/health` is trivial; butler tables live in `crucible.db.agent.db` (`butler_turns`, `butler_turn_events`, `butler_outbox`); monitoring routes are MetricKit, not system status; App.vue nav groups support `operatorOnly`/`adminOnly` gating; WS bus exists; sketch-first rule for new pages.

## Implementation steps

### Step 1 — Server: `GET /api/status` aggregator (`server/src/routes/status.ts`)

Operator-gated. Returns `{ checkedAt, systems: StatusCard[] }`, each card `{ id, name, state: 'ok'|'degraded'|'down'|'unknown', summary, detail? , lastChecked }`. All reads are SQLite/local — bounded, no event-loop risk, no external probes. Per user decision 1, NO simctl/engine live probes: engine card reads tables.

Cards (source → state rules):
1. **server** — process uptime, version, boot time; both DBs opened + `journal_mode` + file size; `down` if any DB read throws, else `ok`.
2. **agent-core** — from butler tables, ALL via SQL over recent events (`at > now-24h`, indexed) — never per-session folds (review PR2: folds are O(total events), 2,400+ in one session already): live turns = `turn.started` events whose turn_id has no terminal event (`turn.completed|failed|aborted`); 24h outcome counts grouped by kind; zombie candidates = live turns whose last event is > 15min old → `degraded` listing turn ids; outbox backlog = `retired_at IS NULL` count (> 0 → `degraded` with oldest age).
3. **provider-mcp** — provider kind, model, claude CLI version (cached from last spawn), MCP_PENDING retries in last hour (count from failed turns' error detail in the event log; > 0 → `degraded` with note), last successful turn time. (Review PR1(a): the "expected-vs-last-known tools count" signal is DROPPED for v1 — the oracle runs in-memory in the provider child and nothing persists it; the retry count already catches the race's symptom.)
4. **llm-backend** — endpoint host + key-present (bool, never the key), last turn latency (last `turn.started`→terminal delta), token spend today (sum usage events `cost`), context-burn incidents (empty-answer failures count from failed turns with the empty-answer error marker; > 0 in 24h → `degraded`).
5. **engine (read-from-tables)** — simulators/devices from existing wall/devices tables (last seen), queued/running runs count, alloy orphaned manual sessions (`finished_at IS NULL` and stale) → `degraded` listing counts; all values carry `lastChecked = now` + the table's own recency so staleness is honest.
6. **data-freshness** — last run executed, last case edit, last diagnostics payload received, repo ingest age (sources table max ingested_at). Card `degraded` when any age > its threshold (run 7d, ingest 7d, diagnostics 14d — surfaced as detail, thresholds listed).

Caching: in-process 10s TTL memo for the whole payload (status page polls 15s); `checkedAt` reflects actual check time — a cached response is labeled as such (`cached: true`) so the page never shows stale data as fresh (the page's own founding rule).

### Step 2 — Web: StatusPage.vue + route + nav group

- Route `/status` name `status`, meta title 'status'.
- NEW nav group in App.vue: `{ id: 'system', label: 'system', items: [{ to: '/status', label: 'status', names: ['status'], operatorOnly: true }] }` — placed after `agent` group.
- Page: subsystem cards grid; each card header = state dot (ok=green, degraded=amber, down=red, unknown=steel) + name + summary; expandable raw detail (`<details>`-style, `.a2-*` + agent-theme tokens); global header shows overall state + `checkedAt` + cached badge; auto-refresh 15s with pause-on-hidden (`document.visibilityState`).
- Sketch FIRST: 2–3 layout variants (cards-grid vs table vs split) as local sketches, user picks, then 1:1 implementation (house rule).

### Step 3 — Tests

Server (`server/test/status-routes.test.ts`): aggregator returns all six cards; degraded rules unit-tested per card (zombie candidate fixture → degraded; outbox backlog fixture → degraded; healthy DB fixture → ok); secrets never serialized (no apiKey values in payload); TTL cache returns cached payload labeled.
Web: StatusPage render test — cards from fixture payload, state classes, cached badge; nav group present for operator.

## Acceptance criteria

0. Sketch variants (2–3) shown to the user; the chosen variant is implemented 1:1 (house sketch-first gate).
1. Menu shows group `system` with entry `status` (operator+ only).
2. `/status` renders six subsystem cards with state dots, summaries, expandable details, `checkedAt` + cached badge, 15s auto-refresh paused when tab hidden.
3. All states derive from real table data — no live engine probes (user decision 1).
4. Degraded rules: zombie candidate > 15min → degraded; outbox backlog > 0 → degraded; MCP retries > 0 in 1h → degraded; context-burn > 0 in 24h → degraded (user decision 3 "yes").
5. No secret material (keys/tokens) appears in any response field (test-asserted).
6. Every threshold the cards use (15min zombie, 1h MCP retries, 24h outcomes/burn, 7d freshness) is LISTED in the page's detail view — "why is this degraded?" is answerable from the UI alone (review PR4).
7. Server suite + web suite + tsc green; page verified against the live server (real data, real degraded/ok states).

## Out of scope (v1)

Alerting/notifications; live engine probing (simctl); historical status graphs; WS push refresh (polling only).
