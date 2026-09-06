# Headless simulator boot (agent-device → alloy → Crucible)

Status: **SHIPPED + live-verified 2026-09-06** — commits:
agent-device `4ad7a98`, alloy `3017b56`, crucible `54dce65`.
Date: 2026-09-06

## Plain English summary

Booting a simulator through Crucible's power button opens the Simulator.app
GUI window on the Mac. For an automation dashboard that window is pure noise
(focus-stealing, screen clutter) — everything Crucible does (stream,
snapshots, taps, screenshots) works without it. agent-device already has a
`--headless` boot flag, but it only works for Android emulators; asking for
it on an Apple simulator is rejected. This plan teaches Apple simulators the
same flag (headless = skip `open -a Simulator`), threads it through alloy,
and makes Crucible's boot button use it.

## Root cause (verified by code read, 2026-09-06)

Two `open -a Simulator` sites exist in agent-device's Apple platform:

1. **The `boot` command path** (the one Crucible hits):
   `session-state.ts` handler → runtime bind → `platform-apple/src/runtime.ts`
   `bootTarget` op → `ensureAppleReady()`
   (`packages/platform-apple/src/readiness/runtime.ts:43`) → `showSimulator()`
   runs `open -a Simulator` after every cold boot.
2. **The implicit session path**: `ensureDeviceReady()` → core
   `ensureBootedSimulator()` (`core/simulator.ts:216`) → `openIosSimulatorApp()`.
   Only reached when a session cold-boots a shutdown sim (pre-existing,
   out of scope here — noted as follow-up).

The plumbing for `headless` ALREADY EXISTS end-to-end for Android:
CLI flag `--headless` (`flag-definitions-target.ts:61`, already in
`PROJECT_CONFIG_FLAG_KEYS`) → programmatic `DeviceBootOptions.headless`
(`packages/contracts/src/client-device-view.ts:103`) → daemon handler
`session-state.ts:228` `resolveDeviceReadinessRuntimePlan({headless})` →
plan `boot-target-headless` → admission checks the `bootTargetHeadless`
facts cell → Apple runtime hardcodes it unavailable
(`platform-apple/src/runtime.ts:331` `headlessUnavailable`, hint "local
Android emulators"). **The only Apple-side gap is that facts cell + op.**

## Tasks

### Task 1 — agent-device: Apple `bootTargetHeadless` cell (TDD)

Files:
- `packages/platform-apple/src/readiness/runtime.ts`
  - `AppleReadinessOptions` gains `headless?: boolean`.
  - Cold-boot branch: `if (!options.headless) await showSimulator(...)`.
  - Existing tests unaffected (default = current behavior).
- `packages/platform-apple/src/runtime.ts`
  - Facts: `bootTargetHeadless: device.kind === 'simulator' ? boot : headlessUnavailable`
    (macOS/watchOS/physical stay unavailable — the flag means "no GUI
    window", meaningless where no window would open; matches the Android
    emulator-only precedent).
  - Op: `whenAdmitted(facts.operations.bootTargetHeadless, () => ({
      bootTargetHeadless: async () => await ensureAppleReady(host, request.device,
        request.scope.signal, { headless: true }) }))`.
  - Update `headlessUnavailable` hint → "local Android emulators and Apple
    simulators."
- `src/daemon/handlers/session-state.ts` — stale message
  "boot --headless is supported only for Android emulators." → append Apple
  simulators (only shown for genuinely unsupported cells now).
- Android-specific guard at `session-state.ts:241-249` (stopped-AVD
  selection hint) stays — it is about `--device <avd>` resolution, not the
  platform gate.

Tests (mirror topology):
- NEW `packages/platform-apple/src/readiness/runtime-headless.test.ts`:
  host.commands spy — cold boot WITHOUT headless runs `open -a Simulator`;
  WITH headless skips it; warm boot never calls it either way.
- `packages/platform-apple/src/runtime` facts test: bootTargetHeadless
  available on iOS simulator, unavailable on macOS/watchOS/physical.
- UPDATE the two daemon tests that assert rejection:
  - `src/daemon/handlers/__tests__/session-state.test.ts:22` ("boot rejects
    --headless outside Android directly") — keep a rejection case for
    macOS/physical, add an admission case for iOS simulator.
  - `src/daemon/handlers/__tests__/session-boot-shutdown.test.ts:289`
    ("rejects non-Android selectors") — retitle/re-scope to non-headless
    platforms.
  - `src/daemon/handlers/__tests__/session-command-harness.ts:125`
    `headlessAvailable` fact: add `|| (platform apple && kind simulator)`.
- `scripts/integration-progress-model.ts:341` — key already classified; no
  change expected, verify gate passes.

Gate: `pnpm check:affected --run` (oxc + tests + layering/budget scans).
Stage new files before trusting the layering scan (repo rule).

### Task 2 — alloy: thread `headless` through `alloy_devices`

- `src/adapter-a.ts:26` — `boot(options?: { udid?: string; headless?: boolean })`.
- `src/registrations.ts` boot branch — `opt(o, 'headless', d.headless)`
  (same opt helper as udid; input shape `d` cast gains `headless?: boolean`).
- Test: registrations/boot unit — dispatch `alloy_devices {action:'boot',
  udid, headless:true}` reaches `client.devices.boot({udid, headless:true})`.

### Task 3 — Crucible: power route boots headless

- `server/src/routes/devices.ts` — boot dispatch payload gains
  `headless: true` (shutdown unchanged; the alloy_devices input type in
  crucible's alloy/client.ts gains the field).
- Test: devices-route test asserts the boot dispatch carries `headless: true`
  and shutdown does not.
- Skill/docs: device-wall section note — power-button boots are headless now.

### Task 4 — Live drill (human-visible proof)

1. Quit Simulator.app, shutdown the target sim.
2. `POST /api/devices/:udid/power {action:'boot'}` via Crucible.
3. Assert: run ok, `simctl list` shows Booted, **pgrep Simulator.app empty**.
4. Stream + snapshot + a template run still work on the headless-booted sim
   (proves no functional regression — the GUI was never load-bearing).
5. Control: `agent-device boot` (CLI, no --headless) still opens the GUI —
   default behavior for human users unchanged.

## Edge cases

| Case | Behavior |
|---|---|
| Already booted + headless boot | No-op open either way (open only runs on cold boot) |
| macOS desktop target + --headless | Rejected (facts cell unavailable) — INVALID_ARGS |
| Physical iPhone + --headless | Rejected — the flag names a GUI window that doesn't exist |
| watchOS + --headless | Rejected (boot itself unavailable there) |
| Old daemon + new client sends headless | Daemon ignores unknown flag → GUI opens (fail-open, benign) |
| Managed/allocator-owned device | Withheld cell (unchanged) — allocator owns lifecycle |
| `open` command / session cold boot (path 2) | Still opens GUI — OUT OF SCOPE, follow-up if wanted |

## Out of scope (explicit)

- Path-2 `ensureDeviceReady` cold-boot GUI open (session-resolution boots).
  Same one-line skip available if the user wants it later.
- Device Hub variants (`openIosSimulatorApp` deviceHub arg) untouched.

## Self-review notes (post-verification 2026-09-06)

- [x] `opt()` in alloy is exactOptionalPropertyTypes-safe (`registrations.ts:47`)
- [x] Crucible's power route calls alloy's adapter method directly; alloy's
      registrations layer is where `headless` enters; the client projection
      (`prepareDaemonCommandRequest` → `direct('boot')` → `buildRequestFlags`)
      already maps unknown→flags for schema'd keys (`headless` is schema'd)
- [x] spy surface for the GUI-open assertion = `host.commands.run` (fixture
      `logs/runtime.fixtures.ts:60`, overridable via `commandRun`)
- [x] `simulator()` test factory lives in `readiness/runtime.test.ts:157`
- [x] headless never reaches `focusExisting` (different seam, verified)
- [x] harness fact `headlessAvailable` (session-command-harness.ts:125) must
      gain the Apple-simulator arm or the daemon test gate fails
