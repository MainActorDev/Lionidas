/** Live event store: one WS connection shared by all pages (Axiom live channel). */
import { reactive } from 'vue';

export interface LiveEvent {
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

const state = reactive({
  connected: false,
  events: [] as LiveEvent[],        // rolling window, newest last
  traffic: [] as Array<Record<string, unknown>>, // forge traffic (newest first)
});

let ws: WebSocket | null = null;
let refCount = 0;

const MAX_EVENTS = 200;
const MAX_TRAFFIC = 100;

export function useLiveEvents(): {
  connected: boolean;
  events: LiveEvent[];
  traffic: Array<Record<string, unknown>>;
  connect(): void;
  release(): void;
} {
  function connect(): void {
    refCount++;
    if (ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/events`);
    ws.onopen = () => { state.connected = true; };
    ws.onclose = () => {
      state.connected = false;
      ws = null;
      // auto-reconnect while pages remain mounted
      if (refCount > 0) setTimeout(() => { if (refCount > 0 && !ws) connect(); }, 2000);
    };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as { type: string; payload: Record<string, unknown> };
        state.events.push({ type: ev.type, payload: ev.payload, at: Date.now() });
        if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
        if (ev.type === 'forge.traffic.hit') {
          state.traffic.unshift(ev.payload);
          if (state.traffic.length > MAX_TRAFFIC) state.traffic.pop();
        }
      } catch { /* ignore malformed */ }
    };
  }

  function release(): void {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && ws) {
      ws.onclose = null; // no reconnect on intentional close
      ws.close();
      ws = null;
      state.connected = false;
    }
  }

  return {
    get connected() { return state.connected; },
    get events() { return state.events; },
    get traffic() { return state.traffic; },
    connect,
    release,
  };
}
