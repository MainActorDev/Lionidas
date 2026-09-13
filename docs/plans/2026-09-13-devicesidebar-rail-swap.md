# DeviceSidebar Rail-Swap (sketch 007-A) Implementation Plan

> **For Hermes:** Implement task-by-task with per-task verify + commit. Design
> reference: `sketches/007-devicesidebar-rail/a-rail-swap/` (Axiom tokens, verified).

**Goal:** Replace DeviceSidebar's stacked `.workcol` sections with the A2
rail pattern — a 44px grouped icon rail + ONE swap panel — no feature loss.

**Architecture:** Pure presentation restructure of
`web/src/components/DeviceSidebar.vue`. One new presentational component
(`DeviceRail.vue`) renders the rail; panel content is the EXISTING section
templates moved into `<div v-if="activeTool === …">` shells. All script logic
(state, composables, API calls) stays untouched. Width stays 340px total
(44 rail + 296 panel) so `WallPage.vue` needs no change.

**Tech Stack:** Vue 3 SFC (script setup), existing Axiom tokens
(`web/src/styles/tokens.css`), existing `.btn/.badge/.sect-hint` classes.

---

## Current state (verified 2026-09-13)

`DeviceSidebar.vue` (~1250 lines):
- `.sb-body.cockpit` = flex row: `.devcol` (stream, persistent) + `.workcol` (340px, scrolls)
- `.workcol` has TWO variants: `v-if="phase === 'watching'"` (lines ~860–929:
  session + install app + close) and `v-else` driving (lines ~931–1060: drive
  dpad/type + inspect sect + record sect)
- Inspect sect already contains `.inspect-cluster` (InspectTools + InspectProps
  compact) + a duplicate `.el-card` facts card
- Keyboard `onKey` (line ~143): `i` inspect toggle, `esc`, `m/t/e/s`,
  `⌘⇧C` — `r` is FREE
- Rendered by `WallPage.vue:229` only. DrivePage is NOT touched by this plan.

## Target

```
.devcol (unchanged) │ rail 44px │ panel 296px (one at a time)
```

Rail groups (top→bottom), same mechanics as shipped `InspectTools.vue`:
1. **session** — session (phase-aware panel) · install (watching only)
2. **inspect** — inspect · measure
3. **record** — record
4. **actions** — screenshot · copy (instant; panel = last outcome)

`activeTool: 'session' | 'install' | 'inspect' | 'measure' | 'record' | 'shot' | 'copy'`

Tool availability: `session` + `install` (watching) always; `install`
disabled while driving; `inspect/measure/record/shot/copy` require
`sessionId` — disabled state (steel icon, tooltip "needs a session"), never
hidden (affordance discovery).

---

### Task 1: `DeviceRail.vue` — presentational rail component

**Files:**
- Create: `web/src/components/DeviceRail.vue`

**Step 1: Write the component** (complete):

```vue
/** Device tool rail (sketch 007-A): grouped icon rail that swaps the sidebar
 *  panel. Pure presentational — availability comes in as props, state lives
 *  in DeviceSidebar. Mechanics mirror InspectTools.vue (32px tools, 6px hover
 *  radius, ember on-state = border + 12% mix, CSS tooltips with kbd hints). */
<script setup lang="ts">
defineProps<{
  active: string;                       // 'session' | 'install' | 'inspect' | 'measure' | 'record' | 'shot' | 'copy'
  canInstall: boolean;                  // watching phase only
  hasSession: boolean;                  // driving-phase tools unlocked
}>();
const emit = defineEmits<{ (e: 'select', tool: string): void }>();
</script>

<template>
  <nav class="drail" aria-label="Device tools">
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'session' }" @click="emit('select', 'session')">
        <svg viewBox="0 0 20 20"><path d="M10 2a4 4 0 014 4v1h1a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2h1V6a4 4 0 014-4zm0 2a2 2 0 00-2 2v1h4V6a2 2 0 00-2-2z" fill="currentColor"/></svg>
        <span class="tip">session</span>
      </button>
      <button class="dtool" :class="{ on: active === 'install' }" :disabled="!canInstall" @click="emit('select', 'install')">
        <svg viewBox="0 0 20 20"><path d="M10 2l5 5h-3v6H8V7H5l5-5zm-6 13h12v3H4v-3z" fill="currentColor"/></svg>
        <span class="tip">install app</span>
      </button>
    </div>
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'inspect' }" :disabled="!hasSession" @click="emit('select', 'inspect')">
        <svg viewBox="0 0 20 20"><path d="M3 3h6v2H5v4H3V3zm8 0h6v6h-2V5h-4V3zM3 11h2v4h4v2H3v-6zm14 0v6h-6v-2h4v-4h2z" fill="currentColor"/></svg>
        <span class="tip">inspect <kbd>i</kbd></span>
      </button>
      <button class="dtool" :class="{ on: active === 'measure' }" :disabled="!hasSession" @click="emit('select', 'measure')">
        <svg viewBox="0 0 20 20"><path d="M2 14L14 2l4 4L6 18l-4-4zm3.2.4l1.4 1.4 8.4-8.4-1.4-1.4-8.4 8.4z" fill="currentColor"/></svg>
        <span class="tip">measure <kbd>m</kbd></span>
      </button>
    </div>
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'record' }" :disabled="!hasSession" @click="emit('select', 'record')">
        <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="10" r="3" fill="currentColor"/></svg>
        <span class="tip">record <kbd>r</kbd></span>
      </button>
    </div>
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'shot' }" :disabled="!hasSession" @click="emit('select', 'shot')">
        <svg viewBox="0 0 20 20"><path d="M7 3L6 5H3v10h14V5h-3l-1-2H7zm3 4a4 4 0 110 8 4 4 0 010-8z" fill="currentColor"/></svg>
        <span class="tip">screenshot <kbd>s</kbd></span>
      </button>
      <button class="dtool" :class="{ on: active === 'copy' }" :disabled="!hasSession" @click="emit('select', 'copy')">
        <svg viewBox="0 0 20 20"><path d="M6 2h9v11h-2V4H6V2zm-3 3h9v13H3V5z" fill="currentColor"/></svg>
        <span class="tip">copy spec <kbd>⌘⇧C</kbd></span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.drail {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  width: 44px; padding: 10px 0; flex: none;
  border-right: 1px solid var(--color-iron);
  background: var(--color-carbon);
  overflow-y: auto;
}
.dgroup { display: flex; flex-direction: column; gap: 6px; }
.dgroup + .dgroup { padding-top: 8px; border-top: 1px solid var(--color-iron); }
.dtool {
  position: relative; display: grid; place-items: center;
  width: 32px; height: 32px; border: 1px solid transparent; border-radius: 6px;
  background: none; color: var(--color-fog);
  transition: color var(--t), background var(--t);
}
.dtool svg { width: 16px; height: 16px; }
.dtool:hover { color: var(--color-paper); background: var(--color-graphite); }
.dtool.on {
  color: var(--color-ember); border-color: var(--color-ember);
  background: color-mix(in srgb, var(--color-ember) 12%, transparent);
}
.dtool:disabled { color: var(--color-steel); cursor: not-allowed; background: none; }
.dtool .tip {
  position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%);
  background: var(--color-graphite); border: 1px solid var(--color-slate);
  color: var(--color-paper); padding: 3px 8px; border-radius: var(--r-sm);
  font-size: 11px; white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity var(--t); z-index: 5;
}
.dtool .tip kbd { color: var(--color-ember); font-family: inherit; margin-left: 4px; }
.dtool:not(:disabled):hover .tip { opacity: 1; }
</style>
```

Note: tooltips fly RIGHT (rail sits left of the panel, same side as the
stream — left would overlap the stream). Verified against sketch.

**Step 2: Verify** — `cd web && pnpm exec vue-tsc --noEmit` → clean (component
unused yet, must still compile).

**Step 3: Commit** — `feat(web): DeviceRail — grouped tool rail component (007-A)`

### Task 2: Shell restructure — `.workcol` → `.toolcol` (rail + panel)

**Files:**
- Modify: `web/src/components/DeviceSidebar.vue` (template ~858–931, CSS ~1156)

**Step 1: Add state** (script, near `toolMode` ~line 301):

```ts
// 007-A rail-swap: which tool panel is shown beside the rail
type DeviceTool = 'session' | 'install' | 'inspect' | 'measure' | 'record' | 'shot' | 'copy';
const activeTool = ref<DeviceTool>('session');
function selectTool(t: DeviceTool): void {
  activeTool.value = t;
  if (t === 'inspect' && !inspect.value && sessionId.value) toggleInspect();      // entering the tool turns inspect ON
  if (t === 'measure' && sessionId.value) { if (!inspect.value) toggleInspect(); toolMode.value = 'measure'; }
  if (t === 'inspect') toolMode.value = 'inspect';
  if ((t === 'shot' || t === 'copy') && sessionId.value) {
    // instant actions: run once, panel shows the outcome
    if (t === 'shot') void captureShot(); else void copySpec();
  }
}
const canInstall = computed(() => phase.value === 'watching');
```

**Step 2: Replace the workcol wrapper** — both phase variants become ONE
structure. Template becomes:

```html
<!-- tool column: rail + ONE swap panel (007-A) -->
<div class="toolcol">
  <DeviceRail :active="activeTool" :can-install="canInstall" :has-session="!!sessionId" @select="selectTool" />
  <div class="toolpanel">
    <!-- session panel: phase-aware -->
    <div v-if="activeTool === 'session'" class="tpane">
      <template v-if="phase === 'watching'">
        <!-- MOVE VERBATIM: watching session sect body (app select, show-system
             checkbox, take control button, error) — lines ~862–881, minus the
             .sect/.sect-label wrapper -->
      </template>
      <template v-else>
        <!-- MOVE VERBATIM: drive sect body (dpad, type-box, release, error,
             busy) — lines ~937–958, minus wrapper -->
      </template>
    </div>
    <!-- remaining panes in Tasks 3–4 -->
  </div>
</div>
```

**Step 3: CSS** — replace `.workcol` block (line ~1156):

```css
.toolcol { flex: 0 0 340px; display: flex; min-height: 0; }
.toolpanel { flex: 1 1 auto; min-width: 0; overflow-y: auto; background: var(--color-carbon); }
.tpane { padding: 12px 14px; }
```

Also update the `@media` rule at ~1250 (`.workcol { flex: 1 1 auto; }` →
`.toolcol`). Keep `.sect-*` classes for panes that still use them internally
until Task 4 cleanup.

**Step 4: Behavior guards** — `take control` success path (`startSession`,
~line 624 where `phase.value = 'driving'`) keeps `activeTool.value = 'session'`
(USER DECISION 2026-09-13: session pane is the post-take-control landing —
dpad/type ready to drive). `endSession`/`teardownSession`/`reset` also leave
it on `'session'` (the initial value — no change needed).

**Step 5 (SELF-REVIEW FINDING — printable-key dual dispatch):** today, plain
keys (`i`/`m`/`s`/…) fire BOTH the window `onKey` handler AND — when the
canvas holds focus, which it does after any tap — `devInput.onKeyDown`, which
dispatches them as **key gestures to the device** (verified:
`useDeviceInput.ts:177-201`, printable branch posts `kind:'key'`). The rail's
`r` would type "r" into the app while switching panels. Fix in this task:

- `web/src/composables/useDeviceInput.ts` `onKeyDown`: when suspended
  (inspect ON — `setSuspended` already exists), return early for PRINTABLE
  keys only (`e.key.length === 1`); namedKeys (arrows etc.) still dispatch so
  scroll→realign keeps working. Exact guard, right after the meta/ctrl line:

```ts
    if (suspended && e.key.length === 1) return; // tool shortcuts (i/m/r/…) are app keys while inspecting
```

(verify the `suspended` variable name inside the composable first — grep
`setSuspended` for the closure field).

**Step 6: Verify** — vue-tsc clean; wall loads; watching shows session pane
(app select + take control) with rail beside it; install pane reachable.

**Step 7: Commit** — `feat(web): sidebar toolcol shell — rail + swap panel`

### Task 3: Move install + drive/session panes

**Files:** Modify `DeviceSidebar.vue` only.

**Step 1:** Move the install sect body (artifacts browser rows, mac-apps
toggle, install button, msgs — lines ~882–925) verbatim into
`<div v-else-if="activeTool === 'install'" class="tpane">` — keep a
`sect-label` header ("install app") inside the pane for orientation.

**Step 2:** Drive pane (session/driving): dpad, type-box, release from the old
drive sect, plus the sect-state ("driving") header. Close button moves to the
session/watching pane bottom (stays `emit('close')`).

**Step 3: Verify** — vue-tsc; live: watching → install pane browses artifacts
(against running API); take control → session pane shows dpad/type; scroll
buttons still dispatch (tap canvas sends tap when inspect OFF).

**Step 4: Commit** — `feat(web): install + drive panes into rail swap`

### Task 4: Inspect + measure + record + action panes

**Files:** Modify `DeviceSidebar.vue` only.

**Step 1: Inspect/measure pane** — replace the inspect sect body: keep the
inspect toggle row (`◎ inspect` button + treeLabel badge + retry tree) at the
pane top, then the EXISTING `.inspect-cluster` (InspectTools + InspectProps
compact) exactly as today, then DELETE the `.el-card` block (its facts are
already in InspectProps header/type rows + Element section via the props wired
on DrivePage — wire the same here):

```html
<InspectProps compact :node="selNode" :parent="selParent" :siblings="selSiblings"
  :sample="sample" :loading="sampleLoading" :failed="sampleFailed" :show-estimates="showEst"
  :hittable="selNode.hittable ?? false" :path="parentChain(selNode).join(' › ')"
  :selector-text="selPreview?.text ?? ''" show-actions
  :tap-disabled="busy || tree.state.value !== 'aligned' || !selNode.hittable"
  @tap="tapThis" @copy-selector="copySelector" />
```

`measure` shares this pane (v-else-if groups both) — the rail's measure tool
only differs by `toolMode` (Task 2 logic), redlines switch to gaps.

**Step 2: Record pane** — move the record sect body verbatim (assert-box,
assert feedback, steps list w/ thumbs, record/pause button, save form) into
`<div v-else-if="activeTool === 'record'">` with the live/steps sect-state
header kept.

**Step 3: Action outcome panes**:

```html
<div v-else-if="activeTool === 'shot'" class="tpane">
  <div class="sect-label"><span>screenshot</span></div>
  <p class="sect-hint">{{ actionMsg || 'press the camera tool (s) to capture the current screen' }}</p>
  <button class="btn btn-sm" style="margin-top: var(--s-2);" @click="captureShot">capture again</button>
</div>
<div v-else-if="activeTool === 'copy'" class="tpane">
  <div class="sect-label"><span>copy spec</span></div>
  <p class="sect-hint">{{ actionMsg || 'select an element, then ⌘⇧C to copy its JSON spec' }}</p>
</div>
```

**Step 4: Keyboard** — extend `onKey`:
- `i`: unchanged (toggleInspect) + `activeTool.value = inspect.value ? 'inspect' : 'session'`
- `m`: set measure tool via `selectTool('measure')` when inspect on (existing
  branch keeps toggling `toolMode` — route it through selectTool for panel sync)
- `r`: `selectTool('record')` (new; recorder toggle stays a button inside the pane)
- `s` / `⌘⇧C`: after action, `activeTool.value = 'shot' | 'copy'` so the outcome pane shows

**Step 5: Verify** — vue-tsc + oxlint; live drill (below).

**Step 6: Commit** — `feat(web): inspect/record/action panes — rail swap complete`

### Task 5: Cleanup + full verification

**Step 1:** Delete now-unused CSS (`.workcol`, `.el-card/.el-name/.krow` if
orphaned — grep first), drop dead `inspect-cluster` margin styles if the pane
replaces them.

**Step 2:** Full gates:
```bash
cd web && pnpm exec vue-tsc --noEmit && pnpm exec oxlint src && pnpm build
cd ../server && CI=true pnpm vitest run --maxWorkers=2   # untouched code, regression only
```

**Step 3: Live drill** (stack must be running; see crucible skill for mint
+ cookie): wall → device sidebar →
1. watching: session pane (take control), install pane (artifacts load)
2. take control → pane auto-switches to inspect; `i` off → session pane w/ dpad
3. inspect: click element → cluster + Element section + actions; `m` → gap redlines
4. `r` → record pane; start recording; switch tools while recording → steps keep polling (recorder survives panel switches)
5. `s` → shot pane shows outcome msg; `⌘⇧C` → copy pane
6. finish session → rail disables inspect/record/shot/copy; session pane returns
7. layout: total width 340, no horizontal scroll at 1280 and 1440 viewport; rail tooltips fly right, not over the stream

**Step 4: Commit** — `chore(web): sidebar rail cleanup + drill notes`

---

## Files changed summary

| File | Change |
|---|---|
| `web/src/components/DeviceRail.vue` | NEW — presentational rail |
| `web/src/components/DeviceSidebar.vue` | template restructure (workcol→toolcol), +activeTool/selectTool, onKey extensions, CSS |
| `web/src/pages/WallPage.vue` | NONE (340px preserved) |
| server | NONE |

## EDGE-CASE TABLE (user directive 2026-09-04)

| Case | Behavior |
|---|---|
| No session (watching) | inspect/measure/record/shot/copy disabled (steel + tooltip); session+install active |
| Plain keys with canvas focused + inspect ON | printable keys suppressed in devInput (Step 5 guard) → tool shortcuts never type into the app |
| `install` while driving | tool disabled (`canInstall` false) — matches current watching-only sect |
| Session dies mid-inspect (410) | existing tree error path; retry-tree button remains in inspect pane |
| Recorder live + tool switch | recorder state/poll lives outside activeTool — keeps polling; red dot visible only via record pane (accepted: status chip in rail is YAGNI for v1) |
| type-arm persists across pane switches | typeText/lastTap state survives; switching back to session pane shows armed box |
| Inspect OFF + measure tool | selectTool('measure') turns inspect ON first (measure needs the tree) |
| selNode null in inspect pane | InspectProps empty state + existing sect-hint (kept) |
| shot/copy with no selection | captureShot works (whole canvas); copySpec shows "select an element first" in actionMsg |
| takeControlBlocked (run active / lease elsewhere) | blocking reason tooltip logic stays in session pane verbatim |
| Narrow viewport (<1250) | toolcol flexes exactly as workcol did (@media update) |
| Double-click rail tool | idempotent select; inspect toggle NOT re-fired when already on |

## Risks / trade-offs

- **Shot/copy duplication**: rail actions group + InspectTools sub-rail both
  expose screenshot/copy (same handlers). Accepted for v1 — removal would need
  InspectTools props to hide its third group.
- **Recorder status not visible from other panes** (v1): switching to record
  pane is one click; a rail badge is trivial to add later.
- Template move = high diff noise; mitigated by verbatim moves + per-task
  live verification.

## Open question (default chosen)

Post-take-control auto-switch: **inspect** (chosen — the dominant QA flow;
matches sketch A's default panel). Say so if you'd rather land on session.
