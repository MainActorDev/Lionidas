# Crucible Codebase Quality, Scalability & Coverage Assessment

- Source prompt: "How good is the current codebase code quality? How scalable are they? What is the test coverage? … still in development phase … might add Android support. Any improvement allowed as long as existing working implementation not affected, and we have tests to protect them."
- Created: 2026-09-23T13:37:42Z
- Status: Direction selected + scheduled — DeviceAdapter seam first (Android is real, near-term; must precede further iOS work on device paths), web test harness immediately after

## Decisions (user-confirmed, 2026-09-23)
1. **Android: real and near-term** — "Until the iOS fully implemented and hardened" → backlog #1 (DeviceAdapter seam) ships **first**, as the gate before more iOS features land on simctl paths.
2. **Web testing: full harness** → backlog #2 ships right after #1; pure logic first, then critical components.

## Goal and context

Baseline health check before feature growth (more features + possible Android support). Constraint: improvements must not change working behavior; tests are the safety net.

## Confirmed inputs and decisions (measured 2026-09-23)

**Size & shape** (cloc-style, `server/src` + `web/src`):
- 142 source files, ~24.6k LOC total. Server ~12.9k LOC across 16 modules; web ~11.7k.
- Tests: **107 server test files, ~12.0k LOC — 0.93:1 test-to-src ratio** (906 tests green). Web: **1 test file** (composables/stream codecs) — effectively untested.
- Dependencies: server 9 runtime deps, web 14 — lean both sides.
- Hotspots: `DeviceSidebar.vue` 1,286 · `playback.ts` 1,209 · `TestCasesPage.vue` 1,083 · `manual.ts` (routes) 866 · `templates.ts` 628.
- Hygiene: **0 TODO/FIXME markers**; `as any`/`as never`: 29 in server (mostly test seams), **0 in web**.
- Auth: `requireRole` on 15 route registrations; hard read-gate default-on. Direct `db.prepare` spread across **41 files** (routes own 47+16+31 call sites in three files alone).
- **iOS lock-in: 11 server modules shell out to `xcrun`/`simctl` directly** (keyboard-quiet, location-tcc, app-install, viewtree, location, apps, playback, sim-routing, diagnostics/extract, simdeck/holds, poll/devices). The alloy engine layer (`alloy_*` tools) is a partial abstraction — only runner.ts routes through it for 3 tool families.

**Verified qualitative strengths** (from this session's work):
- TDD house pattern real: 906 tests, regression pins, negative controls; migrations guarded + idempotent; test seams (`__setAlloyForTest`, `__psSweep`) are injectable, not mocked globals.
- Honest-data culture: NULL never faked, legacy rows labeled, `no_baseline`-type corrections.

**Verified weaknesses**: giant files carry multiple concerns (playback.ts = orchestration + DB + artifact pruning + versioning); no service/repository layer between routes and SQL; web has no component/page test harness at all; device control scattered between engine dispatch and raw simctl.

## Exploration — scores with evidence

| Dimension | Score | Evidence |
|---|---|---|
| Test coverage (server) | **A−** | 0.93:1 ratio, 906 green, behavior-level assertions |
| Test coverage (web) | **D** | 1 file; pages/components untested |
| Code quality — small modules | **A−** | 16 focused server modules, clean boundaries, 0 TODOs |
| Code quality — hotspots | **C** | 5 files >800 LOC mixing layers |
| Architecture — API/domain | **B** | routes thin-ish, but 41 files touch SQL directly |
| Architecture — device layer | **C+** | dual path: engine dispatch + 11 raw-simctl modules |
| Scalability (load) | **B+** | Fastify + SQLite WAL single-writer; fine for team-scale, documented ceiling |
| Scalability (features) | **B** | modules compose well; hotspots will resist growth |
| Scalability (Android) | **C** | simctl hardcoded in 11 modules; udid-first model is iOS-shaped but not hostile |
| Security/authz | **B+** | role gates, session expiry, audit log, 8MB caps |

### What "scalable" means here (calibrated to dev-phase)

Load: SQLite is the right call for single-team dev; the wall arrives with concurrent writers on big batches (playback serializes today). Not a now-problem. Features: good until you touch the 5 hotspots. Android: the real cost — every simctl call site is a port-required line, and there's no `DeviceAdapter` seam to implement against.

### Proposed improvement backlog (ranked; all behavior-preserving, test-first)

1. **`DeviceAdapter` seam (Android unlock)** — extract an interface (boot/shutdown/erase/install/apps/location/stream) with `SimctlAdapter` as the only impl. 11 modules move behind it; zero behavior change, pinned by existing 906 tests. *Prereq for Android; do before features land on those paths.*
2. **Web test harness** — Vitest + @vue/test-utils on web (already in monorepo); cover the pure logic first (day-grouping, duration fmt, pin toggles, cursor paging in RunsPage), then critical components (PageHeader, TriagePanel). *Protects every UI change like today's.*
3. **Decompose playback.ts** — split orchestration / run-row persistence / artifact pruning / version snapshotting into modules behind the same tests. Also manual.ts routes (866) by resource.
4. **(Later) repository layer** for the 3 heaviest routes; only when a second consumer (suite detail page?) actually needs the queries. Don't build it speculatively.
5. **(Park) SQLite→PG migration** — revisit at concurrent-writer pain, not before.

## Open questions

1. **Android timing** — real near-term plan or speculative? Decides whether #1 ships now or stays top-of-backlog.
2. **Web testing appetite** — full harness (#2) or accept browser-drill-only verification for UI?

## Next step

Pick backlog items to schedule; each ships as its own test-first slice with no behavior change.
