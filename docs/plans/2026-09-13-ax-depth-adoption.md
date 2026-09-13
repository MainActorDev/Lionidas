# AX-Depth Adoption — Implementation Plan

> **For Hermes:** implement task-by-task with per-task verify + commit.
> Evidence base: spike `2026-09-13-ax-depth-spike.md` (P0–P3, verdict
> ADOPT) + `docs/research/2026-09-13-ax-depth-coverage.md`. Gated by the
> user before starting. OUT OF SCOPE: inspector re-parent wiring (P2.5
> parked — absent-container class needs pixel/viewtree inference first).

**Goal:** Make the wrapped engine's deeper accessibility tree the PRIMARY
source for selector resolution and counting in manual sessions and
playback, with the alloy tree as fallback — flipping the corpus RED tests
GREEN (that flip is the negative-control receipt).

**Architecture:** New server-side engine-tree client spawns the engine CLI
per snapshot demand (0.45–0.76s measured — no long-lived process needed;
serve/WS only if a future poll cadence demands it, NOT in this plan).
Factory + role table graduate from `server/test/utils/` to
`@crucible/shared`. Selection policy at the consumers: engine tree first;
on any engine failure (spawn error, timeout, unmappable role) fall back to
the alloy tree and tag the snapshot with its source. Playback and the
inspector keep working identically on either tree — the predicates are
source-agnostic (P2 proved this).

**Tech Stack:** `@crucible/shared` (new module + exports entry), Fastify
route change in `routes/manual.ts` tree endpoint, playback engine-call
sites in `manual/session.ts` + `manual/playback.ts`, vitest corpus flip.

---

## Verified facts (2026-09-13, spike receipts)

1. Engine CLI `describe-ui --udid` → nested JSON, device-point frames,
   roles (8 observed), hidden/enabled/focused/value; 0.45–0.76s cold.
2. Factory contract proven: DFS flatten, role→type table, throw-on-
   unmappable, hittable := !hidden && enabled (optimistic — divergence
   measured, not hidden). 4 contract tests green.
3. Predicates consume engine trees correctly (9/9 corpus tests).
   Fixes: MINGGU 4→1 (resolve works), battery 0→1. Regression (LP tab
   buttons 1→0) bounded, covered by hit-test seam via `sweep.ts`.
4. Engine binary: `../Baguette/Baguette` relative to repo root (fork,
   v0.1.61); supervisor already spawns `serve` on :8422 for streams —
   this plan does NOT touch the supervisor; the tree client is separate
   and on-demand (CLI subprocess), mirroring how `alloy_snapshot` is
   dispatched today.
5. `alloy_snapshot` stays: fallback source + sole source for physical
   devices (engine tree is simulator-only).
6. Signature scan: engine NAME is allowed; five historical patterns are
   not — never write them (spike tripped on this).
7. Exports map in `shared/package.json` — new module needs an entry
   (lesson (i) in skill; map ALREADY lists `./inspect-geometry` — check,
   don't assume).

## Tasks

### T1 — Graduate the factory to shared
- Move `server/test/utils/engine-tree.ts` → `shared/src/engine-tree.ts`
  (types import from `./ax-tree.js`; role table exported as constant).
- `shared/package.json` exports: add `"./engine-tree"`.
- Server tests re-import from `@crucible/shared/engine-tree`; delete the
  test-util copy. All 13 corpus+factory tests stay green.
- Verify: `pnpm --dir server typecheck && CI=true pnpm --dir server vitest run test/ax-depth-engine.test.ts`.

### T2 — Engine-tree client (server)
- `server/src/alloy/engine-tree.ts` (name TBD by engine-neutrality rule —
  describe by shape): `fetchEngineTree(udid): Promise<SnapNode[]>` —
  spawn `${repoRoot}/../Baguette/Baguette describe-ui --udid <udid>` with
  10s timeout, parse stdout JSON, run the shared factory. Errors THROW
  (caller decides fallback); never return a partial tree.
- Unit tests: fixture-file happy path (inject reader), timeout, unmappable
  role, spawn-failure — no device needed.
- Verify: corpus green; new client tests green.

### T3 — Tree-route dual source (manual sessions)
- `POST /api/manual/:id/tree`: try engine tree (if session device is a
  simulator), tag `{ source: 'engine' | 'alloy' }` in the response; on
  engine failure log + fall back to alloy snapshot (existing
  `dispatchWithHeal` path) with `source: 'alloy'`.
- Route test: engine-success → engine nodes + tag; engine-throw → alloy
  nodes + tag (fallback honest, not silent — tag visible to UI later in
  T6, badge optional).
- Verify: route tests + corpus green.

### T4 — Playback resolution dual source
- Playback's resolve path (`manual/playback.ts` around the settle-snapshot
  + `resolveSelector` + sweep): settle snapshot tries engine tree first
  (same simulator check), alloy fallback. The sweep `probeFn` gains an
  engine hit-test variant ONLY if trivially reachable via CLI `--x --y`
  (0.45s per probe is too slow for the 5-point stencil — SKIP unless the
  supervised serve socket can serve it; default: keep alloy probe).
- Corpus RED tests (`ax-depth-corpus.test.ts`) FLIP to GREEN expectations
  — this is the acceptance receipt. Keep the negative-control structure:
  assert BOTH the fix (engine resolve works) and the bounded regression
  (LP tabs 0 on engine tree, documented).
- Verify: full suite + corpus flip diff reviewed.

### T5 — DEFERRED + plan bookkeeping
- DEFERRED E0 updated: wiring shipped, corpus flipped; remaining fork-side
  LP-status-bar check noted as the only open item.
- Spike plan marked EXECUTED.

### T6 (optional, gated) — Source badge in inspector UI
- `useInspectTree` surfaces `source`; InspectTree badge shows tree source.
- Only if user wants the UI signal now; not required for the flip.

## Edge cases (walked at implementation time)

| # | Case | Behavior |
|---|---|---|
| 1 | Physical device session | engine path skipped entirely (sim-only), alloy always |
| 2 | Engine binary missing/older (no describe-ui) | spawn error → alloy fallback + one WARN log per session |
| 3 | Unmappable role in a future engine version | factory throws → fallback; log the role name (upgrade signal) |
| 4 | Engine tree stale vs screen (app mid-transition) | same staleness class as alloy snapshot; no special case |
| 5 | LP tab-button regression path | engine tree misses tab buttons → resolveSelector null → coordinate fallback + sweep (alloy probe) — existing seams |
| 6 | Two sessions on different sims | CLI per call, no shared state; fine |
| 7 | Sim shut down mid-spawn | timeout/spawn error → alloy fallback (which itself errors honestly) |

## Verification gates (final)

`pnpm --dir server typecheck && pnpm lint && CI=true pnpm vitest run --maxWorkers=2`
(635 baseline) + `npx vue-tsc --noEmit && npx vite build` in web if T6
included. Live drill: manual session on LP sim → tree route returns
`source: 'engine'`; playback of the MINGGU-style step resolves by
selector (no coordinate fallback in the step log); kill the engine binary
path (rename) → everything still works on alloy with the WARN + tag.
