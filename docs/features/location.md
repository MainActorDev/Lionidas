# Location spoofing — `location` step action

Status: **IMPLEMENTED** (Tier 2.3) — 2026-09-06
Plan: `docs/plans/2026-09-05-location-spoofing.md`
Commits: de0e4a4, 1ab86ff, 927d020, 5f719c3, eea29e9

## YAML

```yaml
steps:
  - location: { latitude: -6.1754, longitude: 106.8272 }   # mapping form
  - location: -6.1754,106.8272                              # token form
```

- latitude ∈ [-90, 90], longitude ∈ [-180, 180]; comma-decimal and
  out-of-range rejected **at save time** with line errors.
- No `when:`/`optional:` modifiers (host-level device fact, like `alert`).
- Completions: `location` action skeleton (Jakarta coords) + body keys.

## Execution semantics

- **Grant at run start** (route level, before the run row and before
  `open`): if any step is a `location` step, the run writes the
  kTCCServiceLocation row for the launch app into the device TCC.db
  (`auth_value 2`, INSERT OR REPLACE — idempotent) and kickstarts the
  USER locationd so it re-reads TCC. The app relaunch that follows is
  what picks the row up — granting at the first location *step* would
  force a disruptive mid-run restart. Grant failure →
  `LOCATION_GRANT_FAILED` (HTTP 409-style named error, no run row).
  `simctl privacy grant location` is a verified no-op on this Xcode —
  the direct row write is the workaround.
- **Step**: shells `xcrun simctl location <udid> set "lat,lon"`
  (single quoted token, dot decimal — execFile, no shell). Write-only
  verb: the step row's `evaluated_json` (`{action, set, coordinate}`)
  is the audit trail; there is no read-back.
- **Hygiene**: the run-end finally clears the override **only when a
  location was actually set** (`locationSet` flag) — pure-tap templates
  never spawn a clear. Best-effort: a wedged clear never fails the run.

## Verification standard (learned the hard way)

A location step is **not verified by its `pass`** — simctl is
write-only and can no-op silently (exit 0). Verify by:
1. locationd log during the run window: `@ClxSimulated, Fix` entries
   (1 Hz, acc ≈ 5 m) — pipe-level proof;
2. a screenshot of a live map **while the run is mid-flight or with the
   clear disabled** — post-run screenshots show the cleared state;
3. TCC row present in the device's
   `data/Library/TCC/TCC.db` after run start.

## Known issues (device-level, not this feature)

- **A long-lived device can wedge**: sim A2102153 (heavy use since the
  research session) ignored every set/clear/scenario (exit 0, no-op)
  across locationd kickstarts, CoreSimulatorService restarts, reboots,
  and Simulator.app quit; a **freshly created sim** works perfectly.
  Root cause not fully isolated (no on-disk trace found; suspected the
  host-side CoreSimulatorService per-device state). Remedy: create a
  fresh device when sets stop taking effect. Logged as a known limit.
- The TCC grant does **not** suppress the app-level "Allow Maps to use
  your location?" dialog on a truly fresh app+device combo — the row
  grants the permission, but iOS still prompts once per app; grant
  before relaunch minimizes this. Widgets dialog is separate app noise.
- Maps on a fresh sim opens on a globe view; the dot may be off-screen
  until the location arrow is tapped. Camera ≠ truth — use the log.
