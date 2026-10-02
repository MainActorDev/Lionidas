/** Per-device manual-session map — the durable control handles. The page owns
 *  this; StageBezel remounts per udid (:key) and adopts the active entry.
 *  Hydrates from GET /api/manual/sessions (watchdog-reaped sessions drop
 *  out), and pings the heartbeat for every entry on a 30s loop while started
 *  (plan F5) — background sessions stay alive across tab switches. */
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
      for (const udid of [...map.keys()]) if (!live.has(udid)) map.delete(udid); // reaped or finished
    } catch { /* offline — keep local state */ }
  }

  function beat(): void {
    for (const s of map.values()) {
      void fetch(`/api/manual/${encodeURIComponent(s.sessionId)}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    }
  }

  function start(): void {
    void hydrate();
    if (hbTimer) return;
    hbTimer = setInterval(() => { beat(); void hydrate(); }, 30_000);
  }
  function stop(): void { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
  function set(udid: string, s: DeviceSession | null): void { if (s) map.set(udid, s); else map.delete(udid); }

  return { sessions: readonly(map), hydrate, set, start, stop };
}
