/** Forge proxy: separate Fastify listener, loopback. record | hybrid | intercept.
 *  Traffic rows + WS events on every request. Per M2 isolation decision:
 *  per-run instances on dynamic ports (DEV base-URL targets); this module is
 *  also mounted by the orchestrator API for scenario management. */
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { matchPreset, seqIndex, advanceSeq, type Preset } from './matcher.ts';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';

export type ForgeMode = 'record' | 'hybrid' | 'intercept';

export interface ForgeDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  artifactsDir: string;
}

export interface ForgeState {
  mode: ForgeMode;
  presets: Preset[];
  activeRunId: string | null;
}

export function createForgeState(): ForgeState {
  return { mode: 'hybrid', presets: [], activeRunId: null };
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export async function startForgeProxy(deps: ForgeDeps, state: ForgeState, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const app = Fastify({ logger: false });

  app.all('/*', async (req, reply) => {
    const url = new URL(req.url, 'http://forge.local');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const mReq = {
      method: req.method,
      path: url.pathname,
      query,
      headers: req.headers as Record<string, string>,
    };

    const hit = matchPreset(state.presets, mReq);
    const t0 = Date.now();

    const logTraffic = (status: number, matchedPresetId: string | null, mode: string): void => {
      const latency = Date.now() - t0;
      const id = `t_${hash(`${Date.now()}${req.id}`)}`;
      deps.db
        .prepare(
          `INSERT OR IGNORE INTO traffic(id, run_id, ts, mode, method, host, path, matched_preset_id, status, latency_ms, req_sha, res_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, state.activeRunId, Date.now(), mode, req.method, req.headers['host'] ?? 'direct', url.pathname, matchedPresetId, status, latency, hash(req.url), hash(String(status)));
      deps.bus.emit('forge.traffic.hit', { id, runId: state.activeRunId, method: req.method, path: url.pathname, status, latencyMs: latency, mode, matchedPresetId });
    };

    // preset hit → serve (hybrid + intercept both honor matches)
    if (hit && state.mode !== 'record') {
      const p = hit.preset;
      let status = p.status;
      let body: string | undefined;
      let delay = p.delayMs ?? 0;

      if (p.failure === 'timeout') {
        logTraffic(0, p.id, 'failure');
        return await new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('forge-timeout')), delay || 2000));
      }
      if (p.failure === 'reset') {
        logTraffic(0, p.id, 'failure');
        return reply.code(599).send('forge-reset');
      }

      if (p.seq && p.seq.length > 0) {
        const i = Math.min(seqIndex(p.id, state.activeRunId), p.seq.length - 1);
        const step = p.seq[i]!;
        status = step.status;
        delay = step.delayMs ?? delay;
        if (step.bodyPath) {
          try {
            body = (await import('node:fs')).readFileSync(step.bodyPath, 'utf8');
          } catch { body = undefined; }
        }
        advanceSeq(p.id, state.activeRunId);
      } else if (p.bodyPath) {
        try {
          body = (await import('node:fs')).readFileSync(p.bodyPath, 'utf8');
        } catch { body = undefined; }
      }

      if (p.failure === 'malformed') body = '{not-json';
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      logTraffic(status, p.id, state.mode);
      reply.code(status);
      if (p.headers) for (const [k, v] of Object.entries(p.headers)) reply.header(k, v);
      return reply.send(body ?? '');
    }

    // unmatched: record/hybrid forward real; intercept → 501
    if (state.mode === 'intercept') {
      logTraffic(501, null, 'intercept');
      return reply.code(501).send({ error: 'forge intercept: no preset matched' });
    }

    const upstream = (req.headers['x-forge-upstream'] as string | undefined) ?? `http://${req.headers['host'] ?? 'localhost'}`;
    try {
      const fwdHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'x-forge-upstream', 'content-length'].includes(k)) continue;
        const val = Array.isArray(v) ? v[0] : v;
        if (typeof val === 'string') fwdHeaders[k] = val;
      }
      const init: { method: string; headers: Record<string, string>; body?: string } = {
        method: req.method,
        headers: fwdHeaders,
      };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body ?? {});
      const res = await fetch(`${upstream}${req.url}`, init);
      const text = await res.text();
      logTraffic(res.status, null, state.mode);
      reply.code(res.status);
      res.headers.forEach((v, k) => {
        if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) reply.header(k, v);
      });
      return reply.send(text);
    } catch (err) {
      logTraffic(0, null, state.mode);
      return reply.code(502).send({ error: `forge upstream failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  await app.listen({ port, host: '127.0.0.1' });
  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  return { port: boundPort, close: () => app.close() };
}
