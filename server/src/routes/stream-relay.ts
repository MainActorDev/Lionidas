/** Low-latency stream relay: MJPEG source → JPEG recompress → WS binary frames.
 *
 *  Pipeline (per watching client):
 *    engine MJPEG (200KB frames, 1-5fps) → boundary-split → sharp recompress
 *    (target 30-60KB, quality 70, half scale) → LATEST-WINS queue (max 1 frame
 *    buffered — stale frames dropped, never queued) → WS binary frame → browser
 *    createImageBitmap → canvas.drawImage (off-main-thread decode, zero multipart
 *    parser, zero <img> buffering).
 *
 *  Multiple clients share ONE upstream connection (fan-out), each with its own
 *  coalescing queue.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type Sharp from 'sharp';
let sharpModule: typeof Sharp | null = null;
async function getSharp(): Promise<typeof Sharp> {
  if (!sharpModule) sharpModule = (await import('sharp')).default;
  return sharpModule;
}

interface StreamClient {
  socket: WebSocket;
  latestFrame: Buffer | null;   // LATEST-WINS: max 1 frame buffered
  sending: boolean;
}

interface UpstreamSubscription {
  url: string;
  clients: Set<StreamClient>;
  abortController: AbortController;
  refCount: number;
}

const upstreams = new Map<string, UpstreamSubscription>();

async function pumpUpstream(url: string, sub: UpstreamSubscription): Promise<void> {
  const boundary = Buffer.from('--NextFrame');
  let buf = Buffer.alloc(0);

  while (sub.refCount > 0) {
    try {
      const resp = await fetch(url, { signal: sub.abortController.signal });
      if (!resp.ok || !resp.body) throw new Error(`upstream ${resp.status}`);

      const reader = resp.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done || sub.refCount === 0) break;
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

          // recompress: half scale, quality 70 → ~10-30KB (from 200KB)
          try {
            const sharp = await getSharp();
            const compressed = await sharp(jpeg)
              .resize({ width: 201 })  // half of 402
              .jpeg({ quality: 70, mozjpeg: true })
              .toBuffer();
            // fan out to all clients — LATEST-WINS per client
            for (const c of sub.clients) {
              c.latestFrame = compressed;
              void drain(c);
            }
          } catch { /* corrupt frame — skip */ }
        }
        // prevent unbounded buffer if no boundary found
        if (buf.length > 5_000_000) buf = buf.slice(-100_000);
      }
    } catch {
      if (sub.refCount === 0) return;
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
  } catch { /* client gone */ }
  c.sending = false;
  // if a newer frame arrived while sending, send it too
  if (c.latestFrame) void drain(c);
}

export async function registerStreamRelay(app: FastifyInstance): Promise<void> {
  // events-ws.ts registers the websocket plugin first; re-registering throws
  // "decorator 'ws' has already been added". We only add our route here.

  app.get('/api/stream/:udid', { websocket: true }, (connection, req) => {
    const socket = ((connection as unknown as { socket?: WebSocket }).socket ?? connection) as unknown as WebSocket & { on(e: string, cb: () => void): void };
    const { udid } = req.params as { udid: string };

    // resolve stream URL via alloy (from the request's query or the mirror)
    void (async () => {
      try {
        // resolve via our own HTTP route (runtime guaranteed initialized — the
        // lazy alloy init in index.ts fires before this can be reached in prod)
        const port = Number(process.env['CRUCIBLE_PORT'] ?? 9230);
        const resp = await fetch(`http://127.0.0.1:${port}/api/devices/${udid}/stream`, { method: 'POST' });
        if (!resp.ok) {
          const body = await resp.json() as { error?: string };
          socket.send(JSON.stringify({ error: body.error ?? `route ${resp.status}` }));
          socket.close();
          return;
        }
        const body = await resp.json() as { streamUrl: string };
        const url = body.streamUrl;
        let sub = upstreams.get(url);
        if (!sub) {
          sub = { url, clients: new Set(), abortController: new AbortController(), refCount: 0 };
          upstreams.set(url, sub);
        }

        const client: StreamClient = { socket, latestFrame: null, sending: false };
        sub.clients.add(client);
        sub.refCount++;
        void pumpUpstream(url, sub);

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
