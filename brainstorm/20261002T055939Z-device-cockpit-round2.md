# Device cockpit — scope expansion round 2 (T1 menu, split view, AI chat, logs, …)

- Source prompt: "WE're still brainstorming. I prefer top menu t1. I also want a split view, for example to watch/control two or three (probably MAX) devices simultaneously. But only the active tab is getting controlled. Also, this page is one of the pages where we will implementing the AI chat feature (while device booted and everything). I also want to see the device run logs. And so on and so on. You should think of more possibilities of what we can do in this newly screen."
- Created: 20261002T055939Z
- Status: **Direction selected — DESIGN LOCKED** (spec = `sketches/022-cockpit-final2-single-switch/`, 2026-10-02)

## Goal and context

Round 2 of the cockpit brainstorm. The operator picked the **T1 menu bar** as the top-menu concept and expanded the page's ambition: multi-device split view (2–3 devices, **only the active one controllable**), an **AI chat panel** on this page (agent surface, first chat-enabled page), **device run logs**, and an open invitation to propose more ("and so on and so on"). This is becoming the flagship surface of Lionidas — drive, watch, talk to the agent, read logs, all around live devices.

## Confirmed inputs and decisions (operator, this session + prior)

- **Top menu = T1 menu bar** (word-menus pull down; status right; accelerators). (verbatim: "I prefer top menu t1")
- **Split view**: 2–3 devices simultaneously (MAX 3), watch all, **control only the active tab/device**.
- **AI chat on this page**: "one of the pages where we will implementing the AI chat feature (while device booted and everything)" — the agent conversation surface lands here.
- **Device run logs**: visible on this page.
- Prior locked: A+B hybrid chassis (centered devices, ONE reusable watcher rail, environment drawer, session-lost honesty); side-panel container must be REUSABLE (operator: "Side panel container should be reusable"); act-class stays human (chat drafts/reads, never plays).
- Verified server facts (2026-10-02): manual session lease is per-device `manual:<sessionId>` (automated runs blocked while held — queue semantics already device-scoped); stream WS per device (`/api/devices/:udid/stream`, watch-frame routes); no simulator log-tail route exists yet (log streaming would be NEW server work — `simctl spawn booted <udid> log stream` is the known mechanism); agent conversation API + `agent.turn` bus events already exist; MCP instructions already describe the cockpit-adjacent tools.

## Exploration

### The chassis with T1 + split + chat

- **T1 menu bar** on top (file/device/app/environment/view menus + right status cluster).
- **Split stage**: 1 device = full center (current hybrid); 2 = side-by-side; 3 = two top + one bottom (or 3-across at wide viewports). Each cell: bezel + stream + per-device chips (session/state). **Active cell** gets the ember border + is the only one receiving input; clicking a cell activates it (the "tab"). Inactive cells are live thumbnails (watch-only) — the lease stays with ONE device at a time, matching the single manual-session model.
- **Watcher rail** (reusable component) shows the ACTIVE device's data; a device tab strip above the rail switches context without touching the stage.
- **AI chat panel**: mounts in the reusable right-rail container as another section/page — or as a drawer from the right. Chat coexists with watchers (tabs within the rail). The agent can SEE the active device context (device id, current screen, active run) in its prompt context — "while device booted and everything".
- **Logs**: a watcher-rail section (tail, filterable) per active device + optionally a bottom drawer for full-height log reading.

### More possibilities (the "and so on" — proposals, not accepted)

**Strong candidates (existing server capability, high value):**
1. **Quick-play from cockpit**: pick a case from the file menu / run watch section → plays on the ACTIVE device (human-triggered; agent stays authoring-only). The run watch section then tracks it live.
2. **AX tree browser**: inspect mode already captures the tree — a rail section that shows the hierarchy of the current screen (search identifiers/labels), click-to-highlight on stream. Huge for case authoring.
3. **Screen-state chips**: current screen + state from the registry shown under the active bezel (grounds `expect screen` authoring in what's live).
4. **Capture strip**: latest screenshots inline in the rail; click → full viewer with evidence metadata.
5. **Device pair presets**: save a split arrangement (e.g. "SG + MY regression pair") as a named layout — one menu item restores it.

**New server work (flagged, each is a plan of its own):**
6. **Log streaming** (`simctl log stream` per device over WS) — new route + process supervision; high value for triage.
7. **Multi-device manual compare**: record the same flow on 2 devices (macro record → replay on the second) — extends manual sessions beyond one.
8. **Agent device-awareness**: agent tools gain `device.state.get` (active device, frontmost app, current screen) so chat answers are grounded in what you're looking at.

**Explicitly out (reaffirmed):** agent playing cases / touching devices; auto-activation.

### Risks

- Split view multiplies stream bandwidth (3 WS streams); mitigations: inactive cells at lower fps/scale (`set_fps`/`set_scale` already in the stream protocol — Baguette-derived).
- Input routing must be unambiguous (active-only control is the operator's rule — enforce visually + at dispatch).
- Chat + watchers sharing the rail could crowd; tabs inside the rail are the pressure valve.
- Log streaming is a new long-lived process per device — lifecycle/cleanup needs care (idle watchdog pattern applies).

## Locked spec (operator: "the design locked", 2026-10-02)

- Sketch `022-cockpit-final2-single-switch/` is the 1:1 spec.
- Resolved by the lock: chat placement = **rail tab** (watch|chat); multi-device = **switcher tabs, one spacious device** (NOT split); logs = **rail section** (compact tail).
- Round-1 build = chassis (T1 menubar + switcher + single device stage) + reusable rail (WatcherPanel: session/run-watch/logs/traffic) + chat tab (agent conversation API) + env drawer (SideDrawer) + session-lost honesty. Possibilities list (#1-#8) stays PARKED for later rounds, except what the spec depicts: quick-play menu item (run menu), screen-state chip, captures count in status. Log STREAMING server work stays out of round 1 unless the plan review says otherwise — the rail section ships with the run-log rows already available.

## Open questions (superseded — kept for provenance)

1. **Round-1 scope**: is the first build chassis + T1 + split(2-3) + logs-section + chat-tab (the confirmed set), with the "possibilities" list parked for later rounds? Or does something from the proposal list belong in round 1 (my suggestion if any: AX tree browser — it's inspect-mode data already flowing)?
2. **Chat placement**: rail tab (shares the panel with watchers) vs right drawer (chat gets full height on demand)?
3. **Logs placement**: rail section (compact tail) vs bottom drawer (full-width reading)? Both feasible; affects round-1 size.

## Next step

Answer the three; then this artifact closes (Direction selected) → `hms-plan-from-brainstorm` → breakdown → build on `feat/device-cockpit`. One more sketch round first ONLY if the operator wants to see the T1+split+chat composition before committing.
