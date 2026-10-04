# Step 3 — Rail watch tab + environment drawer

- **Status:** Ready
- **Plan:** rev 2, Stage S3, conditions 5, 7; review F4 (honest run-activity label)
- **Repo:** Step 2 head · **Depends on:** Step 2 (chassis + WatcherPanel)

## Outcome

The rail's **watch** pane fully live (session / run-watch / run-activity / traffic) + the environment drawer functional. All data rebinds to the active device.

## Implementation

### 3a. Watch pane sections (inside WatcherPanel's `#watch` slot)

- **session** (`WatcherSection`): lease id, dims (from manual-start response), watchdog countdown (5-min idle watchdog client-side countdown; on expiry → treat as session-lost honest banner, re-check via a lightweight manual call).
- **run watch**: steps from bus `run.plan` + `step.*` events filtered to runs whose device == active udid (runs carry udid? ground at write time — run.started events carry `udid?`; if absent, filter by template's device or show the newest run with an honest note). Steps render via `WatcherSteps`; meter from step counts.
- **run activity** (F4 label — NOT "logs"): rolling rows from `step.finished` (name + status + narrate) + forge traffic hits (poll `/api/forge/traffic?udid=` if it supports device filter — ground at write time; else the traffic section shows the unfiltered recent with a device tag note).
- **traffic** (collapsed default): same traffic rows, fuller.

### 3b. Environment drawer (SideDrawer)

- Opens from environment-menu items (S2 wires the open; here the content): scenario list (radios, current ember ✓), activate → `POST /api/forge/scenarios/:id/activate`, clear → the clear route; location row (read-only display round 1 — `set location…` shows a "parked" honest state or the existing location route if trivial); env-vars count row linking to the env page.

### 3c. Rebind discipline

All four sections take the active udid; switching tabs in DeviceSwitcher re-fetches + re-subscribes (bus filter by device where events carry it). No stale-device data rendered — clear on switch, then fill.

## Verification (TDD + live)

- Mount tests: sections render fixtures; watchdog countdown ticks (fake timers); run-watch updates on a dispatched bus event fixture; traffic rows render; drawer opens with scenario list; activate emits the right fetch (mock fetch).
- Live drill: with the countries-sg scenario active + a case playing, rail shows run steps advancing + run-activity rows; drawer activate/clear works; switch devices → all sections rebind.

```bash
cd web && pnpm test && pnpm build
```

## Completion gate

- [ ] Watch pane live on bus events; no stale data after switch (test pins the clear-then-fill)
- [ ] Drawer activate/clear verified live; honest labels everywhere (no "logs" over non-log data)
- [ ] Commit(s) pushed
