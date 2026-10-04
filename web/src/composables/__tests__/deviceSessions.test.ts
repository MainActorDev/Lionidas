import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useDeviceSessions } from '../deviceSessions.ts';

function mockSessionsFetch(list: Array<{ id: string; udid: string; startedAt: number }>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/manual/sessions')) return { ok: true, json: async () => ({ sessions: list }) };
    if (String(url).includes('/heartbeat')) return { ok: true, json: async () => ({}) };
    return { ok: false, json: async () => ({}) };
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); vi.useFakeTimers(); });

describe('useDeviceSessions (per-device control map)', () => {
  it('hydrates open sessions per udid', async () => {
    mockSessionsFetch([{ id: 'ms_a', udid: 'A', startedAt: 1 }, { id: 'ms_b', udid: 'B', startedAt: 2 }]);
    const s = useDeviceSessions();
    await s.hydrate();
    expect(s.sessions.get('A')?.sessionId).toBe('ms_a');
    expect(s.sessions.get('B')?.sessionId).toBe('ms_b');
  });

  it('drops entries the server no longer lists (watchdog reaped)', async () => {
    let list = [{ id: 'ms_a', udid: 'A', startedAt: 1 }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/manual/sessions')) return { ok: true, json: async () => ({ sessions: list }) };
      return { ok: true, json: async () => ({}) };
    }));
    const s = useDeviceSessions();
    await s.hydrate();
    expect(s.sessions.size).toBe(1);
    list = []; // reaped server-side
    await s.hydrate();
    expect(s.sessions.size).toBe(0);
  });

  it('set() writes/removes; heartbeat pings every entry on the 30s loop', async () => {
    const fn = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ sessions: [{ id: 'ms_a', udid: 'A', startedAt: 1 }, { id: 'ms_b', udid: 'B', startedAt: 2 }] }) }));
    vi.stubGlobal('fetch', fn as never);
    const s = useDeviceSessions();
    s.set('A', { sessionId: 'ms_a', startedAt: 1, dims: { w: null, h: null } });
    s.set('B', { sessionId: 'ms_b', startedAt: 2, dims: { w: null, h: null } });
    s.start();
    vi.advanceTimersByTime(30_500);
    await flushPromises();
    const beats = fn.mock.calls.filter((c) => String(c[0]).includes('/heartbeat'));
    expect(beats.length).toBeGreaterThanOrEqual(2); // one per entry
    s.set('A', null);
    expect(s.sessions.has('A')).toBe(false);
    s.stop();
  });
});
