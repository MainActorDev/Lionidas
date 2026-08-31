/** Forge management routes: presets, scenarios, traffic, mode. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ForgeState } from './proxy.ts';
import { matchPreset, type Preset } from './matcher.ts';
import { startMitm, stopMitmIfRunning, writeStateFile, mitmRunning } from './mitm/manager.ts';
import { simRoutingState, enableSimRouting, disableSimRouting, installRootCertToSims } from './sim-routing.ts';
import { join } from 'node:path';
import { existsSync } from 'node:fs';


export function registerForgeRoutes(app: FastifyInstance, db: Database.Database, forgeState: ForgeState, forgeBus?: { emit: (type: never, payload: never) => void }): void {
  // presets created/changed from the dashboard must reach the live addon —
  // the state file is the only transport (addon reloads on mtime change).
  const syncPresetsToMitm = (): void => {
    const rows = db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
    try {
      writeStateFile(stateDir, forgeState.mode, rows.map((p) => ({
        id: p['id'] as string,
        method: p['method'] as string,
        pathPattern: p['path_pattern'] as string,
        match: p['match'] as Preset['match'],
        ...(p['headers_json'] ? { headers: JSON.parse(p['headers_json'] as string) as Record<string, string> } : {}),
        status: p['status'] as number,
        ...(p['body_path'] ? { bodyPath: p['body_path'] as string } : {}),
        ...(p['delay_ms'] ? { delayMs: p['delay_ms'] as number } : {}),
        ...(p['seq_json'] ? { seq: JSON.parse(p['seq_json'] as string) as Array<{ status: number }> } : {}),
        ...(p['failure'] ? { failure: p['failure'] as 'timeout' | 'reset' | 'malformed' | 'throttle' } : {}),
      })));
    } catch { /* mitm state write best-effort */ }
    forgeState.presets = rows.map((p) => ({
      id: p['id'] as string,
      method: p['method'] as string,
      pathPattern: p['path_pattern'] as string,
      match: p['match'] as 'exact' | 'glob' | 'regex',
      ...(p['headers_json'] ? { headers: JSON.parse(p['headers_json'] as string) as Record<string, string> } : {}),
      status: p['status'] as number,
      ...(p['body_path'] ? { bodyPath: p['body_path'] as string } : {}),
      ...(p['delay_ms'] ? { delayMs: p['delay_ms'] as number } : {}),
      ...(p['seq_json'] ? { seq: JSON.parse(p['seq_json'] as string) as Array<{ status: number }> } : {}),
      ...(p['failure'] ? { failure: p['failure'] as 'timeout' | 'reset' | 'malformed' | 'throttle' } : {}),
      ...(p['throttle_kbps'] ? { throttleKbps: p['throttle_kbps'] as number } : {}),
    }));
  };

  app.post('/api/forge/presets', async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (typeof b['pathPattern'] !== 'string' || typeof b['status'] !== 'number') {
      return reply.code(400).send({ error: 'pathPattern and status required' });
    }
    const id = `p_${createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 8)}`;
    db.prepare(
      `INSERT OR REPLACE INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, created_by, created_at, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      (b['method'] as string) ?? '*',
      b['pathPattern'] as string,
      (b['match'] as string) ?? 'exact',
      b['status'] as number,
      b['headers'] ? JSON.stringify(b['headers']) : null,
      (b['bodyPath'] as string) ?? null,
      (b['delayMs'] as number) ?? null,
      b['seq'] ? JSON.stringify(b['seq']) : null,
      (b['failure'] as string) ?? null,
      (b['throttleKbps'] as number) ?? null,
      (b['createdBy'] as string) ?? 'api',
      Date.now(),
      createHash('sha256').update(JSON.stringify(b)).digest('hex'),
    );
    syncPresetsToMitm();
    return { id };
  });

  app.delete('/api/forge/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM presets WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    syncPresetsToMitm();
    return { ok: true };
  });

  app.get('/api/forge/presets', async () => {
    const rows = db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all();
    return { presets: rows };
  });

  app.post('/api/forge/scenarios', async (req, reply) => {
    const b = req.body as { name?: string; description?: string; launchArg?: string; presetIds?: string[]; createdBy?: string };
    if (!b.name) return reply.code(400).send({ error: 'name required' });
    const id = `s_${createHash('sha256').update(b.name).digest('hex').slice(0, 8)}`;
    db.prepare(`INSERT OR IGNORE INTO scenarios(id, name, description, launch_arg, created_by, immutable_since) VALUES (?, ?, ?, ?, ?, NULL)`)
      .run(id, b.name, b.description ?? null, b.launchArg ?? null, b.createdBy ?? 'api');
    for (const pid of b.presetIds ?? []) {
      db.prepare(`INSERT OR REPLACE INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)`).run(id, pid);
    }
    return { id };
  });

  app.get('/api/forge/scenarios', async () => {
    const rows = db.prepare('SELECT * FROM scenarios ORDER BY rowid DESC').all();
    return { scenarios: rows };
  });

  // activate: load scenario presets into the shared forge state for a run
  app.post('/api/forge/scenarios/:id/activate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'scenario not found' });
    db.prepare(`UPDATE scenarios SET immutable_since = COALESCE(immutable_since, ?) WHERE id = ?`).run(Date.now(), id);
    const presets = db.prepare(
      `SELECT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id = ? AND so.enabled = 1`,
    ).all(id) as Array<Record<string, unknown>>;
    // mirror the scenario into the MITM state file (addon reloads on mtime change)
    try {
      const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
      writeStateFile(stateDir, forgeState.mode, presets.map((p) => ({
        id: p['id'] as string,
        method: p['method'] as string,
        pathPattern: p['path_pattern'] as string,
        match: p['match'] as Preset['match'],
        ...(p['headers_json'] ? { headers: JSON.parse(p['headers_json'] as string) as Record<string, string> } : {}),  // eslint-disable-line unicorn/no-useless-fallback-in-spread
        status: p['status'] as number,
        ...(p['body_path'] ? { bodyPath: p['body_path'] as string } : {}),
        ...(p['delay_ms'] ? { delayMs: p['delay_ms'] as number } : {}),
        ...(p['seq_json'] ? { seq: JSON.parse(p['seq_json'] as string) as Array<{ status: number }> } : {}),
        ...(p['failure'] ? { failure: p['failure'] as 'timeout' | 'reset' | 'malformed' | 'throttle' } : {}),
      })));
    } catch { /* mitm state write best-effort */ }
    forgeState.presets = presets.map((p) => ({
      id: p['id'] as string,
      method: p['method'] as string,
      pathPattern: p['path_pattern'] as string,
      match: p['match'] as 'exact' | 'glob' | 'regex',
      ...(p['headers_json'] ? { headers: JSON.parse(p['headers_json'] as string) as Record<string, string> } : {}),  // eslint-disable-line unicorn/no-useless-fallback-in-spread
      status: p['status'] as number,
      ...(p['body_path'] ? { bodyPath: p['body_path'] as string } : {}),
      ...(p['delay_ms'] ? { delayMs: p['delay_ms'] as number } : {}),
      ...(p['seq_json'] ? { seq: JSON.parse(p['seq_json'] as string) as Array<{ status: number }> } : {}),
      ...(p['failure'] ? { failure: p['failure'] as 'timeout' | 'reset' | 'malformed' | 'throttle' } : {}),
      ...(p['throttle_kbps'] ? { throttleKbps: p['throttle_kbps'] as number } : {}),
    }));
    return { active: forgeState.presets.length };
  });

  app.post('/api/forge/mode', async (req) => {
    const b = req.body as { mode?: string };
    if (b.mode && ['record', 'hybrid', 'intercept'].includes(b.mode)) {
      forgeState.mode = b.mode as 'record' | 'hybrid' | 'intercept';
      // mode is part of the addon state file — push it live
      syncPresetsToMitm();
    }
    return { mode: forgeState.mode };
  });

  // Match tester: paste method+URL → which preset wins and why (same matcher as the proxy — no second implementation)
  app.post('/api/forge/match-test', async (req, reply) => {
    const b = req.body as { url?: string; method?: string };
    if (!b.url) return reply.code(400).send({ error: 'url required' });
    let u: URL;
    try {
      u = new URL(b.url.startsWith('http') ? b.url : `http://forge.local${b.url}`);
    } catch {
      return reply.code(400).send({ error: 'invalid url' });
    }
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (query[k] = v));
    const hit = matchPreset(forgeState.presets, {
      method: (b.method ?? 'GET').toUpperCase(),
      path: u.pathname,
      query,
      headers: {},
    });
    return hit
      ? { matched: true, presetId: hit.preset.id, pathPattern: hit.preset.pathPattern, reason: hit.reason }
      : { matched: false, presetId: null, reason: 'no preset matched (forwarded in hybrid; 501 in intercept)' };
  });

  // Rehearse: run a smoke flow against the ACTIVE scenario (manual priority,
  // labeled 'rehearse', never rolls up — status.ts excludes note=rehearse)
  app.post('/api/forge/scenarios/:id/rehearse', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { flowsDir?: string; udid?: string; app?: string; artifactPath?: string };
    if (!b.flowsDir || !b.udid || !b.app || !b.artifactPath) {
      return reply.code(400).send({ error: 'flowsDir, udid, app, artifactPath required' });
    }
    const scenario = db.prepare('SELECT name, launch_arg FROM scenarios WHERE id = ?').get(id) as
      | { name: string; launch_arg: string | null }
      | undefined;
    if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
    const { executeRun } = await import('../alloy/runner.ts');
    const { alloyDispatchDepsSync } = await import('../alloy/runtime.ts');
    const launchArgs = scenario.launch_arg ? [scenario.launch_arg] : [];
    const runId = await executeRun(
      {
        ticketKey: `REHEARSE:${scenario.name}`,
        flowsDir: b.flowsDir,
        udid: b.udid,
        app: b.app,
        artifactPath: b.artifactPath,
        launchArgs,
        triggeredBy: 'forge-rehearse',
        kind: 'automated',
      },
      { db, bus: forgeBus as never, artifactsDir: process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts', dispatchDeps: alloyDispatchDepsSync() },
    );
    db.prepare(`UPDATE runs SET note = 'rehearse' WHERE id = ?`).run(runId);
    const trafficCount = (db.prepare(`SELECT COUNT(*) AS c FROM traffic WHERE run_id = ?`).get(runId) as { c: number }).c;
    return { runId, trafficHits: trafficCount };
  });

  // MITM lifecycle
  app.post('/api/forge/mitm/start', async (_req, reply) => {
    try {
      const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
      // stable port: sims stay pointed at the proxy across restarts
      const port = Number(process.env['CRUCIBLE_MITM_PORT'] ?? 52310);
      const h = await startMitm({ db, bus: (forgeBus ?? { emit: () => undefined }) as never, stateDir }, port);
      return { running: true, port: h.port, pid: h.pid };
    } catch (err) {
      return reply.code(503).send({ error: `mitm start failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
  app.post('/api/forge/mitm/stop', async () => {
    await stopMitmIfRunning();
    return { running: false };
  });
  app.get('/api/forge/mitm/status', async () => {
    const s = mitmRunning();
    return s ? { running: true, ...s } : { running: false };
  });

  // Simulator traffic routing: host proxy + sim reboot (PLAN §15.4 — documented
  // toolchain-boundary exception; promoted into Alloy settings once stable).
  app.get('/api/forge/sim-routing', async () => {
    const state = simRoutingState();
    // caReady: hierarchy exists (bootstrap runs on proxy start). A missing CA
    // with routing on would mean plain-HTTP-only capture — surface it.
    const confdir = process.env['CRUCIBLE_MITM_CONFDIR'] ?? `${process.env['HOME'] ?? '/tmp'}/.forge-ca`;
    return { ...state, caReady: existsSync(join(confdir, 'mitmproxy-ca.pem')) };
  });
  app.post('/api/forge/sim-routing', async (req, reply) => {
    const b = req.body as { enabled?: boolean };
    try {
      if (b?.enabled) {
        const mitm = mitmRunning();
        if (!mitm) return reply.code(409).send({ error: 'start the proxy first' });
        // Route + trust in one step: sims need BOTH the host proxy AND the CA
        // in their own trust store (simctl keychain) — host keychains don't reach it.
        const confdir = process.env['CRUCIBLE_MITM_CONFDIR'] ?? `${process.env['HOME'] ?? '/tmp'}/.forge-ca`;
        let trusted = 0;
        try {
          trusted = installRootCertToSims(join(confdir, 'root.crt')).length;
        } catch { /* cert path missing — routing still works for plain HTTP */ }
        const state = enableSimRouting(mitm.port);
        return { ...state, trustedSims: trusted };
      }
      return disableSimRouting();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/forge/traffic', async (req) => {
    const q = req.query as { runId?: string; limit?: string; q?: string };
    const limit = Math.min(Number.parseInt(q.limit ?? '100', 10) || 100, 500);
    const like = q.q ? `%${q.q.replace(/[%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = q.runId
      ? db.prepare('SELECT * FROM traffic WHERE run_id = ? ORDER BY ts DESC LIMIT ?').all(q.runId, limit)
      : like
        ? db.prepare("SELECT * FROM traffic WHERE path LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?").all(like, like, limit)
        : db.prepare('SELECT * FROM traffic ORDER BY ts DESC LIMIT ?').all(limit);
    return { traffic: rows };
  });

  // save as preset from a traffic row: replays the CAPTURED response forever.
  // Body (if captured) is materialized to the forge state dir and referenced by
  // path — the addon reads bodyPath bytes verbatim.
  app.post('/api/forge/traffic/:id/save-preset', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = db.prepare('SELECT * FROM traffic WHERE id = ?').get(id) as
      | { method: string; path: string; host: string | null; status: number; res_sha: string | null; matched_preset_id: string | null }
      | undefined;
    if (!t) return reply.code(404).send({ error: 'traffic row not found' });
    if (t.matched_preset_id) return reply.code(409).send({ error: 'already served by a preset — edit that preset instead' });
    if (!t.res_sha) return reply.code(409).send({ error: 'no captured response body — cannot freeze (binary/oversized/empty)' });

    const body = db.prepare('SELECT body, content_type FROM traffic_bodies WHERE sha = ?').get(t.res_sha) as
      | { body: Uint8Array; content_type: string | null }
      | undefined;
    if (!body) return reply.code(409).send({ error: 'body row missing' });

    const { writeFileSync, mkdirSync } = await import('node:fs');
    const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
    const bodiesDir = join(stateDir, 'preset-bodies');
    mkdirSync(bodiesDir, { recursive: true });
    const bodyPath = join(bodiesDir, `${id}.body`);
    writeFileSync(bodyPath, Buffer.from(body.body));

    const headers = body.content_type ? { 'content-type': body.content_type } : undefined;
    const pid = `p_${createHash('sha256').update(`${t.method}${t.path}${t.status}${t.res_sha}`).digest('hex').slice(0, 8)}`;
    db.prepare(
      `INSERT OR REPLACE INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, created_by, created_at, sha256)
       VALUES (?, ?, ?, 'exact', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(pid, t.method, t.path, t.status, headers ? JSON.stringify(headers) : null, bodyPath, 'save-as-preset', Date.now(), createHash('sha256').update(`${t.res_sha}`).digest('hex'));
    syncPresetsToMitm();
    return { id: pid, bodyPath };
  });

  // one traffic row with decoded bodies (for the detail pane)
  app.get('/api/forge/traffic/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM traffic WHERE id = ?').get(id) as
      | { req_sha: string | null; res_sha: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const getBody = (sha: string | null) => {
      if (!sha) return null;
      const b = db.prepare('SELECT sha, content_type, body, bytes FROM traffic_bodies WHERE sha = ?').get(sha) as
        | { sha: string; content_type: string | null; body: Uint8Array; bytes: number }
        | undefined;
      if (!b) return null;
      const text = Buffer.from(b.body).toString('utf8');
      let pretty: string | null = null;
      if ((b.content_type ?? '').includes('json')) {
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not valid json */ }
      }
      return { sha: b.sha, contentType: b.content_type, bytes: b.bytes, text: text.slice(0, 20_000), pretty };
    };
    const full = db.prepare('SELECT * FROM traffic WHERE id = ?').get(id) as Record<string, unknown>;
    return { ...full, reqBody: getBody(row.req_sha), resBody: getBody(row.res_sha) };
  });
}
