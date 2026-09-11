/** simdeck gated proxy — the seam where crucible's session model enforces
 *  itself against the wrapped device surface.
 *
 *  HTTP leg: reverse-proxy /simdeck/* → the supervised child, stripping the
 *  child's CSP (frame-ancestors 'none' would block the wall's iframe) and
 *  rewriting Host/Origin to the child's authority (its origin check demands
 *  originPort == requestPort — a mismatched Origin 400s the stream WS with
 *  NO visible error; live-found in the Phase 0 spike).
 *
 *  WS leg: bidirectional pipe with a MODE GATE resolved per connection:
 *    drive  — a live manual session for this udid: both directions flow.
 *    watch  — otherwise: upstream→client passes; client→upstream TEXT
 *             frames (their gestures are JSON text) are dropped. Read-only
 *             by construction — stronger than a grant flag living in the
 *             child, which we cannot patch (no forks).
 *  Session finish flips live legs to watch (video continues, input dies —
 *  the existing control-lost UX). Run start closes all client legs for the
 *  udid (hold). */
import type { FastifyInstance } from 'fastify';

interface SimdeckProxyDeps {
  /** child base URL, e.g. http://127.0.0.1:8422 */
  base: () => string;
  /** Is a live manual (driving) session held for this udid right now? */
  isDriving: (udid: string) => boolean;
  /** Register a callback for mode changes: 'finished' | 'run-start' per udid. */
  onSessionEvent: (cb: (ev: { udid: string; kind: 'finished' | 'run-start' }) => void) => () => void;
}

interface Leg {
  udid: string;
  client: import('ws').WebSocket;
  upstream: import('ws').WebSocket;
  mode: 'drive' | 'watch';
  closed: boolean;
}

const legs = new Set<Leg>();

/** Cached ws constructor. Dynamic import because this module runs under both
 *  vitest (CJS interop) and tsx ESM (no `require` — a sync require here crashed
 *  every WS upgrade in production while tests passed). */
let wsCtorPromise: Promise<typeof import('ws').default> | null = null;
function wsCtor(): Promise<typeof import('ws').default> {
  if (!wsCtorPromise) {
    wsCtorPromise = import('ws').then((m) => ((m.default ?? (m as unknown as { WebSocket: typeof import('ws').default }).WebSocket)));
  }
  return wsCtorPromise;
}

/** For tests: snapshot of live legs. */
export function __simdeckLegs(): Array<{ udid: string; mode: string }> {
  return [...legs].map((l) => ({ udid: l.udid, mode: l.mode }));
}

/** Push a still frame (JPEG) to every live leg for a udid as the child's
 *  JPEG-seed envelope (0x04 tag + jpeg) — the run-still feed keeps run-panel
 *  watchers painted while a run holds the device (see stream-relay's feed).
 *  Returns the number of legs painted. */
/** Live (non-closed) leg count for a udid — the still feed's audience probe. */
export function simdeckLegCount(udid: string): number {
  let n = 0;
  for (const l of legs) if (l.udid === udid && !l.closed) n++;
  return n;
}

export function paintStillToLegs(udid: string, jpeg: Buffer): number {
  let n = 0;
  const payload = Buffer.concat([Buffer.from([0x04]), jpeg]);
  const snapshot = Array.from(legs); // legs mutate via kill() on send failure
  for (const l of snapshot) {
    if (l.udid !== udid || l.closed) continue;
    try { l.client.send(payload, { binary: true }); n++; } catch { /* leg dies via its own kill */ }
  }
  return n;
}

/** Close every client leg for a udid (run hold). Upstream stays; the wall
 *  shows its own run overlay. */
export function detachUdid(udid: string): void {
  const snapshot = Array.from(legs); // copy: body deletes from the set
  for (const l of snapshot) {
    if (l.udid === udid && !l.closed) {
      l.closed = true;
      try { l.client.close(); } catch { /* gone */ }
      try { l.upstream.close(); } catch { /* gone */ }
      legs.delete(l);
    }
  }
}

/** Flip live legs to watch (session finish). */
export function demoteUdid(udid: string): void {
  for (const l of legs) if (l.udid === udid) l.mode = 'watch';
}

export function registerSimdeckProxy(app: FastifyInstance, deps: SimdeckProxyDeps): void {
  deps.onSessionEvent((ev) => {
    if (ev.kind === 'run-start') detachUdid(ev.udid);
    else if (ev.kind === 'finished') demoteUdid(ev.udid);
  });

  const childUrl = (path: string): string => `${deps.base()}${path}`;

  // ── HTTP leg ────────────────────────────────────────────────────────────
  // every method EXCEPT GET (GET is registered once below with both a plain
  // handler and a wsHandler — fastify rejects registering GET twice).
  const httpMethods = ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const httpHandler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const path = req.url.replace(/^\/simdeck/, '') || '/'; // child-native paths pass as-is
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'origin' || k === 'cookie' || k === 'connection') continue;
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      const u = new URL(deps.base());
      headers['host'] = u.host;
      headers['origin'] = deps.base(); // child's origin check: origin port must match Host port
      const init: RequestInit = {
        method: req.method,
        headers,
        redirect: 'manual',
      };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body ?? {});
      const up = await fetch(childUrl(path), init);
      const h: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        const kl = k.toLowerCase();
        if (kl === 'content-security-policy' || kl === 'content-security-policy-report-only'
          || kl === 'x-frame-options' || kl === 'set-cookie' || kl === 'transfer-encoding') return;
        h[k] = v;
      });
      reply.code(up.status).headers(h);
      // No HTML rewriting: the embed rides the child's NATIVE url space
      // (/simulators/<udid>), so every absolute-path asset its JS fetches
      // (/target.js, /sim-native.html, /simulators.json…) resolves through
      // the vite→server proxy chain unchanged.
      if (up.body) reply.send(Buffer.from(await up.arrayBuffer()));
      else reply.send();
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'simdeck proxy http fail');
      reply.code(502).send({ error: 'device surface unavailable', retryable: true });
    }
  };

  // child-native roots: their client JS builds /simulators/<udid>/... URLs from
  // location.host at RUNTIME (no HTML rewrite touches those) — the same two
  // legs must answer them, WITH the wsHandler on GET (their stream WS is
  // /simulators/<udid>/stream). Path strip is a no-op on child-native paths.
  const wsHandler = async (connection: unknown, req: import('fastify').FastifyRequest) => {
    const client = ((connection as unknown as { socket?: import('ws').WebSocket }).socket ?? connection) as unknown as import('ws').WebSocket;
    const path = req.url.replace(/^\/simdeck/, '') || '/';
    // stream URL shape: /simdeck/simulators/<udid>/stream?...
    const m = path.match(/^\/simulators\/([^/]+)\/stream/);
    const udid = m?.[1] ?? '';
    const mode: 'drive' | 'watch' = udid && deps.isDriving(udid) ? 'drive' : 'watch';

    const WsMod = await wsCtor(); // cached dynamic import — `require` is undefined under tsx ESM (crashed every upgrade silently)
    const u = new URL(deps.base());
    const upHeaders: Record<string, string> = {
      host: u.host,
      origin: deps.base(),
    };
    const upPath = path.split('/simulators/').length > 1 ? path : path; // already child-shaped
    const upstream = new WsMod(`ws://${u.host}${upPath}`, { headers: upHeaders });

    const leg: Leg = { udid, client, upstream, mode, closed: false };
    legs.add(leg);


    const kill = () => {
      if (leg.closed) return;
      leg.closed = true;
      legs.delete(leg);
      try { client.close(); } catch { /* gone */ }
      try { upstream.close(); } catch { /* gone */ }
    };

    upstream.on('open', () => { /* handshake handled by the ws lib */ });
    upstream.on('message', (data, isBinary) => {
      if (leg.closed) return;
      try { client.send(data, { binary: isBinary }); } catch { kill(); }
    });
    upstream.on('close', kill);
    upstream.on('error', kill);

    client.on('message', (data, isBinary) => {
      if (leg.closed) return;
      // THE GATE: in watch mode, client→upstream TEXT frames (gestures) are
      // dropped. Binary frames don't exist on their control path.
      if (leg.mode === 'watch' && !isBinary) return;
      try { upstream.send(data, { binary: isBinary }); } catch { kill(); }
    });
    client.on('close', kill);
    client.on('error', kill);
  };

  // NOTE: the child's /devices root (physical phones) is deliberately NOT
  // proxied — crucible's own SPA router owns /devices.
  // The embed rides the child's NATIVE url space, so its root assets
  // (/target.js, /sim-native.html, /baguette/*, /vendor/*, …) must route
  // here too. List mirrors Resources/Web top level minus colliding names.
  const prefixes = ['/simdeck', '/simulators',
    '/baguette', '/capture', '/capture-gallery.js', '/carplay-frames',
    '/farm', '/frame-decoder.js', '/network', '/plugin-control.js',
    '/plugin-prompt.js', '/plugin-row-action.js', '/recorder.js', '/screens',
    '/sim-3d.js', '/sim-ax-inspector.js', '/sim-camera.js', '/sim-file-drop.js',
    '/sim-list', '/sim-location.js', '/sim-logs.js', '/sim-native.html',
    '/sim-native.js', '/sim-network.js', '/sim-plugins.js', '/sim-screens.js',
    '/sim-status-bar.js', '/sim-stream.html', '/sim-stream.js', '/sim.html',
    '/stream-format.js', '/stream-session.js', '/target.js', '/toolbar',
    '/vendor'];
  for (const prefix of prefixes) {
    app.route({ method: httpMethods as never, url: `${prefix}/*`, handler: httpHandler });
    // GET carries both the plain handler (pages/assets) and the WS upgrade
    app.route({ method: 'GET', url: `${prefix}/*`, handler: httpHandler, wsHandler });
    if (!prefix.includes('*')) {
      // file-shaped roots (e.g. '/target.js') must ALSO match the exact path —
      // fastify's '*' wildcard only matches whole segments, so '/target.js/*'
      // never matches '/target.js' itself
      app.route({ method: httpMethods as never, url: prefix, handler: httpHandler });
      app.route({ method: 'GET', url: prefix, handler: httpHandler, wsHandler });
    }
  }
  // Root-level API files their JS fetches at runtime (e.g. fetch('/simulators.json')
  // inside external JS files — the HTML rewrite can't touch those, and fastify's
  // '*' wildcard only matches whole path segments, so '/simulators/*' misses
  // '/simulators.json'). Same handlers, no rewrite needed on these paths.
  for (const rootFile of ['/simulators.json', '/devices.json']) {
    app.route({ method: httpMethods as never, url: rootFile, handler: httpHandler });
    app.route({ method: 'GET', url: rootFile, handler: httpHandler });
  }
}
