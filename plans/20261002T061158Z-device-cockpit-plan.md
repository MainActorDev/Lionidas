# Device cockpit page — plan

- Source: `brainstorm/20261002T044758Z-device-cockpit-page.md` + `brainstorm/20261002T055939Z-device-cockpit-round2.md` (both closed: DESIGN LOCKED)
- Spec (1:1, verbatim): `sketches/022-cockpit-final2-single-switch/` (+ its README) — picked through the sketch chain A/B/C → A+B hybrid → T1 top-menu concepts → final composition → operator revision (one spacious device + switcher)
- Decision log (operator, verbatim): "I like the combination of A and B" · "not everything should have side panel" · "Side panel container should be reusable" · "I prefer top menu t1" · "split view… only the active tab is getting controlled" → revised: "only show a device so it's spacious. But we can switch" · "AI chat feature (while device booted and everything)" · "device run logs" · "the design locked"
- Status: **Ready**
- Baseline: `feat/device-cockpit` @ `8f2a77b` (main post-PR#14 merged + brainstorm/sketch commits)

## Objective

Build `/cockpit` — the flagship device-control page per the locked sketch: T1 menu bar, device-switcher strip (one spacious device; view+control move together), reusable watcher rail with watch|chat tabs, environment drawer. It REPLACES the drive surfaces: DeviceSidebar panel + `/drive` page are deleted in the same arc (house rule: superseded affordances are DELETED; the old page file goes, router entry becomes `/cockpit`).

## Completion conditions

1. **Reusable components first** (operator: "side panel container should be reusable"): `WatcherPanel.vue` (tabbed rail container: sections w/ collapse, step rows ✓/◆/◌, meter, log-tail block) and `SideDrawer.vue` (left slide-over, reduced-motion honored) land as standalone components with storybook-style usage tests (mount with fixtures, assert renders) — the cockpit is their first consumer, runs page can mount them later.
2. **T1 menu bar**: file/device/app/environment/run/view word-menus (dropdowns, click-outside close, accelerators displayed), right status cluster (session chip, active device name, live count). Menu contents per the locked sketch verbatim (incl. `run → play case on this device…`).
3. **Switcher strip**: one tab per booted device, ember dot = live activity (session/run), sublabel from live state (`session · <screen>` / `run n/m` / `idle`); active tab outlined; switching rebinds EVERYTHING (status bar, stage stream, rail data, chat context footer). Single manual-lease model respected: control follows the active tab.
4. **Stage**: single bezel, live stream canvas (existing WS), session chip, screen-state chip (from screens registry vs live AX), take-control/inspect/screenshot actions reachable (file/view menus + the drive affordances the sketch shows), tap mapping chain preserved exactly (CSS→canvas→logical via live dims), session-lost 410 honesty (banner + re-take; the idle-watchdog auto-finish path).
5. **Rail — watch tab**: session section (lease/dims/watchdog), run-watch section (steps live via bus events, meter), logs section (compact tail: the run_steps narrate/reason stream + forge traffic hits available today — NO new server log-streaming in round 1), traffic section (collapsed default).
6. **Rail — chat tab**: agent conversation UI (transcript, tool-call chips, device-context footer, composer) wired to the EXISTING `/api/agent/sessions*` API; turn events on the bus (`agent.turn`) drive live updates; PAT/session auth via the existing authed fetch layer. Read-only agent semantics preserved (it can see, not play).
7. **Env drawer** (SideDrawer): network scenario (activate/clear via forge routes), location, env-var overrides pointer — the locked sketch's drawer verbatim.
8. **Deletion + routing**: `/drive` route and `DrivePage.vue` removed; DeviceSidebar drive affordances removed from wherever it mounts (wall page keeps its non-drive parts); router gains `/cockpit` titled `cockpit`; nav label updates.
9. **Gates**: `pnpm build` (web) clean; server suite untouched-green; visual verification vs the locked sketch (DOM measurement + screenshot at 1280×800, states: no-session / session-live / chat-tab / env-drawer / session-lost) recorded in the PR.

## Out of scope (round 1)

AX tree browser, capture gallery viewer (rail shows counts only per sketch), device pair presets, log streaming (new server work), multi-device compare, agent device-awareness tools. Parked list lives in the round-2 brainstorm.

## Architecture

- `web/src/pages/CockpitPage.vue` (NEW file — spec-first in a new file, house rule) + `web/src/components/cockpit/` for page-private pieces (MenuBar, DeviceSwitcher, StageBezel); `web/src/components/shared/WatcherPanel.vue` + `SideDrawer.vue` for the reusable containers.
- Data: existing endpoints only — `/api/devices`, manual session routes, stream WS, bus events (`run.*`, `step.*`, `agent.turn`, `device.changed`), forge scenario routes, `/api/agent/sessions*`.
- No new server routes in round 1 (logs section renders run-step streams + traffic rows already queryable).

## Stages

- **S1 Reusable containers** (WatcherPanel + SideDrawer + usage tests) → condition 1
- **S2 CockpitPage chassis** (T1 menubar + switcher + stage with real stream + session/inspect actions; states honest) → 2, 3, 4
- **S3 Rail watch tab + env drawer** (sections wired to live data; drawer via SideDrawer) → 5, 7
- **S4 Chat tab** (conversation UI on the agent API, bus-driven) → 6
- **S5 Deletion + routing + visual verification** (drive surfaces removed; spec-vs-build screenshots recorded) → 8, 9

TDD where testable (components mount tests, switcher rebinding, menu behaviors); visual gates per the crucible skill (DOM measurement, never innerText alone).

## Edge and failure cases

- Device with no booted state / stream down → switcher tab renders `idle`, stage shows honest placeholder (not a black canvas).
- Manual session lost (server restart) → banner + re-take (the skill's known 410 class).
- Multiple devices with live runs → sublabels update from bus events; switching mid-run keeps the run visible in rail (data rebinds, run itself unaffected).
- Chat when agent provider unconfigured → the existing honest "not configured" answer renders in the transcript.
- Reduced motion → drawer/menus instant.

## Validation

- Component tests (vitest + vue test utils if present in web — verify; else mount via the existing web test setup).
- Live drill: boot stack, take control on device A, switch to B, play a case from the run menu, watch rail update, send one chat message, screenshot all five states vs sketch.
- `pnpm build` clean; repo gates green.

## Rollout

Branch `feat/device-cockpit` (current); commits per stage; PR at S5 — operator merges.
