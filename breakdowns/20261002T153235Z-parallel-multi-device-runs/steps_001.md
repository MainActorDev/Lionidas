# Step 1 — Per-device session map + sessions API + page heartbeat

- **Status:** Ready
- **Plan:** `plans/20261002T153235Z-parallel-multi-device-runs-plan.md` rev 2 (Ready), R1 + review F4/F5/F6
- **Review:** `reviews/20261002T153235Z-parallel-multi-device-runs-plan-review.md` (Ready for implementation)
- **Repo:** `feat/device-cockpit` @ `2b5b74f` · **Depends on:** none · **Handoff:** Step 2 (parallel-runs drill)

## Goal

Taking control on device A, switching tabs to B, taking control on B — returning to A shows A's live session (chip ticking, taps dispatch). Sessions are per-device and survive tab switches while the cockpit is open.

## 1. Server: `GET /api/manual/sessions`

`server/src/routes/manual.ts` (inside the register fn, alongside the other GETs):

```ts
// open manual sessions — the cockpit hydrates its per-device control map and
// detects watchdog-reaped sessions on tab activation (review F4)
app.get('/api/manual/sessions', { preHandler: requireRole('operator') }, async () => {
  const rows = db
    .prepare('SELECT id, udid, operator, started_at, last_activity FROM manual_sessions WHERE finished_at IS NULL ORDER BY started_at DESC')
    .all() as Array<{ id: string; udid: string; operator: string; started_at: number; last_activity: number }>;
  return { sessions: rows.map((r) => ({ id: r.id, udid: r.udid, operator: r.operator, startedAt: r.started_at, lastActivity: r.last_activity })) };
});
```

Check how `requireRole` is imported in this file (it may already be in scope for POST routes; mirror whatever the operator-gated routes in `routes.ts` files use).

Test (`server/test/manual-sessions-route.test.ts`, new): auth gate (401/403 class per existing route tests), empty when none, lists open session with correct fields, excludes finished ones.

## 2. Web: `useDeviceSessions` composable

`web/src/composables/deviceSessions.ts` (new):

```ts
/** Per-device manual-session map — the durable control handles. The page owns
 *  this; StageBezel remounts per udid and reads the active entry. Hydrates
 *  from GET /api/manual/sessions (watchdog-reaped sessions drop out), pings
 *  the heartbeat for every entry on a 30s loop while mounted (review F5). */
import { reactive, readonly } from 'vue';

export interface DeviceSession { sessionId: string; startedAt: number; dims: { w: number | null; h: number | null } }

export function useDeviceSessions() {
  const map = reactive(new Map<string, DeviceSession>());
  let hbTimer: ReturnType<typeof setInterval> | null = null;

  async function hydrate(): Promise<void> {
    try {
      const r = await fetch('/api/manual/sessions');
      if (!r.ok) return;
      const b = (await r.json()) as { sessions?: Array<{ id: string; udid: string; startedAt: number }> };
      const live = new Set<string>();
      for (const s of b.sessions ?? []) {
        live.add(s.udid);
        if (!map.has(s.udid)) map.set(s.udid, { sessionId: s.id, startedAt: s.startedAt, dims: { w: null, h: null } });
      }
      for (const udid of [...map.keys()]) if (!live.has(udid)) map.delete(udid); // reaped/finished
    } catch { /* offline — keep local state */ }
  }

  function start(): void { void hydrate(); hbTimer = setInterval(async () => { for (const [udid, s] of map) { try { await fetch(`/api/manual/${s.sessionId}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* next tick */ } void udid; } void hydrate(); }, 30_000); }
  function stop(): void { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
  function set(udid: string, s: DeviceSession | null): void { if (s) map.set(udid, s); else map.delete(udid); }

  return { sessions: readonly(map), hydrate, set, start, stop };
}
```

## 3. CockpitPage wiring (F6 shape: stage remounts per udid)

- Create ONE `useDeviceSessions()` instance at page level; `start()` on mount, `stop()` on unmount.
- `<StageBezel :key="activeUdid" ...>` — remount reconstructs stage-local state; pass `:session="sessions.get(activeUdid) ?? null"`.
- StageBezel changes (keep its internal logic, adjust the entry/exit seams):
  - New prop `session: DeviceSession | null`. On mount: if `session` exists, adopt it (sessionId/startedAt from the map; re-arm `stream.start(props.udid)`) — this is the "returning to A" path.
  - On `takeControl` success: ALSO `sessions.set(props.udid, {...})` via an emitted `session-acquired` event (page writes the map) — keep `session-state` emit for dims.
  - On `release` / session-lost / `endSession`: emit so the page deletes the map entry for that udid.
  - REMOVE the udid-watcher's `sessionId.value = null` reset semantics: with `:key` remount there is no watcher case — each mount starts from the map entry.
- Switcher live dot: a tab whose udid has a map entry shows the ember dot (extend `SwitcherDevice` with `session?: boolean` — page computes from map).
- Tab close (`onTabClose`): after release, also `sessions.set(udid, null)`.

## 4. Tests (web)

`web/src/composables/__tests__/deviceSessions.test.ts`:
- hydrate maps open sessions per udid; deletes entries absent from the server list (watchdog reaped).
- heartbeat loop: with fake timers, advancing 30s POSTs one heartbeat per entry.
- `set(null)` removes; readonly exposure.

Update `cockpit.test.ts` only if StageBezel prop changes break mounts (add `session: null` to fixtures).

## 5. Live drill (acceptance)

Two booted sims (boot the second via the cockpit if needed):
1. Take control on A → chip live. 2. Switch to B → take control → chip live. 3. Switch back to A → **chip live WITHOUT re-taking; a canvas tap dispatches (`{"ok":true}` in network)**. 4. Wait 65s on tab B → switch to A → chip still live (heartbeat kept it). 5. Release A → switch B→A → A idle honestly.
Record transcript lines in the commit message like prior steps.

## Gates

`pnpm -C web test` · `pnpm -C server vitest run` · both builds · commit `feat(web,server): cockpit per-device session map (steps_001)`.
