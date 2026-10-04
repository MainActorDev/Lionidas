## Variant: B — Mission-control stance

### Design stance
A QA workstation: left rail owns controls (device, lifecycle, environment), right rail owns always-on watchers, device centered between them.

### Key choices
- Layout: 3-column grid (264px / fluid / 300px), collapsible sections per rail
- Device list with boot state inline — multi-device switching is native
- Watchers are ALWAYS visible: session state, live run steps with progress meter, traffic, captures
- Drive actions in a compact bar under the bezel (take control / inspect / screenshot)

### Trade-offs
- Strong at: everything visible at once; run-watch + drive simultaneously; scales by adding sections
- Weak at: least "device-first" feel — the bezel shares the stage with two rails; more visual noise

### Best for
The QA operator who drives WHILE watching a run, traffic, and session health — the daily-workstation case.
