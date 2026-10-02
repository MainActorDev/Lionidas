# Step 2 — CockpitPage chassis: T1 menubar + switcher + stage

- **Status:** Ready
- **Plan:** rev 2, Stage S2, conditions 2, 3, 4; review F5 (chip ladder), F6 (router)
- **Repo:** Step 1 head · **Depends on:** Step 1 (test infra runs; shared components exist)

## Outcome

`web/src/pages/CockpitPage.vue` (NEW FILE) + `web/src/components/cockpit/{MenuBar,DeviceSwitcher,StageBezel}.vue`; routed at `/cockpit` (`meta: { title: 'cockpit' }`). No rail content yet (S3), no chat (S4), no deletion (S5).

## Implementation

### 2a. `MenuBar.vue` — T1 word-menus (sketch verbatim)

- Six menus: file (new session/screenshot/captures), device (boot…/restart/shutdown/erase), app (install/launch/terminate), environment (scenario radios + set location/env vars — items OPEN the drawer, S3 wires real actions), run (play case… / watch active run), view (inspect toggle ✓ / rail ✓ / chat).
- Behavior: click opens (only one open), click-outside closes, item hover; accelerators right-aligned; act-items ember. Keyboard: Escape closes.
- Status cluster (right): session chip (`MANUAL · <min>m` | none), active device name, `◆ N devices` live count.
- Emits semantic events (`play-case`, `boot-device`, `restart`, …) — the PAGE owns side effects; MenuBar is pure UI.

### 2b. `DeviceSwitcher.vue`

- One tab per device from `/api/devices` (poll + `device.changed` bus events); tab = name + sublabel + ember dot when live activity.
- Sublabel source (cheap, existing): active manual session (per-udid `manual_sessions` check via `/api/devices` fields where available — ground at write time; else derive from lease state the sidebar already exposes) → `session · <state>`; active run on device → `run <n>/<m>` (from bus `run.*` events); else `idle`.
- Active tab: ember outline; click → `switch(udid)` — the PAGE rebinds everything (stream, rail, chips, chat ctx).

### 2c. `StageBezel.vue` + the stage

- Reuse `useDeviceStream()` (web/src/composables/deviceStream.ts — StreamState machine already exists) mounted per ACTIVE device only; switching tears down + reattaches.
- Drive actions: take control → `POST /api/manual/start {udid}` (returns sessionId + logicalW/H — the tap-mapping dims), release → finish route. Tap/type/swipe dispatch through the EXISTING input composable paths (DeviceSidebar's input logic is the reference — port the calls, not the component).
- Inspect toggle: view-menu ✓ + keyboard ⌘I; overlays anchor to the CANVAS box (the bezel-inset lesson — `.bezel-wrap` pattern from the skill).
- Chips: session chip (lease held); screen-state chip via F5 ladder: (1) active run's arrival screen (bus run.plan/run events), (2) manual inspect data when flowing, (3) `—`.
- Session-lost: any 410 from a manual call → banner `session lost — take control again` + auto-release state (skill-documented class).

### 2d. Router

`router.ts`: add `/cockpit`; `/drive` STAYS until S5 (no dangling nav edits).

## Verification (TDD + live)

- Mount tests: MenuBar opens/closes/click-outside/Escape; item emits event; DeviceSwitcher renders tabs + dot rule; switching emits with udid. StageBezel: chips render the ladder values (fixture-driven).
- Live drill (stack up + a booted sim): take control → chip appears; tap the app (canvas→logical math asserts via a probe tap at center → server-side logical coords = dims/2 ± 2); switch device → stream rebinds; screenshot the state.

```bash
cd web && pnpm test && pnpm build
```

## Completion gate

- [ ] Mount tests green; build clean
- [ ] Live: take-control → tap → switch works; session-lost banner demonstrable (restart server mid-session)
- [ ] Commit(s) pushed
