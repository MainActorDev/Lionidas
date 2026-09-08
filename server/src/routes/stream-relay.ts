/** Low-latency stream relay: MJPEG source → passthrough → WS binary frames.
 *
 *  Pipeline (per watching client):
 *    engine MJPEG (~300KB full-res frames, emit-on-change) → boundary-split
 *    → LATEST-WINS queue (max 1 frame buffered — stale frames dropped, never
 *    queued) → WS binary frame → browser createImageBitmap → canvas.drawImage.
 *
 *  No recompression: full-res mozjpeg encode costs ~91ms/frame and the serial
 *  pump made interaction lag snowball; localhost transport is effectively free.
 *
 *  Multiple clients share ONE upstream connection (fan-out), each with its own
 *  coalescing queue.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { internalAuthHeaders } from '../auth/roles.ts';

const execFileAsync = promisify(execFileCb);

/** Devices whose upstream pump is PAUSED because a run holds them. The
 *  engine's MJPEG capture and playback acts share one runner session; on
 *  heavy screens a concurrent frame capture wedges the runner's watchdog
 *  and every subsequent act fails (live: Sign-Up screen, run_775d90cf).
 *  While a run is active the pump stops READING the upstream — transport
 *  stays connected (no reconnect storm), frames simply drain. The canvas
 *  is NOT left black, though: a low-cadence STILL feed (xcrun simctl io
 *  screenshot — pure CoreSimulator, bypasses the contended simulator-
 *  server session entirely, so it cannot wedge the watchdog by
 *  construction) paints the same WS fan-out at ~1fps until the run ends. */
const runActiveDevices = new Set<string>();

/** Cadence of the run-still feed (ms). Conservative: the stills exist to
 *  prove liveness and keep the canvas painted, not to be smooth video.
 *  0 (or negative) disables the feed — the test suite sets this so fake
 *  udids in run.started events never spawn real xcrun capture loops. */
const RUN_STILL_INTERVAL_MS = Number(process.env['CRUCIBLE_RUN_STILL_MS'] ?? 1_000);

/** Paint stills into every client of a paused device while a run holds it.
 *  A single capture fans out to all watchers; failures are swallowed (the
 *  MJPEG resume path is the real recovery). simctl io screenshot is pure
 *  CoreSimulator — it never touches the simulator-server session the run's
 *  acts use, so it cannot wedge the runner watchdog by construction. */
/** devices with a live still-feed loop — a latch, so overlapping run.started
 *  events (play-all chains) never spawn concurrent capture loops writing the
 *  same tmp file */
const stillFeeds = new Set<string>();

function runStillFeed(udid: string): void {
  if (RUN_STILL_INTERVAL_MS <= 0) return; // disabled (tests)
  if (stillFeeds.has(udid)) return;
  stillFeeds.add(udid);
  console.log(`[run-still] feed start: ${udid}`);
  void (async () => {
    let idleTicks = 0; // consecutive ticks with zero watchers
    let painted = 0;   // successful captures (first success is logged)
    let failCount = 0;
    let lastErr = '';
    try {
      while (runActiveDevices.has(udid)) {
        // clients live on whatever subscription is current for this device
        // (the pause may re-resolve a fresh URL mid-run; follow the clients)
        const target = [...upstreams.values()].find((s) => s.udid === udid && s.clients.size > 0)
          ?? null;
        if (!target) {
          // no watchers for a full minute → exit (a run that never emits
          // run.finished must not leave a capture loop running forever;
          // a later run.started restarts the feed on demand)
          if (++idleTicks >= Math.max(1, Math.round(60_000 / RUN_STILL_INTERVAL_MS))) {
            console.log(`[run-still] feed exit (no watchers for 60s): ${udid}`);
            return;
          }
          await new Promise((r) => setTimeout(r, RUN_STILL_INTERVAL_MS));
          continue;
        }
        idleTicks = 0;
        try {
          const tmp = join(tmpdir(), `crucible-still-${udid}.jpg`);
          await execFileAsync('xcrun', ['simctl', 'io', udid, 'screenshot', tmp]);
          const frame = readFileSync(tmp);
          if (frame.length > 500) {
            for (const c of target.clients) {
              c.latestFrame = frame;
              void drain(c);
            }
            painted++;
            if (painted === 1) console.log(`[run-still] painting ${target.clients.size} client(s): ${udid}`);
            failCount = 0;
          } else if (++failCount === 1) {
            console.warn(`[run-still] suspiciously small frame (${frame.length}B), discarded: ${udid}`);
          }
        } catch (err) {
          // log the FIRST failure per feed-run with the reason — silent
          // swallowing made the first live drill undiagnosable
          if (++failCount === 1) {
            lastErr = err instanceof Error ? err.message : String(err);
            console.warn(`[run-still] capture failed (will keep retrying): ${udid}: ${lastErr}`);
          }
        }
        await new Promise((r) => setTimeout(r, RUN_STILL_INTERVAL_MS));
      }
      console.log(`[run-still] feed end (run finished, painted=${painted}${failCount > 0 ? `, lastErr=${lastErr}` : ''}): ${udid}`);
    } finally {
      stillFeeds.delete(udid);
    }
  })();
}

interface StreamClient {
  socket: WebSocket;
  latestFrame: Buffer | null;   // LATEST-WINS: max 1 frame buffered
  sending: boolean;
  /** resolves when the first frame has been sent — lets the route reject fast if the upstream is dead */
  firstFrameSent: () => void;
}

interface UpstreamSubscription {
  /** first watcher's session cookie — forwarded on internal re-resolves (auth gate) */
  cookie: string | undefined;
  url: string;
  /** device this subscription serves — anchors the run-still feed when the
   *  pump pauses and URL re-resolves reshuffle the map mid-run */
  udid: string;
  clients: Set<StreamClient>;
  abortController: AbortController;
  refCount: number;
  /** at least one frame ever pumped — distinguishes "never worked" from "lost mid-stream" */
  everGotFrame: boolean;
  /** clients were notified of the current outage (notify once per outage, not per retry) */
  notifiedOutage: boolean;
  /** when the current outage began — bounds how long we retry a dead url before
   *  closing clients (their reconnect re-resolves a FRESH url via the POST route) */
  outageStartedAt: number;
}

const upstreams = new Map<string, UpstreamSubscription>();

const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** How long the pump retries a dead upstream url (after frames flowed) before
 * closing clients — their reconnect re-POSTs and gets a FRESH url. Long enough
 * to ride out a same-port respawn; short enough that recovery feels instant. */
const OUTAGE_CLOSE_MS = 5_000;

async function pumpUpstream(url: string, sub: UpstreamSubscription, udid: string): Promise<void> {
  const boundary = Buffer.from('--NextFrame');
  let buf = Buffer.alloc(0);

  while (sub.refCount > 0) {
    // run holds this device → stop pulling frames; poll cheaply until the
    // run finishes. Clients are TOLD (paused, not dead) so the canvas shows
    // "run in progress" instead of timing out into reconnect loops.
    let pauseNotified = false;
    while (sub.refCount > 0 && runActiveDevices.has(udid)) {
      if (!pauseNotified) {
        pauseNotified = true;
        for (const c of sub.clients) {
          try { c.socket.send(JSON.stringify({ status: 'run-active', paused: true })); } catch { /* gone */ }
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (sub.refCount === 0) return;
    // resume after a run: the engine's MJPEG server likely respawned during
    // the pause (new port) — the old url is dead weight. Close this pump's
    // fetch and re-resolve a FRESH url through our own route; clients ride
    // along on the same socket (new upstream subscription, same fan-out).
    if (pauseNotified) {
      // old url is likely dead (engine respawn during the run): re-resolve a
      // FRESH url and move the clients to a NEW subscription for it. The old
      // sub is retired first (its abort controller is dead weight).
      sub.abortController.abort();
      upstreams.delete(sub.url);
      try {
        const port = Number(process.env['CRUCIBLE_PORT'] ?? 9230);
        // forward the watcher's session — the stream route sits behind the auth gate
        const resp = await fetch(`http://127.0.0.1:${port}/api/devices/${udid}/stream`, {
          method: 'POST',
          headers: sub.cookie ? { cookie: sub.cookie } : internalAuthHeaders(),
        });
        if (resp.ok) {
          const body = await resp.json() as { streamUrl: string };
          if (body.streamUrl && body.streamUrl !== sub.url) {
            let fresh = upstreams.get(body.streamUrl);
            if (!fresh) {
              fresh = { url: body.streamUrl, udid, cookie: sub.cookie, clients: new Set(), abortController: new AbortController(), refCount: 0, everGotFrame: false, notifiedOutage: false, outageStartedAt: 0 };
              upstreams.set(body.streamUrl, fresh);
            }
            for (const c of sub.clients) {
              fresh.clients.add(c);
              fresh.refCount++;
            }
            sub.clients.clear();
            sub.refCount = 0;
            void pumpUpstream(body.streamUrl, fresh, udid);
            return;
          }
        }
      } catch { /* fall through: old url retry path handles it */ }
      // fresh resolve failed AND old sub was retired — fall through re-fetches
      // the ORIGINAL url with the aborted controller, which throws instantly;
      // the catch below rides the retry loop, but the controller is dead.
      // Reset it so the retry can actually work.
      sub.abortController = new AbortController();
    }
    try {
      const resp = await fetch(url, { signal: sub.abortController.signal });
      if (!resp.ok || !resp.body) throw new Error(`upstream ${resp.status}`);
      sub.notifiedOutage = false; // source answered — outage over

      const reader = resp.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done || sub.refCount === 0) break;
        // run holds the device → STOP CONSUMING mid-stream. The pause check
        // used to live only in the outer loop, but this pump spends its whole
        // life inside reader.read() while frames flow — during a run the
        // screen changes constantly, data always arrives, and the outer check
        // was never reached: capture kept racing the run's acts (the wedge
        // class this pause exists to prevent) and "stream paused" only ever
        // engaged after the source died. Breaking here applies TCP
        // backpressure to the engine's MJPEG encoder — the capture session
        // idles without dying; the outer loop parks in the pause-wait, the
        // still feed paints the clients, and resume re-resolves a fresh URL.
        // Discarding the boundary-split buffer with the reader is safe — the
        // aborted fetch is never resumed, a NEW reader is created on resume.
        if (runActiveDevices.has(udid)) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);

        // split on boundary, extract JPEG frames (between SOI FFD8 and EOI FFD9)
        let idx: number;
        while ((idx = buf.indexOf(boundary)) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + boundary.length);

          // find JPEG SOI in this chunk
          const soi = chunk.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
          if (soi === -1) continue;
          const eoi = chunk.lastIndexOf(Buffer.from([0xff, 0xd9]));
          if (eoi === -1 || eoi <= soi) continue;
          const jpeg = chunk.slice(soi, eoi + 2);
          if (jpeg.length < 500) continue; // noise

          // TRANSPORT = passthrough. The engine's JPEG is already well-compressed
          // (~300KB at 1284w); recompressing at full-res costs 91ms/frame (mozjpeg)
          // — the serial encode made interaction lag snowball. Localhost WS moves
          // the frame in <5ms, so ship it as-is and let the browser decode.
          // LATEST-WINS per client keeps memory flat even at burst framerates.
          const frame = jpeg;
          sub.everGotFrame = true;
          for (const c of sub.clients) {
            c.latestFrame = frame;
            void drain(c);
          }
        }
        // prevent unbounded buffer if no boundary found
        if (buf.length > 5_000_000) buf = buf.slice(-100_000);
      }
    } catch {
      if (sub.refCount === 0) return;
      // upstream died mid-stream. Tell watching clients ONCE per outage so the
      // canvas shows "reconnecting" instead of a silently frozen "live" frame
      // (screen-change-gated emission means absence of frames alone is NOT
      // proof of death; a transport error IS). Then keep retrying the SAME url
      // for a bounded window — a respawned source often re-uses its port. If
      // the outage persists, CLOSE the client sockets: the stream URL is
      // per-spawn (a new simulator-server usually means a new port), so the
      // old URL will never come back — the browser's reconnect loop re-POSTs
      // /api/devices/:udid/stream, which re-resolves (and self-heals the
      // engine chain) and hands out the fresh URL. Recovery is automatic.
      if (sub.everGotFrame) {
        if (!sub.notifiedOutage) {
          sub.notifiedOutage = true;
          sub.outageStartedAt = Date.now();
          for (const c of sub.clients) {
            try { c.socket.send(JSON.stringify({ status: 'source-lost', retrying: true })); } catch { /* gone */ }
          }
        } else if (Date.now() - sub.outageStartedAt > OUTAGE_CLOSE_MS) {
          for (const c of sub.clients) {
            try { c.socket.send(JSON.stringify({ error: 'stream source lost — reconnecting', retryable: true })); } catch { /* gone */ }
            try { c.socket.close(); } catch { /* gone */ }
            sub.clients.delete(c);
            sub.refCount--;
          }
          if (sub.refCount === 0) {
            sub.abortController.abort();
            upstreams.delete(url);
            return;
          }
        }
      }
      // upstream died — retry after a beat (clients see stalled frames → fallback)
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function drain(c: StreamClient): Promise<void> {
  if (c.sending || !c.latestFrame) return;
  c.sending = true;
  const frame = c.latestFrame;
  c.latestFrame = null; // next frame replaces this slot while sending
  try {
    c.socket.send(frame, { binary: true });
    c.firstFrameSent();
  } catch { /* client gone */ }
  c.sending = false;
  // if a newer frame arrived while sending, send it too
  if (c.latestFrame) void drain(c);
}

export async function registerStreamRelay(app: FastifyInstance, bus: TypedEventBus<AppEvents>): Promise<void> {
  // pause pumps while a run holds the device (see runActiveDevices above);
  // the still feed keeps every watcher's canvas painted through the pause
  bus.on('run.started', (p) => { if (p.udid) { runActiveDevices.add(p.udid); runStillFeed(p.udid); } });
  bus.on('run.finished', (p) => { if (p.udid) runActiveDevices.delete(p.udid); });
  // events-ws.ts registers the websocket plugin first; re-registering throws
  // "decorator 'ws' has already been added". We only add our route here.

  app.get('/api/stream/:udid', { websocket: true }, (connection, req) => {
    const socket = ((connection as unknown as { socket?: WebSocket }).socket ?? connection) as unknown as WebSocket & { on(e: string, cb: () => void): void };
    const { udid } = req.params as { udid: string };
    const watcherCookie = req.headers['cookie'] ?? undefined;

    // resolve stream URL via alloy (from the request's query or the mirror)
    void (async () => {
      try {
        // resolve via our own HTTP route (runtime guaranteed initialized — the
        // lazy alloy init in index.ts fires before this can be reached in prod)
        const port = Number(process.env['CRUCIBLE_PORT'] ?? 9230);
        // forward the watcher's session — the stream route sits behind the auth gate
        const resp = await fetch(`http://127.0.0.1:${port}/api/devices/${udid}/stream`, {
          method: 'POST',
          headers: watcherCookie ? { cookie: watcherCookie } : internalAuthHeaders(),
        });
        if (!resp.ok) {
          const body = await resp.json() as { error?: string; retryable?: boolean };
          socket.send(JSON.stringify({ error: body.error ?? `route ${resp.status}`, retryable: body.retryable ?? false }));
          socket.close();
          return;
        }
        const body = await resp.json() as { streamUrl: string };
        const url = body.streamUrl;
        let sub = upstreams.get(url);
        if (!sub) {
          sub = { url, udid, cookie: watcherCookie, clients: new Set(), abortController: new AbortController(), refCount: 0, everGotFrame: false, notifiedOutage: false, outageStartedAt: 0 };
          upstreams.set(url, sub);
        }

        // If this upstream never yields a frame (engine died right after URL handout),
        // fail fast with a typed reason instead of a silent black canvas.
        let onFirstFrame: (() => void) | null = null;
        const firstFramePromise = new Promise<void>((resolve) => { onFirstFrame = resolve; });
        const client: StreamClient = { socket, latestFrame: null, sending: false, firstFrameSent: () => onFirstFrame?.() };
        sub.clients.add(client);
        sub.refCount++;
        void pumpUpstream(url, sub, udid);

        const firstTimer = setInterval(() => {
          // a run-pause legitimately withholds frames — wait it out instead
          // of timing out into a fail overlay the user can't clear
          if (runActiveDevices.has(udid)) return;
          try { socket.send(JSON.stringify({ error: 'no frames from stream source (timeout)', retryable: true })); socket.close(); } catch { /* gone */ }
        }, FIRST_FRAME_TIMEOUT_MS);
        // fire once: after the first lapse, stop checking (clear on first frame)
        const firstTimerOnce = firstTimer;
        firstFramePromise.then(() => clearInterval(firstTimerOnce));
        setTimeout(() => clearInterval(firstTimerOnce), FIRST_FRAME_TIMEOUT_MS * 2 + 500);

        socket.on('close', () => {
          sub!.clients.delete(client);
          sub!.refCount--;
          if (sub!.refCount === 0) {
            sub!.abortController.abort();
            upstreams.delete(url);
          }
        });
      } catch (err) {
        try { socket.send(JSON.stringify({ error: String(err) })); socket.close(); } catch { /* gone */ }
      }
    })();
  });
}
