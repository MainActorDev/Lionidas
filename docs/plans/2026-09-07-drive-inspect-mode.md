# Drive page · Inspect Mode — bounding boxes over the live stream

**Date:** 2026-09-07 · **Status:** PLAN — awaiting human gate
**Scope:** `web/` DrivePage + one server route + one shared module. Drive page ONLY (user decision).

---

## 1. Problem & goal

While watching the live device stream on the Drive page, QA cannot see *what is
tappable* or *what Crucible would call it*. Selectors exist (YAML, run audits,
self-hardening) but are invisible at authoring time. **Goal:** an inspect mode —
Figma-style selection bounds over every accessibility element, hover to identify,
click to select and inspect element info.

**Non-goals (explicit):**
- No editing/dragging/resizing of boxes — read-only annotations.
- No inspect on Wall / RunPanel (deferred; needs lease policy decision).
- No `add expect` / recording integration — the Drive page has no recording
  context today (verified: `DrivePage.vue` exposes tap/scroll/finish only).
  Drawer actions are `copy selector` + `tap this` only.
- No changes to the stream frame path (passthrough contract is sacred).

## 2. Settled design decisions (user-locked)

1. **Inspect is a hard mode, not a modifier.** While on, a canvas CLICK never
   dispatches to the device — it selects an element. No hybrid state exists.
2. **Scroll stays enabled in inspect.** Scroll is navigation, not interaction:
   - arrow buttons (↑↓←→) stay active in both modes (already separate DOM);
   - NEW: wheel over the canvas scrolls the device in BOTH modes (bonus for
     drive mode, essential for walking content while inspecting).
3. Toggle via header pill + `i` key; `Esc` = deselect (if selection) else exit.
4. Inspect requires an active manual session (lease semantics like snapshot).

## 3. Gesture contract (the invariant table)

| Gesture              | Drive mode            | Inspect mode                     |
|----------------------|-----------------------|----------------------------------|
| Canvas click (no movement) | tap device       | **select element → drawer — NEVER dispatches** |
| Canvas wheel         | scroll device         | scroll device (always enabled)   |
| Arrow buttons        | scroll device         | scroll device                    |
| Keyboard `i` / `Esc` | toggle inspect / —    | toggle off / deselect→exit       |
| Any typing           | n/a on this page      | n/a                              |

**Invariant:** `mode === 'inspect' && gesture is click ⟹ no dispatch`. Enforced
at ONE place — the click handler branches on mode and the inspect branch
contains no `api()` call to `/tap` (test + code review check).

## 4. Architecture

```
web/src/composables/useInspectTree.ts   NEW  fetch lifecycle + realign state
web/src/components/InspectOverlay.vue   NEW  SVG boxes + hover chip + shimmer
web/src/pages/DrivePage.vue             EDIT  mode state, gesture contract, drawer
web/src/composables/deviceStream.ts     EDIT  onFrame(cb) hook + framesFlowing
shared/src/ax-tree.ts                   NEW  SnapNode type + hitTestAt + guards + selectorPreview
shared/src/frame-settle.ts              NEW  pure settle detector (timestamps→quiet/busy)
server/src/manual/session.ts            EDIT  manualTree() (dispatch alloy_snapshot, return nodes)
server/src/routes/manual.ts             EDIT  POST /api/manual/:id/tree
server/test/ax-tree.test.ts             NEW   hit-test + identity w/ captureSelectorAt
server/test/frame-settle.test.ts        NEW
server/test/manual-tree.test.ts         NEW   route: happy, 410 dead session, shape
```

### 4.1 Shared module `@crucible/shared/ax-tree` (the one-predicate rule)

`captureSelectorAt` (server `manual/selector.ts`) MOVES to
`shared/src/ax-tree.ts` as `hitTestAt(nodes, x, y)` (same smallest-node →
parent-walk → container-guard semantics, unchanged). Server re-exports it so
existing imports keep working; an **identity test**
(`expect(hitTestAt).toBe(captureSelectorAt)` — skill rule j) pins the re-export.

Also in the module (all pure):
- `type AxNode` (= today's `SnapNode` shape; server type becomes a re-export).
- `isContainerNode` guard (moved, re-exported).
- `selectorPreview(node): { kind: 'identifier' | 'label' | 'type-only', text }`
  using the SAME `/^[a-z][a-z0-9_]*$/` identifier heuristic as the YAML parser —
  move the regex to ONE exported const `IDENTIFIER_RE` consumed by both
  `case-yaml.ts` and `selectorPreview` (drift impossible).
- `renderableNodes(nodes)`: filter for box-drawing — drop nodes without rect,
  drop containers, cap at 600 (hit-testing still sees ALL nodes).

⚠️ Exports-map pitfall (skill): add `"./ax-tree": "./src/ax-tree.ts"` and
`"./frame-settle": "./src/frame-settle.ts"` to `shared/package.json` or the
imports fail under `module: nodenext`.

### 4.2 Server route

`POST /api/manual/:id/tree` → `{ nodes, logicalW, logicalH, capturedAt }`.
- Implementation: `manualTree()` = `liveSession()` check (410 classes identical
  to snapshot) + `alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false })`
  + `last_activity` touch. No new lease semantics — same session the page holds.
- Route name ⚠️ route-collision pitfall: `/tree` is distinct-path (nothing
  param-swallows it — verified against manual.ts route list).
- Nodes passthrough verbatim (server does ZERO shaping — the shared module owns
  interpretation; server stays the dumb pipe).

### 4.3 Stream settle signal (`frame-settle.ts` + `deviceStream` hook)

`deviceStream` gains `onFrame(cb)` (called from the existing decodeLoop paint
site — one line, no behavior change) and a derived `framesFlowing` state.
`frame-settle.ts` is the pure core (unit-tested):

```
class SettleDetector { push(t: number): 'quiet' | 'busy' }
// busy while frames arrive < QUIET_GAP=350ms apart (screen changing);
// transitions to quiet after the gap; hysteresis: MIN_BUSY=120ms so a single
// straggler frame can't flip state.
```

The composable feeds it frame timestamps; `quiet` (after a busy period) is the
realign trigger. Change-gated emission (skill: ~10fps while changing, silent
when idle) makes this exactly the right signal — and a no-op scroll (list at
end) emits no frames → no flicker.

### 4.4 Tree lifecycle (`useInspectTree`)

State machine: `off → fetching → aligned ⇄ realigning` (+ `failed`).

| Trigger | Action |
|---|---|
| inspect toggled on | fetch (v++, AbortController) |
| settle `quiet` after `busy` | refetch (debounced 150ms; v++ discards stale) |
| wheel/arrow scroll dispatched | boxes fade (`realigning`), wait settle |
| `tap this` pressed | dispatch tap → realign cycle |
| stream `failed`/`reconnecting` | `stale` (boxes dim, pill says so); on live → refetch |
| inspect off / session end | abort in-flight, drop nodes, state `off` |
| manual refresh button | fetch (always available) |

Staleness honesty: boxes render only in `aligned`; `realigning` = fade-out +
`re-aligning…` shimmer in the header pill. No drifting ghost boxes, ever.

### 4.5 Overlay component (`InspectOverlay.vue`)

- Absolutely-positioned SVG (viewBox = logical dims) over the canvas, sized by
  the SAME ResizeObserver-driven wrapper the canvas uses (skill trap: never a
  second independent transform). `pointer-events: none` on everything.
- Rendering: `renderableNodes()` → `<rect>` outlines. Hover box + selection ring
  drawn from state, not per-node CSS. Vue `v-for` with `:key=node.index`.
- **Hover = math, not DOM events**: `mousemove` → rAF-throttled `hitTestAt()`
  over the full nodes array (smallest node under cursor — Figma feel, identical
  predicate to the engine's capture). SVG rects are never event targets.
- Hover chip: name (identifier › label › type) floating near cursor, clamped to
  the frame. Selection: 2px ring + corner ticks (Figma vocabulary).
- Click on empty area (no hit) → deselect (inspect stays on).

### 4.6 DrivePage integration

- Mode state `inspect: ref(false)`; header pill toggle (accent when on) +
  `i`/`Esc` keymap (guarded: ignored when focus is in an input; DrivePage has
  the operator input pre-session only).
- Canvas cursor: `crosshair` (drive) vs `default` + boxes (inspect).
- Click handler branches on mode — inspect branch = hitTest → select (no fetch,
  no dispatch). Drive branch unchanged.
- Wheel handler (NEW, both modes): `preventDefault`; accumulate `deltaY`;
  threshold 80px → one `scroll down|up` dispatch; cooldown until response
  settles (engine scroll ≈ 1s) — no queue pileup.
- Drawer (right of canvas on wide screens, below on narrow): type, label,
  identifier, rect (logical pts), hittable, parent breadcrumb (walk
  `parentIndex` chain client-side, up to 4 hops), selector preview rendered as
  the YAML line it would produce (`on: auth_legal_disclaimer`), actions:
  `copy selector` (clipboard + toast) and `tap this` (dispatch tap at node
  center — explicit button, the ONLY dispatch door while inspecting; disabled
  unless `aligned`; triggers realign).
- Arrows row: unchanged markup; never disabled by inspect (only by `busy`).

## 5. Performance budgets (the "fast" requirement)

| Path | Budget | Mechanism |
|---|---|---|
| hover → highlight | ≤ 1 frame (16ms) | rAF-throttled math hit-test, no DOM queries |
| inspect on → boxes visible | ≤ 1.2s p95 | single `alloy_snapshot` (~500ms measured) + one render |
| boxes render | ≤ 16ms @ 600 nodes | SVG v-for, `pointer-events:none`, no per-frame work |
| idle CPU | ~0 | zero timers when quiet+aligned; detector is passive |
| stream impact | 0 | overlay is DOM; frame path untouched |
| tree payload | ≤ ~150KB | nodes array as-is (JSON), one fetch per settle |

Guardrails: in-flight dedupe (AbortController), version-discard of stale
responses, single rAF for hover, no watchers on the nodes array.

## 6. Edge-case table

| # | Case | Behavior |
|---|------|----------|
| 1 | Stream dies mid-inspect | `stale` pill, boxes dim; auto-refetch on live |
| 2 | Session LEASE_LOST mid-inspect | existing end-session path clears inspect + drawer |
| 3 | Node without rect / zero-area | skipped by `renderableNodes`, still hit-testable? no — guard both (skip) |
| 4 | Tree > 600 renderable | render first 600 (sorted smallest-area-first); hit-test all |
| 5 | Rapid toggle i-i-i | in-flight aborted on off; re-enable refetches; no flicker of stale |
| 6 | Wheel spam | threshold + single-flight cooldown; extra deltas ignored |
| 7 | Esc with drawer open | closes drawer + deselects; second Esc exits inspect |
| 8 | Click hits nothing | deselect, no dispatch, no error |
| 9 | Node has neither label nor identifier | box + type-only chip (`Button`); selector preview = type-only |
| 10 | Scroll changes nothing (list end) | no frames → no fade, no refetch (correct: nothing to realign) |
| 11 | Lazy content loads post-settle | frames flow → detector busy → quiet → refetch (covered by signal) |
| 12 | Panel resize mid-inspect | ResizeObserver rescales overlay via same wrapper; no refetch needed |
| 13 | `/tree` while run owns device | manual-session guard already refuses (409/410 classes unchanged) |
| 14 | identifier-shaped label heuristic conflict | one regex, one source (`IDENTIFIER_RE`) — parser and preview agree by construction |
| 15 | `/tree` fetch itself fails (engine cold, network) | state `failed`, pill `tree unavailable · retry` (manual refresh re-runs); boxes hidden — never stale-wrong |
| 16 | System alert / sheet covers the app | tree reports whatever AX sees (Springboard alert nodes) — boxes are honest to the tree; no special-casing |

## 7. Tasks (each: implement → verify → commit)

**T1 · shared ax-tree + frame-settle modules**
Move `captureSelectorAt`→`hitTestAt` + `isContainerNode` + SnapNode type to
`shared/src/ax-tree.ts` (server re-exports; identity test). `IDENTIFIER_RE`
extracted from case-yaml, consumed by `selectorPreview`. `frame-settle.ts`
detector. Exports-map entries. Tests: hit-test (smallest/parent-walk/container/
no-hit), identity re-export, settle transitions (busy→quiet hysteresis,
straggler frame, quiet-start). Verify: `pnpm vitest run` server (all green incl.
existing selector tests unchanged), typecheck.

**T2 · `/api/manual/:id/tree` route**
`manualTree()` + route + tests: happy (nodes passthrough verbatim, capturedAt),
dead session → 410, unknown id → 410 class, activity touch. Verify: vitest route
suite + curl against live server (booted sim, manual session, `jq` node count).

**T3 · deviceStream `onFrame` + `framesFlowing`**
One-line hook in decodeLoop; expose detector-fed state. Verify: existing stream
tests pass; live drill — watch frame events fire during a scroll, silent after.

**T4 · InspectOverlay.vue**
Pure-presentational: props `{nodes, logicalW, logicalH, hover, selected,
state}`, emits `hit(node)` via injected callback. Verify: vue-tsc + vite build +
Playwright render test with a fixture nodes array (boxes count, hover chip,
selection ring, empty-state).

**T5 · DrivePage integration**
Mode state + keymap + gesture contract (click branch, wheel scroll, arrows
always on) + drawer + `useInspectTree` wiring. Verify: vue-tsc, vite build,
Playwright live drill (§9).

**T6 · Docs + skill**
`docs/features/inspect-mode.md` (contract table, budgets); DEFERRED.md note:
watch-page inspect deferred w/ trigger; skill reference file after live drill.

## 8. Test matrix

| Level | What |
|---|---|
| Unit (server) | ax-tree hit-test identity + semantics; frame-settle transitions; /tree route ×3 |
| Type | `pnpm typecheck` (server), `npx vue-tsc --noEmit` + `npx vite build` (web) |
| Live API | manual start → /tree (nodes>0, dims) → scroll → /tree (different rects) |
| Browser drill | §9 |
| Regression | full `pnpm vitest run` — playback/selector suites untouched-green |

## 9. Live drill (LP app, booted sim, Playwright)

1. Start session → toggle inspect (`i`) → boxes appear ≤1.2s, aligned to
   tappable elements (screenshot + vision: boxes on Home menu icons/tab bar).
2. Hover a menu card → chip names it; click → drawer shows
   `ic_tabbar_account_inactive`-class identifiers; `copy selector` → clipboard.
3. Wheel down → boxes fade, `re-aligning…`, settle → boxes return shifted
   (vision-verify alignment against the new frame).
4. Click during inspect on a button that would navigate → **screen unchanged**
   (pixel-compare frame before/after — the invariant proof).
5. `tap this` on the Login bar button → navigates to login (deliberate action).
6. Esc ×2 → drive mode restored; canvas click taps device again (ripple fires).
7. Performance probe: hover rAF timing, tree fetch duration from network tab.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Tree fetch latency on huge screens | budget test in drill; worst case = late boxes (honest), never wrong boxes |
| Settle detector misfires (carousel animating forever) | quiet never comes → pill shows `watching…`; manual refresh always available; MIN_BUSY hysteresis |
| Overlay transform drift from canvas | same wrapper/ResizeObserver; drill step 3 vision-verifies alignment |
| Identifier heuristic disagreement | single `IDENTIFIER_RE` — by construction |
| Wheel scroll hijacked by page scroll | `preventDefault` on canvas wheel only; page unaffected elsewhere |
