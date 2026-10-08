# Containerize Lionidas: macOS-hosted Docker + interactive first-run setup

- Source prompt: "1. Containerization. Later on, I'd like explore how we can make Lionidas also running on Linux or Windows. Even if the Apple-related dependencies not available. At least the Android and Web can. But it's for when after Android and Web implemented. Put them in deferred plan. 2. An interactive setup/installation on new machine (already dockerized/containerized)"
- Created: 2026-10-08T12:52:22Z
- Status: Direction selected — DEFERRED (see Decision 2026-10-08)

## Decision (2026-10-08, user) — containerization deferred to the end

"Defer the containerization to be the last thing to do. At least until we
have everything we need in Lionidas." Rationale recorded (assistant
analysis, user-agreed direction):
- The expensive part (DeviceProvider split, ~23 modules) would be built
  TWICE if done now — Android/Web support reshapes the provider layer.
  Doing it once, when the provider surface is known, avoids the double
  refactor.
- The cheap part (Dockerfile/compose/volumes) can start any time; nothing
  compounds by waiting.
- Current usage (single team, one Mac, LAN) has no pain that forces it.

**Milestone trigger (anti-deferral-trap): containerize when Android/Web
test support lands** — the provider seam is built in that phase anyway;
containers, the host agent, and the Linux/Windows Apple-free mode ride
the same seam in one motion. Not "someday" — a concrete event.

**Salvage item (independent, optional, near-term)**: the first-run setup
wizard does not need Docker. A host-side web wizard (/setup: admin
account creation replacing the printed seed password, env-token status,
paths, smoke decision) solves today's new-machine onboarding wart and is
reused verbatim by the container flow later. Pending user call: build
now or defer with the rest.


## Goal and context

Two asks, explicitly ordered:
1. **Containerize now** — Docker images for Lionidas on a macOS Docker host
   (this Mac today; any Mac with Docker Desktop / colima later).
2. **Interactive setup on a new machine** — first-run experience for an
   operator who has Docker: pull, run, answer questions, working system.

The user ALSO states a future direction to record but NOT build now:
Lionidas on Linux/Windows hosts with Apple deps absent (Android + Web
testing only) — **deferred until after Android and Web are implemented**.

Audience: the operator (the user + teammates). Constraint that shapes
everything: **18 server modules shell out to simctl/xcrun and 5 to
xcodebuild/xcbuddy, and the simulator ENGINE (simdeck/alloy dispatch) is
Apple-toolchain-bound — containers on macOS CANNOT run iOS simulators**
(Docker Desktop VMs are Linux; Xcode/Simulator.app do not exist there).

## Confirmed inputs and decisions

- User: containerize now; interactive setup now; cross-platform
  (Linux/Win, Android+Web-only mode) → DEFERRED plan section, after
  Android/Web exist.
- Verified: config is already env-first (`server/src/config.ts`,
  CRUCIBLE_DB_PATH/ARTIFACTS_DIR/env; Phase 2 added env secrets +
  CRUCIBLE_SMOKE=0 seam — container-shaped by construction).
- Verified: 18 modules call simctl/xcrun; 5 call xcodebuild/xcbuddy;
  smoke gate, device poller, app-install, playback, viewtree, forge
  sim-routing all Apple-bound. pnpm workspace: server (node+tsx,
  better-sqlite3 native), web (vue3+vite), shared.
- Verified today: server runs on host node v24 (nvm); better-sqlite3
  MODULE_VERSION mismatch under different node — container pins node,
  killing that class of bug.
- Verified: no Dockerfile/compose exists yet.

## Exploration

### The central fact: the simulator layer cannot live in a container

Options for WHAT to containerize:

**Option A — bind-mount the Docker socket and Xcode from the Mac (REJECTED)**
Mounting /var/run/docker.sock + Xcode paths into Linux containers cannot
work: the binaries are macOS Mach-O; simulators need host macOS frameworks.
This is not a limitation to engineer around; it's categorical.

**Option B — "everything in containers" on a macOS host (REJECTED for sim work, honest reasoning)**
Server+web+DB in Docker; simctl calls would need to exec ON THE HOST from
inside the container (docker exec trickery / SSH loopback). Fragile,
security-smell, and every dispatch gains a hop.

**Option C (RECOMMENDED) — hybrid: Docker for the platform, host for the Apple layer**
- **Containers**: server (node), web (static build served by the server or
  a tiny nginx), optional redis later. SQLite in a named volume.
- **Host agent**: a small Lionidas "device agent" process on the macOS
  host — the ONLY component that touches simctl/xcodebuild/simulators.
  It talks to the server over the Docker network (HTTP/WS).
- Consequence: the 18+5 Apple-bound modules must split behind an
  interface. That's the real engineering: `DeviceProvider` port —
  `HostSimProvider` (today's code, moved) vs future `RemoteProvider`/
  `AndroidProvider`/`NoopProvider` (the deferred Linux/Win mode).
- Interim shortcut (challenge, worth considering): **v0 = server+web
  containers, Apple calls still in the server, with `CRUCIBLE_SMOKE=0`
  and sim features degraded** — NO, wrong: server in a Linux container
  cannot simctl AT ALL (binaries absent). The honest interim is: the
  SERVER container still runs the web+API+DB+CI-build bookkeeping, and
  ALL Apple-touching routes 503 with a named `HOST_AGENT_REQUIRED` error
  until the agent split lands. Partial usefulness now, full value after
  the split.

**Option D — macVM/container-on-mac tooling (UTM VMs, Tart, OCI-on-mac runners)** (deferred-note)
Running the whole stack inside a macOS VM (Tart/Orka style) keeps
simulators working AND gives image-based reproducibility. Heavy; but it's
the natural upgrade path from C when "containerize" really means
"reproducible machine". Record as an option, don't build.

### The split (Option C's real work) — seam inventory

Layers by Apple-dependence:
1. **Pure platform** (container-ready today): auth, users, suites,
   templates, case-versions, forge presets (proxy logic), plans, overview,
   evidence store, projects/registry, manifest, build bookkeeping,
   retention, secrets mirror, agent-butler context, web UI.
2. **Apple-bound** (agent's future home): devices poller, simdeck holds,
   app-install, apps listing, playback dispatch, viewtree, location/TCC,
   keyboard-quiet, smoke gate, builds' xcodebuild/xcbuddy/scipio legs,
   forge sim-routing, diagnostics extract/ingest (ips parsing), CI clone
   could stay platform-side (git is portable) but builds' COMPILE legs
   are Apple-bound.
- Build orchestration nuance: the CI build pipeline (clone, manifest,
  bookkeeping) can stay in the server container; the compile+smoke legs
  delegate to the agent. This keeps the registry/manifest logic central
  and the agent thin (exec + stream logs back).

### Interactive setup (ask 2) — first-run on a new Mac with Docker

Shape: `docker compose up` + a guided first-run wizard.
- `lionidas setup` (a small CLI in the container, or a web /setup route):
  interactive prompts (terminal via `docker compose run`, or web wizard):
  1. admin account creation (email+password; today's seed prints a
     generated password — replace with operator-chosen on first run),
  2. env checks: CRUCIBLE_GITHUB_TOKEN / JIRA_TOKEN set? (mirror shows),
  3. device agent pairing: prints a token/URL for the host agent
     (`lionidas-agent` launchd plist or plain binary) to connect,
  4. paths: packages/repos/artifacts volumes — defaults offered,
  5. smoke gate: probe now (agent present?) → CRUCIBLE_SMOKE on/off.
- Idempotent: rerunning setup edits config, never re-seeds.
- The host agent's install is part of setup: one script/brew formula +
  a pairing code. (This is ALSO the seam the deferred Linux/Win mode
  will reuse: no agent → Android/Web providers later.)

### Risks

- The interface split is a refactor of 23 modules — the largest single
  change in the project. Mitigation: thin port interface, move code not
  rewrite, feature-parity drills per module group (the suites exist).
- better-sqlite3 native module in container: pin node version in image
  (alpine/distroless debate — better-sqlite3 needs glibc/musl match;
  choose node:22-slim (glibc) or build for alpine; test in CI).
- Long-running DB in named volume: backup story (sqlite .backup API or
  litestream later) — note in plan, not blocking.
- macOS Docker networking to host agent: host.docker.internal works on
  Docker Desktop mac; document colima equivalent.

## Open questions

1. **Scope of v1**: containerize server+web+DB now with Apple features
   behind `HOST_AGENT_REQUIRED` 503s and ship the agent split as the
   SAME phase (big), or ship containers-first + agent split as the
   immediate next phase? (Recommendation: same phase but sequenced —
   containers+degradation first commit-set, agent split second; the
   wizard lands with the agent.)
2. **Web serving**: server serves the built web statics (single
   container, simplest) vs separate nginx container? (Recommendation:
   single container serving statics; split later only if needed.)
3. **Setup UX preference**: terminal wizard (`docker compose run --
   rm lionidas setup`) vs web wizard at /setup on first boot?
   (Recommendation: web wizard — same UX on every machine, no shell
   needed; terminal wizard as a fallback CLI later.)

## Deferred plan (recorded, NOT built now — user explicit)

**Cross-platform Linux/Windows, Apple-free mode** (after Android and Web
test support exist):
- The DeviceProvider port from Option C is the exact seam: Linux/Win
  hosts run the platform with `AndroidProvider` (adb/emulator +
  gradle-build legs) and `WebProvider` (playwright/selenium drivers) —
  no Apple deps required.
- iOS testing on such hosts: only via a REMOTE mac agent (the same host
  agent, networked) — iOS becomes "optional attached capability".
- Image matrix: lionidas-server (linux/amd64+arm64), lionidas-web,
  lionidas-agent-macos (runs on mac hosts only), later
  lionidas-agent-android.
- Version stamping (Phase 2 T2) already env-driven; Android variant
  stamping maps to gradle versionName/versionCode the same way.
