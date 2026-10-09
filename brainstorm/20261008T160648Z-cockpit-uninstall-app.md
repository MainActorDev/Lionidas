# Cockpit: uninstall app submenu (app menu group)

- Source prompt: "In cockpit, under the 'app' menu group. Add a new 'uninstall
  app' sub menu to uninstall non-system apps from the booted device selected."
  (+ separate quick task: hide the sidebar guide link — done directly, trivial)
- Created: 2026-10-08T16:06:48Z
- Status: Questions open
- Branch: `chore/sidebar-regroup-2` (continuing the cleanup branch)

## Goal and context

The cockpit's app menu has `run app` and `install app` but no way to REMOVE an
app. Operators need clean-slate testing (fresh install state, first-launch
flows, version-migration checks) — today that means a terminal and
`xcrun simctl uninstall` by hand, breaking the cockpit's one-surface workflow.

## Confirmed inputs and decisions

- Menu placement fixed by the user: cockpit → app menu group → new
  "uninstall app" item (user's words).
- Target device: the cockpit's currently selected booted device (same as
  install/run-app).
- Scope: NON-SYSTEM apps only (user's words).
- Verified facts (code read 2026-10-08):
  - `listSimulatorApps(udid)` exists (`server/src/manual/apps.ts:55`) — full
    catalog with name/version/icon/running + `isUserFacing` classifier.
  - Install pattern to mirror: `POST /api/devices/:udid/install`
    (`manual.ts:564`) → `installApp` (`app-install.ts`, direct simctl, no
    engine session). Uninstall = `xcrun simctl uninstall <udid> <bundleId>`.
  - Guard precedent: install/power return 409 while a run or manual session
    owns the device ("poisons settle polls and watchdogs", manual.ts:250).

## Exploration

### The safety model (the core of this feature)

Uninstall is destructive. Three layers, cheapest first:

1. **Server-side allowlist (the real gate):** uninstallable = bundle id does
   NOT start with `com.apple.`. All Apple system apps carry that prefix;
   user-installed apps never do. This is stricter and simpler than
   `isUserFacing` (which exists to FILTER a display list, not to guard a
   destructive op). `com.apple.*` → 403 `SYSTEM_APP` — the API refuses even
   if a crafted request names one.
2. **Busy guard:** 409 while a run or manual session is active on the device
   (same class as install/power) — uninstalling the app under test mid-run
   poisons the run and the watchdogs.
3. **UI confirmation:** submenu lists user apps (name + version, from
   `listSimulatorApps` filtered to non-`com.apple.*`), pick one → confirm
   step naming the app + bundle id → then DELETE.

### UI shape (follows the install modal precedent)

`uninstall app` menu item → modal:
- List: installed non-system apps (icon, name, version, running indicator).
- Running app? Still uninstallable — simctl kills it — but the row shows
  "running" so the operator knows. (No extra confirm tier; one confirm total.)
- Confirm button reads `uninstall <name>` (destructive styling); cancel.
- Empty state: "no user apps installed".

### API

- `GET /api/devices/:udid/apps?uninstallable=1` — reuse the existing
  apps-list surface filtered server-side (or filter client-side from the
  existing list route if one exists — check during build).
- `DELETE /api/devices/:udid/apps/:bundleId` (or POST /uninstall mirroring
  /install) → `simctl uninstall`; errors surfaced verbatim (simctl's stderr
  is honest); audit line in the device activity log.

### Out of scope

- Batch uninstall / "clean device" (future: maybe a device menu item).
- Android (no device layer yet).

## Open questions

1. **Route shape**: `DELETE /api/devices/:udid/apps/:bundleId` (RESTful) vs
   `POST /api/devices/:udid/uninstall` mirroring the existing
   `/install` sibling? Rec: POST sibling — matches the codebase's verb
   style and keeps the pair symmetric.
2. **Running apps**: allow uninstall (simctl handles it) vs block with
   "app is running"? Rec: allow + show running state — an operator
   uninstalling a stuck app is a real flow; a block would force a detour.
3. **Role**: admin/operator (like other device ops) vs admin-only?
   Rec: operator+ (same as install — it's a device op, not instance config).

## Next step

Close the 3 questions → implement (server route + guard + menu item + modal
+ tests + live drill on the booted device) on the cleanup branch.
