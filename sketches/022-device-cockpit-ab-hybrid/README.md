# 022-AB — Device Cockpit hybrid (A top + B selective panels)

## Screen contract

```yaml
screen: device cockpit
user_goal: drive a device manually while watching live test activity
primary_action: take control (starts/holds the manual session)
hierarchy:
  primary:   [centered live device stream]
  secondary: [right rail: live watchers — session, run steps, traffic]
  tertiary:  [top toolbar: drive/capture/device/app/environment groups; environment drawer on demand]
states:
  - no-session (page load, device booted, stream idle)
  - session-live (lease held, chip on stream, watchdog ticking)
  - inspect-on (AX boxes over stream, toggle lit)
  - run-watching (active run steps streaming in right rail)
  - session-lost (410 class → honest banner, re-take control)
actions:
  - take control → session chip appears + toolbar state flips; failure → honest error row
  - inspect → boxes overlay canvas; never dispatches on click (invariant)
  - network scenario → opens environment drawer; activate → scenario chip in toolbar + traffic watcher labels presets
animation:
  - drawer slide 180ms (state change: hidden→context available); reduced-motion → instant
accessibility:
  - keyboard: toolbar buttons reachable; focus ring on ember
  - symbols-not-color for status (✓ ◆ ◌)
```

## Design stance

A's chrome discipline + B's selective permanence. **One** persistent rail (right — watchers are glanced at *while* driving, so they earn placement). Left controls collapse into the toolbar + a single environment drawer: not everything deserves a panel. Device gets the full center.

## Panels decision (what earned its place)

| Surface | Placement | Why |
|---|---|---|
| Watchers (session/run/traffic) | RIGHT rail, persistent | Live data consumed peripherally while hands drive |
| Device lifecycle/app | Toolbar group (A) | Point-in-time actions, no live state to watch |
| Environment (network/location/env) | Drawer from toolbar (A) | Set-and-forget; current state shown as toolbar chips |
| Captures | Toolbar group | Point-in-time |
