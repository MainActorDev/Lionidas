# Inspect Mode — Drive Page

**Status:** live (2026-09-07) · **Scope:** Drive page only (watch/wall inspect deferred — needs lease policy decision)

Figma-style element inspection over the live device stream: toggle **◎ inspect**
(or `i`), every accessibility element gets a selection box; hover identifies,
click selects and opens the element drawer.

## Gesture contract

| Gesture | Drive mode | Inspect mode |
|---|---|---|
| Canvas click | taps device | **selects element — NEVER dispatches** (branch at `onTap` top; proven live by network-log: 4 clicks → 0 `/tap` calls) |
| Canvas wheel / arrows | scroll device | scroll device (always enabled — navigation, not interaction) |
| `i` / `Esc` | toggle inspect / — | toggle off / deselect → exit |
| Recording | active | paused |

## Alignment lifecycle (`useInspectTree`)

`off → fetching → aligned ⇄ realigning (→ failed)`

- Boxes render **only** in `aligned` — during motion they hide (no drifting ghosts).
- Frames feed a `SettleDetector` (`shared/frame-settle`): quiet-after-busy = refetch.
- **Refetch cooldown 2s** — carousel screens (LP Home banner) settle-burst forever;
  without the cap we hammered `/tree` ~1/s (drill-caught).
- **Quiet-at-completion gate** — a fetch landing mid-animation doesn't flash stale boxes.
- **3-strike force-align** — never-quiet screens (continuous cross-fade) align anyway
  after 3 busy completions, labeled **`animating`**: static nodes accurate, the
  animating region may drift. Sticky until scroll/interaction/refresh (flap-caught:
  non-sticky demoted aligned→realigning every frame pair).

## Drawer

type · identifier · label · rect (logical pt) · hittable · parent chain (4 hops) ·
selector preview (`on: <identifier|label>` — same `IDENTIFIER_RE` as the YAML
parser, one source) · **copy selector** · **tap this** (the ONLY deliberate
dispatch while inspecting; disabled unless aligned + hittable).

## API

`POST /api/manual/:id/tree` → `{ nodes, logicalW, logicalH, capturedAt }` —
dumb pipe, nodes verbatim. ~120ms live. 410 classes identical to tap/snapshot.
Note: `alloy_snapshot` requires a live app session — if the app process dies the
route 410s with `tree failed: … requires an active app session`; the UI shows
`tree unavailable · retry tree`.

## Hit-testing = the engine's predicate

`shared/ax-tree.ts` `hitTestNodeAt` (node-level; overlay) and `hitTestAt`
(selector policy = engine's `captureSelectorAt`, identity-pinned by test).
The overlay can never disagree with the recorder about what's under a point.

## Performance (measured)

- inspect-on → boxes: ~4s worst case on the carousel Home (3-strike), instant on quiet screens
- hover → chip: rAF-throttled math, no DOM queries
- idle: zero timers beyond a 1s settle ticker
- stream path: untouched (overlay is pure SVG, `pointer-events: none`)
