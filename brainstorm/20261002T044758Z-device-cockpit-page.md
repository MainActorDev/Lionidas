# Full-page device control & watcher — replacing the drive side panel

- Source prompt: "I want to create a full page device control and watcher page that will be replacing the 'drive' side panel. And later we will do many things from there. If you check baguette's, it's kinda already have this kind of page. Or think of the simulator app in macOS that have all those controls. The device is centered on the full-page screen. And this new UI will need the sketches brainstorm"
- Created: 20261002T044758Z
- Status: **Direction selected — DESIGN LOCKED** (via rounds: A+B hybrid → T1 top + round-2 expansion → Final2 spec)

## Goal and context

Promote manual device control from the current side-panel/`/drive` arrangement to a **dedicated full page**: the live device screen centered, controls and watchers arranged around it — the working posture of Apple's Simulator.app and Baguette's `serve` web UI. This page becomes the future hub ("later we will do many things from there"). The operator explicitly requires the **sketch workflow** (≥3 interactive HTML variants in `sketches/NNN-*/`, user picks, picked mockup = 1:1 spec) before any build.

Interpretation (not yet confirmed): this REPLACES the drive panel's entry points rather than adding a third surface; the existing two drive surfaces (DeviceSidebar + DrivePage) eventually collapse into one.

## Confirmed inputs and decisions

- Operator: full page, device centered, replaces the drive side panel, references = Baguette's serve page + macOS Simulator.app; sketches required first. (verbatim in source prompt)
- Verified repo facts (2026-10-02):
  - Current surfaces: `DeviceSidebar.vue` (1,286 lines — the panel) + `DrivePage.vue` (527 lines) at route `/drive` (router.ts:30). The skill notes BOTH surfaces must be patched for drive UI features today — a maintenance cost this page eliminates.
  - Manual-drive mechanics (crucible skill): manual session = runs row kind=manual holding lease `manual:<id>`; tap mapping chain CSS→canvas→logical via live dims; inspect-mode overlay anchored to canvas box inside `.bezel-wrap`; idle watchdog 5 min; session-lost honest 410s.
  - House web conventions (crucible skill): Axiom system (pure black, JetBrains Mono, ember accent, symbols-not-colors, 2px corners); design-preview rule — ≥3 sketches, picked = 1:1 VERBATIM incl. page chrome; new page in a NEW file, superseded affordances DELETED; content-sized lists; every page shares the devices-page container convention.
  - Baguette reference (`Resources/Web/sim.html` + IIFE modules): bezel + screen-area DOM, capture gallery, stream session WS, boot/shutdown list controls, location map picker (Leaflet), network panel, plugin controls — i.e., a device-centered page with controls grouped around the stream.
  - Existing server capabilities already usable from a page: manual start/tap/keys, device list/boot/shutdown (CLI + routes), stream WS, inspect AX overlay, network condition/forge, location, screenshots/evidence, runs watch.
- Ports for sketch preview: sketches served at 5177 (`python3 -m http.server 5177` from `sketches/`), `::preview` in chat.

## Exploration — what "controls & watchers" could mean (the sketch space)

Control/watch inventory (all backed by existing routes; the page is composition):
- **Drive**: live stream (center), tap/type/gesture dispatch, inspect AX overlay mode.
- **Device lifecycle**: boot/shutdown/restart, erase, app install/launch (artifact picker), pin/unpin.
- **Environment**: network scenario activate/clear (forge), location set (map), env-vars, appearance/language/permission toggles (if routes exist — verify per sketch).
- **Watchers**: active run watch (steps streaming), manual session state, traffic log (forge), log tail, screenshot/evidence capture, idle/watchdog status.
- **Context**: current app/frontmost, AX tree browser, case list quick-play (future "many things").

### Layout stances for the 3 sketches (proposal — the real decision the sketches answer)

- **A. Simulator.app stance**: device centered-large; slim toolbar rows above/below (lifecycle left, env right); drawers/inspectors slide from edges on demand. Chrome minimal, canvas dominates.
- **B. Mission-control stance**: device center; LEFT rail = device + lifecycle + env controls (grouped accordion); RIGHT rail = watchers (run steps, traffic, logs) stacked live panels. Information-dense, QA-workstation feel.
- **C. Radial/command stance**: device center; contextual command bar + quick actions halo around the bezel; watchers pop as overlays/cards docked bottom; most minimal chrome, gesture-forward.

Each sketch must depict: booted+streaming state with a session, one control group open (e.g. network scenario), one watcher live (e.g. run steps or traffic), and the drive affordances (inspect toggle). Axiom tokens; real device frame proportions (e.g. 428×926); content-sized panels.

### Risks / open design facts

- The stream is WS+canvas — sketches fake it with a static device screenshot (fine; note it).
- "Replace" scope: DeviceSidebar vs DrivePage both exist; after the pick we must decide which entry points die (house rule: superseded affordances DELETED — but that's a build-plan decision, post-sketch).
- Simulator.app parallels that DON'T exist server-side yet (e.g. appearance toggles) must be verified per route before a sketch depicts them — sketches may only show capabilities that exist or are explicitly flagged future.

## Open questions

1. **Scope of v1 watchers**: which watchers are day-one (run steps? traffic log? log tail? capture gallery?) vs later? Materially changes both sketch density and build size.
2. **Multi-device**: is this page strictly one-device-at-a-time (Simulator.app style), or does it need a device-switcher/filmstrip for quick jumps? (Baguette lists multiple; Simulator.app is per-window.)
3. **Replace timing**: does the drive side panel die in the same arc (build page → delete panel) or coexist briefly behind a flag? House rule prefers clean replacement, but the operator should pick the cutover.

## Next step

Answer the three questions (or defer Q1 to "sketches show both, pick after"), then run the sketch workflow: 3 interactive variants (stances A/B/C) in `sketches/022-device-cockpit-*/`, Axiom tokens, served at 5177 + `::preview`, head-to-head table, operator picks → the picked variant becomes the 1:1 spec for the plan.
