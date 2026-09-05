# Location spoofing (Tier 2.3 — the one worth building)

Status: **IMPLEMENTED 2026-09-06** — all 6 tasks landed.
Commits: de0e4a4, 1ab86ff, 927d020, 5f719c3, eea29e9 (+ this doc update).
Feature doc: `docs/features/location.md` (authoritative).
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
3. **`grant-location` happens at RUN START, before `open`** — NOT at the
   first location step. Reason (self-review fix 2026-09-05): the app
   must RELAUNCH to pick up the TCC row (verified in research) —
   granting mid-run would force a disruptive mid-run app restart, losing
   state and evidence continuity. Playback scans the template's step
   list upfront; if ANY step is `location` → `ensureLocationGrant(udid,
   appToLaunch)` before the app opens. Idempotent; no-op when the TCC
   row exists. This mirrors the warm-up-reorder lesson (61dcab6).
4. **Dispatch shells simctl directly** (child_process execFile) — NOT
   through alloy. Rationale: alloy verbs map to engine capabilities;
   location is a host-level device fact (like install), and `install`
   already shells simctl directly in routes/devices. One spawn ~200ms,
   fire-and-forget.
5. **Run-end hygiene is CONDITIONAL** in the existing finally: only when
   the run actually set a location (a `locationSet` flag in run scope),
   `location clear` runs beside the other cleanup — a pure-tap template
   never spawns a pointless clear. A wedged clear must NOT fail the run
   (best-effort, logged).
6. **evaluated_json** for the step: `{action:'location', latitude,
   longitude}` — joins the existing per-step audit trail.

## Task breakdown (TDD each; commit each)

### Task 0 — survey (no code) — RESOLVED during self-review 2026-09-05
1. `YamlStep` fields: `location?: {latitude:number, longitude:number}`
   beside `alertAction` (case-yaml.ts:31). ✅ verified.
2. `STEP_KEYS` (case-yaml.ts:48) gains `location`. ✅ verified — but see
   D3 below: STEP_KEYS is the round-trip EMIT allowlist; the PARSER keys
   off `ACTIONS` (case-yaml.ts:50) + single-action-key rule
   (case-yaml.ts:150) + per-action branches. New action touches BOTH.
3. Completions: `yaml-completions.ts` step-key list gains `location`
   with detail text; new `location-body` completion set. ✅ verified
   (pattern at yaml-completions.ts:54).
4. PlaybackStep (playback.ts:63) mirrors YamlStep. ✅ verified.
5. execFile helper convention: `manual/app-install.ts`, `manual/apps.ts`,
   `forge/mitm/manager.ts`. ✅ verified — reuse the same execFile style.
6. TCC path template: `~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/TCC/TCC.db`
   — INSERT OR REPLACE with auth_value=2 (allow), client_type=0. ✅
   verified against live schema (all NOT NULL columns: service, client,
   client_type, auth_value, auth_reason, auth_version, last_modified —
   defaults cover the rest).
7. `appToLaunch` resolves at playback.ts:249 — the grant call site. ✅
   verified in scope of runTemplate.
8. Run-scope flags live before the step loop; the finally is at
   playback.ts:931. ✅ verified.

### Task 1 — YAML schema + parser (shared)
RED: `case-yaml.test.ts` — mapping form parses; token form parses to
same; comma-decimal rejected with line error (BOTH the mapping form —
latitude as comma-string — AND the token form `"-6,1754,106.827"`
= 3 fields); out-of-range rejected; `when`/`optional` on location
rejected (alert-style message); unknown keys in the location body
rejected; round-trip `stepsToYaml` emits the mapping form.
GREEN: type + **ACTIONS set (case-yaml.ts:50)** + parse branch beside
alert's (:202) + **STEP_KEYS (case-yaml.ts:48) for emit** +
emit branch in stepsToYaml.

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
  const r = await setLocation(execute, udid, s.location.latitude, s.location.longitude);
  locationSet = true;   // arms the conditional finally-clear
  insStep.run(..., 'pass', ..., JSON.stringify({action:'location', ...r}));
  continue;
}
```
- RUN-START grant (self-review fix): before the `open` dispatch
  (~line 249, where `appToLaunch` resolves), scan execSteps for any
  `location` action → `await ensureLocationGrant(udid, appToLaunch)`.
  Grant failure ⇒ run fails fast with a named error (better than a
  dialog-broken run mid-flight).
- Run-end: in the finally (playback.ts:931), `if (locationSet)` →
  `clearLocation` best-effort (try/catch, logged to note).
RED: playback-location.test.ts with fake execute + fake grant fn —
step passes + evaluated_json content; grant called ONCE at run start
(not per step); NO grant when template has no location steps; clear
called in finally only when a location was set; grant failure →
run fails fast.
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

## Self-review — EXECUTED 2026-09-05 (2 real defects + 3 gaps fixed)

1. **Grant timing forced a mid-run app restart** — research showed the
   app must RELAUNCH to pick up the TCC row; granting at the first
   location step (mid-run) would kill state + evidence. FIX: grant at
   run start, before `open`, gated on template-scan (any location
   step). Mirrors warm-up-reorder lesson (61dcab6).
2. **Unconditional clear-in-finally** — every pure-tap run would spawn
   a pointless simctl clear. FIX: conditional on `locationSet` flag.
3. **Parser ≠ emit surfaces** — plan named STEP_KEYS only; the parser
   actually keys off the `ACTIONS` set + single-action-key rule + a
   per-action branch. Task 1 now says BOTH (ACTIONS at case-yaml.ts:50,
   branch beside alert's at :202).
4. **Grant failure semantics unspecified** — now: run fails FAST with a
   named error at start (not a dialog-broken run mid-flight).
5. **Modifier rule check** — `location` takes NO `when:`/`optional:`
   modifiers (it always executes, like alert); parser must reject the
   combo with the alert-style message. Added to Task 1 RED list.
6. **Comma-decimal rejection**: BOTH forms must reject `-6,1754` — the
   mapping form (latitude as string with comma) AND the token form
   (`"-6,1754,106.827"` = three fields). Task 1 RED covers both.

Verified against live code: playback.ts:63 (PlaybackStep), :249
(appToLaunch), :776 (alert branch), :931 (finally); case-yaml.ts:31,
:48, :50, :150, :202; yaml-completions.ts:54; execFile precedent in
manual/app-install.ts; TCC schema columns.

Defects remaining: none known.
