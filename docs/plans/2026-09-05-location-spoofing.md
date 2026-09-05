# Location spoofing (Tier 2.3 — the one worth building)

Status: DRAFT — awaiting human gate
Date: 2026-09-05
Research: `docs/research/2026-09-05-tier2.3-capability-pipes.md` (live-proven
on iPhone 16 sim A2102153, iOS 18.6, this Xcode)

## Goal

A template step that pins the device's simulated GPS position, so
location-branching LP flows (courier coverage, "available in your area",
address detection) become testable. Playback dispatches
`xcrun simctl location <udid> set "<lat>,<lon>"` — the public verb
Xcode's own Simulator ▸ Location menu uses. No private APIs, no dylibs.

## Scope (deliberately minimal)

IN:
- One step action: `location` (single point; `set` verb).
- One device-prep concern solved once: CoreLocation permission, via a
  TCC-row writer (the `simctl privacy grant` no-op workaround).
- Evidence: step rows record what was set.
- Clear-at-run-end (hygiene — a pinned location must not leak into the
  next template on the same device).

OUT (rejected for v1 — Baguette's polish, not test automation):
- Routes (`start` waypoints) — no test case needs movement yet; the verb
  is verified working, one branch to add later.
- Joystick / Leaflet map / replay UI — manual-exploration product, and
  our users write YAML.
- `simctl location run <scenario>` (City Run etc.) — same later-add path.
- Compass (`CLHeading`) — **impossible**: sims have no magnetometer.

## Design decisions (settled in research)

1. **YAML shape mirrors `alert`** — the existing scalar-action precedent
   (parse: case-yaml.ts:202-209; dispatch: playback.ts:776-791; both
   have "no coordinate state, execute and move on" semantics). But a
   coordinate is a mapping, not a scalar, so the shape is:
   ```yaml
   steps:
     - location: { latitude: -6.1754, longitude: 106.8272 }
   ```
   (flow-mapping style, like `tap`'s body). Also accepted:
   `location: -6.1754,106.8272` (single string token — the simctl wire
   format; handy for paste-ins). Parser normalizes both to
   `{latitude, longitude}` numbers.
2. **Locale/format guards in the parser** (not at dispatch): reject
   comma-decimal input (`-6,1754`) with a line error before a run ever
   starts — fail at save-time, never mid-run. Latitude ∈ [-90, 90],
   longitude ∈ [-180, 180].
3. **`grant-location` is a device-prep step, not an action**: a checkbox
   or explicit step is wrong; permission is a per-device-per-app fact.
   v1 shape: when playback encounters `location` as the FIRST location
   step of a run AND the app's TCC row is missing, it writes the row +
   kickstarts locationd + relaunches the app once (idempotent; no-op if
   the row exists). This makes `location:` self-sufficient in any
   template without a separate grant step.
4. **Dispatch shells simctl directly** (child_process execFile) — NOT
   through alloy. Rationale: alloy verbs map to engine capabilities;
   location is a host-level device fact (like install), and `install`
   already shells simctl directly in routes/devices. One spawn ~200ms,
   fire-and-forget.
5. **Run-end hygiene in the existing finally**: `location clear` beside
   the other cleanup. A wedged clear must NOT fail the run (best-effort,
   logged).
6. **evaluated_json** for the step: `{action:'location', latitude,
   longitude}` — joins the existing per-step audit trail.

## Task breakdown (TDD each; commit each)

### Task 0 — survey (no code)
1. `YamlStep` fields: `location?: {latitude:number, longitude:number}`
   beside `alertAction` (case-yaml.ts:31).
2. `STEP_KEYS` (case-yaml.ts:48) gains `location`.
3. Completions: `yaml-completions.ts` step-key list gains `location`
   with detail text; new `location-body` completion set.
4. PlaybackStep (playback.ts:63) mirrors YamlStep.
5. Confirm execFile helper convention (install path in devices routes).
6. TCC path template: `~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/TCC/TCC.db`
   — INSERT OR REPLACE with auth_value=2 (allow), client_type=0.

### Task 1 — YAML schema + parser (shared)
RED: `case-yaml.test.ts` — mapping form parses; token form parses to
same; comma-decimal rejected with line error; out-of-range rejected;
round-trip `stepsToYaml` emits the mapping form; unknown keys in the
location body rejected.
GREEN: type + ACTIONS set + parse branch + emit branch in case-yaml.ts.

### Task 2 — completions (shared)
RED: `yaml-completions.test.ts` — `location` offered at step level;
body completion offers latitude/longitude keys; detail text correct.
GREEN: yaml-completions.ts entries.

### Task 3 — location module (server)
`server/src/manual/location.ts`: pure, execFile-injected for tests.
- `buildSetArgs(udid, lat, lon)` → `['location', udid, 'set', 'lat,lon']`
  with `.` decimal formatting (locale-independent, pinned by test).
- `buildClearArgs(udid)` → `['location', udid, 'clear']`.
- `formatCoord(n)` → `n.toFixed(6)` trimmed, dot decimal always.
- `setLocation(execute, udid, lat, lon)` / `clearLocation(...)` — wrap
  spawn, non-zero exit → Error with stderr.
RED: unit tests for arg-building (incl. negative latitude, rounding,
locale pinning) + wrappers with a fake execute.

### Task 4 — TCC grant (server)
`server/src/manual/location-tcc.ts`:
- `tccDbPath(udid)` → resolved path string.
- `ensureLocationGrant(udid, bundleId)` — SELECT the row; if missing,
  INSERT OR REPLACE (auth_value 2), then `launchctl kickstart -k
  user/foreground/com.apple.locationd` via simctl spawn, return
  {granted:true} else {granted:false} (idempotent no-op fast path).
RED: fake db + fake spawner — row missing → insert + kickstart;
row present → no writes; kickstart failure → error surfaced (honest),
permission still granted (documented: dialog may appear once, tap
through or rerun).

### Task 5 — playback dispatch (server)
In playback.ts step loop, before the alert branch (~line 776):
```ts
if (s.action === 'location') {
  if (firstLocationStepOfRun) await ensureLocationGrant(udid, appBundleId);
  const r = await setLocation(execute, udid, s.location.latitude, s.location.longitude);
  insStep.run(..., 'pass', ..., JSON.stringify({action:'location', ...r}));
  continue;
}
```
- First-of-run tracking: a `let locationGranted = false` in run scope.
- Run-end: `clearLocation` best-effort in the finally block beside
  existing cleanup.
RED: playback-location.test.ts with fake execute + fake grant fn —
step passes + evaluated_json content; grant called once (first step
only); clear called in finally; grant failure → step fails honestly.
GREEN: dispatch wiring.

### Task 6 — live drill + docs + closure
1. Restart dev stack; new template `location-jakarta`:
   `steps: [location: {latitude:-6.1754, longitude:106.8272}]` on LP app.
2. Run → verify run_taps/evaluated pass, `simctl location <udid> list`
   shows the override during run… (write-only: instead screenshot Maps
   or check step result + clear verification after run).
3. Verification without read-back: during run, `simctl io screenshot`
   of the LP app's location-dependent UI, or post-run
   `xcrun simctl location $U list` → empty after clear.
4. `docs/features/location.md` (mechanism, TCC recipe, limits:
   no read-back, no compass, course-skew note).
5. Steal-list 2.3 annotated IMPLEMENTED (location) + DEFERRED D-note
   points here; plan CLOSED.

## Self-review checklist (to run before requesting gate)

- [ ] YAML rejects comma-decimal at parse (save-time), not dispatch
- [ ] TCC write path verified against real TCC.db schema (all NOT NULL
      columns provided: service, client, client_type, auth_value,
      auth_reason, auth_version, last_modified — defaults exist for the
      rest; verify empirically in drill)
- [ ] execFile (never shell string) — no injection surface
- [ ] Grant idempotency: second run with row present performs no writes
- [ ] Clear-at-finally cannot fail the run
- [ ] Location steps don't interact with settle/sig logic (no snapshot
      needed — document why in code comment)
- [ ] Docs: no read-back, no compass, course-skew carried over
