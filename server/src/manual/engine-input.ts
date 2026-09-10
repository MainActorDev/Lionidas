/** Engine input channel — server-owned WS to crucible-screenstream for
 *  device control during a driving session.
 *
 *  The wall's direct-avcc stream path connects browser→engine with no
 *  server-side socket; this module owns one per device for input dispatch.
 *  Sockets join the run-hold registry (stream-relay's engineSockets) so
 *  run_pause/run_resume reach them. Acks are awaited per message with a
 *  bounded timeout. */
import type { WebSocket } from 'ws';

const ENGINE_PORT = Number(process.env['CRUCIBLE_SCREENSTREAM_PORT'] ?? 8440);
const ACK_TIMEOUT_MS = 2_000;
export const INPUT_TIMEOUT = 'INPUT_TIMEOUT';

type AckWaiter = { resolve: (ok: boolean, error?: string) => void; timer: NodeJS.Timeout };

interface EngineSocketExt extends WebSocket {
  __ackWaiters?: Map<number, AckWaiter>;
  __nextSeq?: number;
  __ackWired?: boolean;
}

/** registry shared with stream-relay via module-level injection (avoids a
 *  circular import): the relay registers its Map here at boot. */
type SocketsByUdid = Map<string, Set<EngineSocketExt>>;
let socketsByUdid: SocketsByUdid | null = null;
export function __bindEngineSockets(map: unknown): void {
  socketsByUdid = map as SocketsByUdid;
}

function ensureAckListener(ws: EngineSocketExt): void {
  // The relay's sockets join the same registry without this module's
  // listener; attach idempotently so acks correlate on every socket.
  if (ws.__ackWired) return;
  ws.__ackWired = true;
  if (!ws.__ackWaiters) ws.__ackWaiters = new Map();
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; ok?: boolean; error?: string; seq?: number };
      if (msg.type === 'input_ack' && typeof msg.seq === 'number') {
        const w = ws.__ackWaiters?.get(msg.seq);
        if (w) {
          ws.__ackWaiters?.delete(msg.seq);
          clearTimeout(w.timer);
          w.resolve(msg.ok !== false, msg.error);
        }
      }
    } catch { /* not JSON */ }
  });
}

function socketFor(udid: string): Promise<EngineSocketExt> {
  const existing = socketsByUdid?.get(udid);
  const live = existing ? [...existing].find((ws) => ws.readyState === 1 /* OPEN */) : undefined;
  if (live) { ensureAckListener(live); return Promise.resolve(live); }
  return new Promise((resolve, reject) => {
    // lazy import keeps ws out of modules that never drive
    void (async () => {
      const WS = (await import('ws')).default as unknown as new (url: string) => EngineSocketExt;
      const ws = new WS(`ws://127.0.0.1:${ENGINE_PORT}/devices/${udid}/stream`);
      ws.__nextSeq = 1;
      ensureAckListener(ws);
      const register = (): void => {
        if (!socketsByUdid) return;
        let set = socketsByUdid.get(udid);
        if (!set) { set = new Set(); socketsByUdid.set(udid, set); }
        set.add(ws);
      };
      ws.on('open', () => register());
      ws.on('close', () => {
        const set = socketsByUdid?.get(udid);
        if (set) { set.delete(ws); if (set.size === 0) socketsByUdid?.delete(udid); }
        // fail any pending waiters
        for (const [, w] of ws.__ackWaiters ?? []) {
          clearTimeout(w.timer);
          w.resolve(false, 'socket closed');
        }
        ws.__ackWaiters?.clear();
      });
      ws.on('error', () => { /* close handler cleans up */ });
      ws.once('open', () => resolve(ws));
      ws.once('error', (e: Error) => reject(e));
      setTimeout(() => reject(new Error('engine input socket connect timeout')), ACK_TIMEOUT_MS).unref?.();
    })();
  });
}

/** Grant/refuse engine-side input for this device's sessions. The engine
 *  refuses gestures from any socket without the grant — the direct-avcc
 *  browser socket carries input only while a driving session owns the
 *  device. Fire-and-forget to every live socket; the next socket to open
 *  (e.g. the browser's direct stream) starts ungranted by default. */
/** Devices whose driving session granted engine input. engineInput()
 *  re-asserts the grant on the socket it's about to use — engine restarts
 *  and socket churn can silently drop a one-shot grant, refusing every
 *  wall gesture with no visible error (found live). */
const grantedDevices = new Set<string>();

export async function grantInput(udid: string, granted: boolean): Promise<void> {
  if (granted) grantedDevices.add(udid);
  else grantedDevices.delete(udid);
  // push the device-level grant to the engine over a server-owned socket;
  // the engine marks the DEVICE, so the browser's direct stream socket
  // passes the gate too
  try {
    const ws = await socketFor(udid);
    ws.send(JSON.stringify({ type: 'grant_input', granted }));
  } catch { /* engine down; engineInput re-asserts on next gesture */ }
}

/** Send one input gesture to the engine; resolves true on ok-ack.
 *  Rejects with INPUT_TIMEOUT / connect errors — the caller decides
 *  whether to fall back. `seq` rides the message so acks correlate. */
export async function engineInput(udid: string, gesture: Record<string, unknown>): Promise<void> {
  const ws = await socketFor(udid);
  // re-assert the device grant on THIS socket before every gesture: the
  // engine gates input per-socket, and sockets die/reopen invisibly
  if (grantedDevices.has(udid)) {
    try { ws.send(JSON.stringify({ type: 'grant_input', granted: true })); } catch { /* dead socket fails the send below */ }
  }
  const seq = ws.__nextSeq = (ws.__nextSeq ?? 1) + 1;
  const payload = JSON.stringify({ type: 'input', seq, ...gesture });
  const acked = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      ws.__ackWaiters?.delete(seq);
      resolve(false);
    }, ACK_TIMEOUT_MS);
    ws.__ackWaiters?.set(seq, { resolve: (ok) => resolve(ok), timer });
    try {
      ws.send(payload);
    } catch {
      clearTimeout(timer);
      ws.__ackWaiters?.delete(seq);
      resolve(false);
    }
  });
  if (!acked) throw new Error(INPUT_TIMEOUT);
}
