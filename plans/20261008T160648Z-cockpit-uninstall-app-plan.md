# Plan — cockpit "uninstall app" submenu

- Brainstorm: brainstorm/20261008T160648Z-cockpit-uninstall-app.md (2026-10-08)
- Status: **Ready** (all 3 open questions closed by operator: "Go with your
  recommendation. Always think about the happy path, sad path, and edge cases
  that revolves around the feature", 2026-10-08)
- Branch: `chore/sidebar-regroup-2` (cleanup branch, PR #26)

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| D1 | Menu placement: cockpit → app group → "uninstall app" | Operator, original prompt (2026-10-08) |
| D2 | Non-system apps only; target = cockpit's selected booted device | Operator, original prompt |
| D3 | Route: `POST /api/devices/:udid/uninstall` (mirror of `/install` sibling) | Operator: "go with your recommendation" |
| D4 | Running apps: uninstallable (simctl kills them); row shows running state | Operator: same |
| D5 | Role: **session-only** — same as the app-ops family (/install, /apps, open-app have no preHandler; verified manual.ts — requireRole exists only at 396/610/855, none on app ops) | Operator decision 2026-10-08: "Let's do B. I'll have a new plan later for user-related operations" — option B = match the family; the family-wide role tightening (including install) is deferred to a future user-operations plan |
| D6 | System-app gate is SERVER-side: bundle id starting `com.apple.` → 403 SYSTEM_APP | Brainstorm safety model §Exploration; operator approved the direction |

## Confirmed facts (verified 2026-10-08)

- `listSimulatorApps(udid)` exists: `server/src/manual/apps.ts:55` — catalog
  with name/version/build/path/icon/running/userFacing.
- Install pattern: `server/src/routes/manual.ts:564` POST /install — guards:
  packages-dir confinement, Booted check (409 DEVICE_NOT_BOOTED), busy guard
  (409 DEVICE_BUSY: run queued/running OR open manual session), then engine
  call with error mapping (409 in-flight / 502 failure).
- Busy-guard rationale comment: "poisons settle polls and watchdogs. Same 409
  class as install/power" (manual.ts:250) — applies equally to uninstall.
- `simctl uninstall <udid> <bundleId>` is the host op (install's sibling;
  app-install.ts:27 shows the exec pattern: `xcrun simctl <sub> <udid> …`).
- Apps-list route exists: GET `/api/devices/:udid/apps` (manual.ts:632) —
  no extra list endpoint needed; client filters non-`com.apple.*` AND the
  server re-validates at uninstall time (never trust the client filter).
- Cockpit MenuBar: `web/src/components/cockpit/MenuBar.vue` MENUS.app —
  items are {label, event} pairs; page owns side effects (CockpitPage.vue:182
  dispatches 'install' → openInstall()).
- Install modal precedent: CockpitPage `openInstall`/`runInstall` (lines
  292–297).

## Objective & completion conditions

Operators can remove any non-system app from the cockpit's selected booted
device without a terminal, safely:

1. app menu shows "uninstall app" (between "install app" and the separator)
2. picking it lists the device's non-system apps (name, version, running dot)
3. confirm names the app; uninstall executes; success/error surfaces in-page
4. `com.apple.*` is refused by the API even with a crafted request
5. busy device (run/manual session) → 409 surfaced, no uninstall
6. full gates green + live drill on a real booted simulator

## Scope

**In**: server route + guards, `uninstallApp` host op, MenuBar item, modal
(pick → confirm), error surfacing, tests (server + web), live drill.
**Out**: batch/"clean device", Android, deleting app data containers beyond
what simctl uninstall does, any wall/devices-page UI.

## Flow

**Happy**: open app menu → "uninstall app" → modal lists apps → pick →
confirm ("uninstall <name>") → POST → `{ok:true}` → modal closes, toast
"uninstalled <name>".

**Sad**: simctl fails (app vanished mid-list) → 502 with simctl's stderr
surfaced in the modal; device shuts down mid-flow → 409 DEVICE_NOT_BOOTED;
run starts between list and confirm → 409 DEVICE_BUSY with the API's message.

**Edge**:
- Crafted request names `com.apple.Preferences` → 403 SYSTEM_APP (server).
- Bundle id not installed at all → simctl non-zero → 502 honest error.
- Empty list (no user apps) → modal shows "no user apps installed".
- App is running → row shows the running state (D4); uninstall proceeds;
  the run-app/watch surfaces simply lose the app (no stale claim exists —
  run-app holds no persistent claim; manual session DOES count as busy).
- The uninstalled app is the current manual-session app → the busy guard
  already blocks this (open manual session = DEVICE_BUSY) — no special case.
- Uninstalled app is a project's claimed package → the claim is metadata
  only; uninstall does not touch claims (out of scope, noted in modal? no —
  silent, claim is version metadata not an install record).

## Implementation stages

**T1 — server** (`server/src/manual/app-install.ts` sibling +
`routes/manual.ts`):
1. `uninstallApp(udid, bundleId)` in a new `server/src/manual/app-uninstall.ts`
   (mirrors app-install.ts: execFileAsync `xcrun simctl uninstall`, 60s
   timeout, error wrapping `UNINSTALL_FAILED` + simctl stderr).
2. Route `POST /api/devices/:udid/uninstall`:
   - no preHandler (D5: session-only, matches the app-ops family)
   - body `{ bundleId }` — required, else 422
   - `bundleId.startsWith('com.apple.')` → 403 `{code:'SYSTEM_APP'}`
   - Booted check → 409 DEVICE_NOT_BOOTED (same query as install)
   - busy guard (runs queued/running OR open manual session) → 409 DEVICE_BUSY
   - call uninstallApp; map failure → 502 with error
   - audit INSERT after success (review F2): device, bundleId, operator from
     req.user (identity attribution for a destructive op)
3. Tests (`server/test/app-uninstall.test.ts`, fake simctl shim pattern from
   builds tests — NO real device needed): happy path calls simctl with the
   right args; system app → 403; not booted → 409; busy → 409; simctl
   failure → 502 with stderr; no session → 401 (the global auth gate).

**T2 — cockpit UI** (`MenuBar.vue` + `CockpitPage.vue`):
1. MenuBar MENUS.app: `{ label: 'uninstall app', event: 'uninstall' }` after
   "install app".
2. CockpitPage: `uninstallOpen/uninstallApps/uninstallPick/uninstallBusy/
   uninstallErr` refs; dispatch `case 'uninstall'` → load
   `GET /api/devices/:udid/apps`, filter `!bundleId.startsWith('com.apple.')`.
3. Modal (install-modal pattern): list rows (name, version, running dot),
   empty state, pick → confirm view ("uninstall <name>?", destructive
   styling), POST, error line, success toast, close.
4. Web test: menu item emits 'uninstall'; modal renders list + confirm +
   filters com.apple.* entries out (component-level, fetch stubbed).

**T3 — gates + live drill**:
1. `pnpm typecheck` + targeted tests + web tests + build.
2. Live drill on the real booted simulator (server 9230 up): list shows
   ios-consumer-intl; uninstall it; verify gone from list; 403 path via
   curl with com.apple.*; re-install from packages to restore state.
3. Commit to the cleanup branch (PR #26 grows) — or a fresh branch if the
   operator prefers PR separation at review time.

## Acceptance checks

- [ ] server tests green (fake-simctl, all guard branches)
- [ ] web tests green; typecheck; build
- [ ] live drill: uninstall real app → gone; system app → 403; restore
- [ ] no regression: install flow untouched; appShell 37/37
