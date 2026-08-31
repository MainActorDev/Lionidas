/** Device mirror poller: alloy_health (leases) + alloy_devices (list) every 2s.
 *  Mirror only — engine claims remain truth (PLAN §4). Emits device.changed on diff. */
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { initAlloyRuntime } from '../alloy/runtime.ts';
import { crucibleAlloy } from '../alloy/client.ts';

/** Sim metadata the engine contract doesn't carry. Sourced from simctl directly
 *  (cached until simctl's device set changes) so the wall can show OS + model.
 *  Physical devices have no simctl entry — they surface with os: null. */
interface SimMeta { os: string | null; model: string | null }
let simMetaCache: { map: Map<string, SimMeta>; fingerprint: string } | null = null;

function simMeta(): Map<string, SimMeta> {
  try {
    const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as { devices?: Record<string, Array<{ udid: string; deviceTypeIdentifier?: string }>> };
    const map = new Map<string, SimMeta>();
    for (const [runtime, arr] of Object.entries(parsed.devices ?? {})) {
      for (const d of arr) {
        // com.apple.CoreSimulator.SimRuntime.iOS-18-6 → iOS 18.6 ; deviceTypeIdentifier → iPhone 14 Plus
        const os = runtime.split('.').pop()?.replace(/-/g, '.').replace(/^iOS\./, 'iOS ') ?? null;
        map.set(d.udid, {
          os,
          model: d.deviceTypeIdentifier?.split('.').pop()?.replace(/-/g, ' ') ?? null,
        });
      }
    }
    simMetaCache = { map, fingerprint: [...map.keys()].join(',') };
    return map;
  } catch {
    return simMetaCache?.map ?? new Map();
  }
}

/** Cheap staleness check: only re-run simctl when the visible device set could
 *  have changed (device.changed events / poll diff), not every 2s tick. */
export function invalidateSimMeta(): void { simMetaCache = null; }

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
    `INSERT INTO devices(udid, name, state, platform, kind, os_version, lease_holder, lease_engine, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(udid) DO UPDATE SET
       name = excluded.name, state = excluded.state,
       platform = excluded.platform, kind = excluded.kind, os_version = excluded.os_version,
       lease_holder = excluded.lease_holder, lease_engine = excluded.lease_engine,
       last_seen = excluded.last_seen`,
  );
  const select = db.prepare('SELECT udid, name, state, platform, kind, lease_holder, lease_engine FROM devices');
  const before = new Map((select.all() as DeviceMirrorRow[]).map((r) => [r.udid, r]));

  let changed = 0;
  const meta = simMeta();
  if (devices.ok) {
    const seen = new Set<string>();
    for (const d of devices.result) {
      // the host Mac surfaces as a booted "device" — not a test target; skip it
      if (d.platform === 'macos') continue;
      // simulator-only wall: physical devices excluded from the list by design
      if (d.kind === 'device') continue;
      seen.add(d.id);
      const lease = leases.get(d.id) ?? { holder: null as string | null, engine: null as string | null };
      // engine A reports a `booted` boolean, not a state string — map it
      const state = d.booted === true ? 'Booted' : d.booted === false ? 'Shutdown' : null;
      const os = meta.get(d.id)?.os ?? null;
      upsert.run(d.id, d.name ?? null, state, d.platform ?? null, d.kind ?? null, os, lease.holder, lease.engine, Date.now());
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
