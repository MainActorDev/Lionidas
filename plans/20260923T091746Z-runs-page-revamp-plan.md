# Runs Page Revamp — Dense Log Lines (017-C)

- Source brainstorm: `brainstorm/20260923T091746Z-runs-page-revamp.md` (+ its Decisions section)
- Sketch: `sketches/017-runs-revamp/c-log-lines/` (user-selected variant C)
- Created: 2026-09-23
- Status: **Ready** (post-review: F1-F4 corrections applied 2026-09-23 — see `reviews/20260923T091746Z-runs-page-revamp-plan-review.md`)

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| 1 | Direction: **grouped log**, sketch variant **C — dense log lines** | User: "I prefer C" (2026-09-23) |
| 2 | Default view: **everything on load**; chips narrow down (all/failed/blocked/aborted/running) | User: "B" (2026-09-23) |
| 3 | API work in scope (`/api/runs` cursor + filters) | User: "1. Yes" (2026-09-23) |
| 4 | Verified: `/api/runs` **already supports** `status` (exact + `active`), `ticket`, `template`, `app_version`, `suite`, `variant`; `SELECT *` already returns `blocked`, `note`, `finished_at`, `app_version` | `server/src/routes/runs.ts:71-137` (read 2026-09-23) |
| 5 | Verified data: 724 runs, all `kind=manual`; 501 passed / 136 failed / 87 aborted; avg duration 212s, max 24,513s; avg evidence 0.0/run | live DB queries (2026-09-23) |

## Objective

The runs page becomes a readable history log: one dense line per run, day dividers carrying per-day verdict summaries, duration visible (catches 6.8h anomalies), failure notes inline. Dead columns (kind, ticket-as-column) removed. Measurable done = every acceptance check below passes and the live drill sees real data rendering correctly.

## In / out of scope

**In:** `/api/runs` `before` cursor; RunsPage.vue rewrite as log lines (sketch C 1:1); status chips; day grouping; duration column; failure note line; abort button for active runs; SSE live refresh preserved; `load earlier` pagination.

**Out (parked, per brainstorm):** failure signature grouping (Overview owns triage); search; evidence previews (data-contradicted — 0.0 evidence/run); test-cases/overview changes; deleting the `kind`/`ticket` *API* fields (page stops rendering them; other consumers untouched).

## Stage T1 — API: `before` cursor (server)

`GET /api/runs` gains `before?: string` (epoch-ms). Semantics: `WHERE started_at < before`, composable with every existing filter (append to the `where` array, `runs.ts:79-96`). Plus one pseudo-status (review F1): `status=blocked` → `WHERE blocked = 1` — `blocked` is a column, not a status value (schema CHECK forbids it), so the chip needs server-side mapping exactly like the existing `active` pseudo. And the running chip maps to the existing `status=active` pseudo (review F2) so queued runs are covered.

- Also return the response shape unchanged; cursor paging = client passes `started_at` of the last loaded row.
- Edge: `before` non-numeric → ignore (matches existing `limit` leniency); `started_at IS NULL` rows (rare) sort last, cursor naturally excludes them.
- Tests (`server/test/runs-cursor.test.ts`, house style): (a) `before` returns strictly older rows only; (b) composes with `status=failed`; (c) without `before` behaves exactly as today (regression pin); (d) garbage `before` ignored; (e) `status=blocked` pseudo matches failed+blocked row, not unblocked failed (F1); (f) `status=active` includes queued (existing behavior, pinned for the chip).

## Stage T2 — RunsPage.vue rewrite (web)

Sketch C 1:1, real tokens, existing components:

- **Header** (existing PageHeader): title `runs`, desc `724 runs · N days shown · live`; actions slot = status chips (`all · failed · blocked · aborted · running`), server-side on click — `failed/aborted` exact, `blocked` → `?status=blocked` pseudo (T1), `running` → `?status=active` (covers queued, F2); `all` = no param (Decision 2). Chip counts computed from the loaded window — counts grow as `load earlier` appends; intended, not a bug (review F4).
- **Log body**: `v-for` day groups → day divider (`tuesday · sep 23 · 22 ✓ 16 ✕ 3 ◆ 2 ⌫ · longest 6.8h ⚠`) then `.ln` rows: `HH:MM | case(+variant ▸ chip, revision r⚠ chip) + note | duration | by | status`. Grid columns from the sketch (44px/1fr/70px/64px/70px). Click row → run detail (existing route). Duration = `finished_at - started_at`, live-tick for running rows (`now - started_at`, interval already exists for polling), ember `⚠` over 30m.
- **Groups computed client-side** from the fetched flat list (key: local day of `started_at`); running/queued rows float to today's top regardless of timestamp.
- **Abort** button on running/queued rows (existing `POST /api/runs/:id/abort`), stopPropagation.
- **Load earlier**: appends `&before=<oldest started_at>`; disables when a fetch returns 0 rows. Keep last-fetch-wins guarding (monotonic token) so a slow page-2 fetch can't clobber a fresh page-1 refresh.
- **SSE**: existing `run.started`/`run.finished`/`queue.changed` watch → refetch page 1 (drop cursor state; user is watching live).
- Dead columns `kind`/`ticket` not rendered. `manual drive` label kept for template-less manual rows (today's behavior).

## Stage T3 — verify + ship

1. `pnpm run check` (all server + web tests, tsc, lint) and `pnpm run build` — green.
2. Live drill against real DB (servers already running on 9230/5230): login → /runs → verify day dividers with correct syms, duration column, chips filter server-side (URL carries `?status=`), load earlier walks history, abort visible on an active run (a queued row also satisfies this; a directly-inserted `running` drill row is acceptable and cleaned up after — review F3), no horizontal scroll at 1280/1440/1920.
3. Vision pass on a full-page screenshot (layout sanity) per house rule.
4. Commit (single: T1+T2+T3 with test counts in message). Stop drill servers only on user request (they're currently wanted up).

## Failure cases & guards

- Empty day edge (day with 0 runs after filter) → divider hidden, no empty sections.
- `started_at NULL` (orphan rows) → grouped under `unknown` divider at the bottom.
- Slow network double-click on `load earlier` → in-flight guard, single append.
- SSE refetch during cursor browsing → resets to page 1 (acceptable: live wins).
- 0-run day + `all` chip → existing `.empty` state message retained.

## Acceptance checks

- [ ] `/api/runs?before=X` returns strictly older runs; composes with `status`; absent behavior unchanged (pinned by test).
- [ ] `?status=blocked` returns blocked runs only; `?status=active` includes queued (pinned by tests).
- [ ] Page loads all statuses by default; chips set `?status=` and the server filters (verified in network tab / URL).
- [ ] Day dividers show per-day ✓/✕/◆/⌫ counts and `longest` duration; ≥30m durations flagged ember ⚠.
- [ ] Every row shows duration; running rows tick live.
- [ ] kind/ticket columns gone; variant + revision chips still render; abort works on an active run.
- [ ] `load earlier` appends older days; stops cleanly at history end.
- [ ] Gate green; live drill + vision pass recorded; committed.
