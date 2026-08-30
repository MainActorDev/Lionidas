/** Device mirror poller: alloy_health (leases) + alloy_devices (list) every 2s.
 *  Mirror only — engine claims remain truth (PLAN §4). Emits device.changed on diff. */
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { initAlloyRuntime } from '../alloy/runtime.ts';
import { crucibleAlloy } from '../alloy/client.ts';

export interface DeviceMirrorRow {
  udid: string;
  name: string | null;
  state: string | null;
  platform: string | null;
  kind: string | null;
  lease_holder: string | null;
  lease_engine: string | null;
}

export async function pollDevices(db: Database.Database, bus: TypedEventBus<AppEvents>): Promise<number> {
  const alloy = crucibleAlloy();
  const deps = (await initAlloyRuntime()).deps;

  const health = (await alloy.dispatch('alloy_health', {}, deps)) as
    | { ok: true; result: { leases: Array<{ udid: string; engine: string; holder: string }> } }
    | { ok: false };
  const devices = (await alloy.dispatch('alloy_devices', { action: 'list' }, deps)) as
    | { ok: true; result: Array<{ id: string; name?: string; state?: string; booted?: boolean; platform?: string; kind?: string }> }
    | { ok: false };

  const leases = new Map<string, { engine: string; holder: string }>();
  if (health.ok) for (const l of health.result.leases) leases.set(l.udid, { engine: l.engine, holder: l.holder });

  const upsert = db.prepare(
    `INSERT INTO devices(udid, name, state, platform, kind, lease_holder, lease_engine, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(udid) DO UPDATE SET
       name = excluded.name, state = excluded.state,
       platform = excluded.platform, kind = excluded.kind,
       lease_holder = excluded.lease_holder, lease_engine = excluded.lease_engine,
       last_seen = excluded.last_seen`,
  );
  const select = db.prepare('SELECT udid, name, state, platform, kind, lease_holder, lease_engine FROM devices');
  const before = new Map((select.all() as DeviceMirrorRow[]).map((r) => [r.udid, r]));

  let changed = 0;
  if (devices.ok) {
    const seen = new Set<string>();
    for (const d of devices.result) {
      // the host Mac surfaces as a booted "device" — not a test target; skip it
      if (d.platform === 'macos') continue;
      seen.add(d.id);
      const lease = leases.get(d.id) ?? { holder: null as string | null, engine: null as string | null };
      // engine A reports a `booted` boolean, not a state string — map it
      const state = d.booted === true ? 'Booted' : d.booted === false ? 'Shutdown' : null;
      upsert.run(d.id, d.name ?? null, state, d.platform ?? null, d.kind ?? null, lease.holder, lease.engine, Date.now());
      const prev = before.get(d.id);
      const nowRow = { udid: d.id, name: d.name ?? null, state, platform: d.platform ?? null, kind: d.kind ?? null, lease_holder: lease.holder, lease_engine: lease.engine };
      if (
        !prev ||
        prev.state !== nowRow.state ||
        prev.platform !== nowRow.platform ||
        prev.kind !== nowRow.kind ||
        prev.lease_holder !== nowRow.lease_holder ||
        prev.lease_engine !== nowRow.lease_engine
      ) {
        changed++;
        bus.emit('device.changed', nowRow);
      }
    }
    // mirror hygiene: rows the engine no longer reports (deleted sims, filtered
    // host) must not linger on the wall — remove anything absent from this poll
    const del = db.prepare('DELETE FROM devices WHERE udid = ?');
    for (const row of before.values()) {
      if (!seen.has(row.udid)) {
        del.run(row.udid);
        changed++;
        bus.emit('device.changed', { udid: row.udid, name: null, state: null, platform: null, kind: null, lease_holder: null, lease_engine: null });
      }
    }
  }
  return changed;
}

export function startDevicePoller(db: Database.Database, bus: TypedEventBus<AppEvents>, intervalMs = 2000): () => void {
  const timer = setInterval(() => {
    pollDevices(db, bus).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}
