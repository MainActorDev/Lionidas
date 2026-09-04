/** Forge management routes: presets, scenarios, traffic, mode. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ForgeState } from './proxy.ts';
import { matchPreset } from './matcher.ts';
import { forgeStateService } from './state.ts';
import { startMitm, stopMitmIfRunning, mitmRunning } from './mitm/manager.ts';
import { simRoutingState, enableSimRouting, healStaleProxies, installRootCertToSims } from './sim-routing.ts';
import { join } from 'node:path';
import { existsSync } from 'node:fs';


export function registerForgeRoutes(app: FastifyInstance, db: Database.Database, forgeState: ForgeState, forgeBus?: { emit: (type: never, payload: never) => void }): void {
  // presets created/changed from the dashboard must reach the live addon —
  // the state file is the only transport (addon reloads on mtime change).
  // B4b: all state-file writes go through the single-owner service —
  // composition (override ?? DB presets) + serialization live there.
  const syncPresetsToMitm = (): void => forgeStateService({ db, forgeState }).sync();

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

  // ── M3 preset editor: read one (with decoded body), PATCH in place, write body.
  // PATCH must keep the SAME id: ids are referenced by scenario_overrides and
  // matched_preset_id — the old POST-only path forked a new hash id per save
  // while memberships kept pointing at the stale row (the editor's whole job
  // is preventing that).
  app.get('/api/forge/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'preset not found' });
    let body: { text: string | null; contentType: string | null; bytes: number } = { text: null, contentType: null, bytes: 0 };
    const bodyPath = row['body_path'] as string | null;
    if (bodyPath && existsSync(bodyPath)) {
      const { readFileSync } = await import('node:fs');
      const buf = readFileSync(bodyPath);
      const ct = (row['headers_json'] as string | null);
      let contentType: string | null = null;
      if (ct) {
        try { contentType = (JSON.parse(ct) as Record<string, string>)['content-type'] ?? null; } catch { /* malformed headers */ }
      }
      // 256KB editor bound matches the traffic capture bound — beyond that
      // the body is engine data (images/protobuf), not editor text.
      body = { text: buf.length <= 262_144 ? buf.toString('utf8') : null, contentType, bytes: buf.length };
    }
    return { preset: row, body };
  });

  app.patch('/api/forge/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const existing = db.prepare('SELECT id FROM presets WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) return reply.code(404).send({ error: 'preset not found' });
    // partial update — only provided fields change; unknown keys ignored
    const sets: string[] = [];
    const vals: unknown[] = [];
    const col = (name: string, value: unknown): void => { sets.push(`${name} = ?`); vals.push(value); };
    if (b['method'] !== undefined) col('method', b['method'] as string);
    if (b['pathPattern'] !== undefined) {
      const p = b['pathPattern'] as string;
      if (typeof p !== 'string' || !p.startsWith('/')) return reply.code(400).send({ error: 'pathPattern must be an absolute path string' });
      col('path_pattern', p.split('?')[0]); // B9: query never lives in the pattern
    }
    if (b['match'] !== undefined) {
      const m = b['match'] as string;
      if (!['exact', 'glob', 'regex'].includes(m)) return reply.code(400).send({ error: 'match must be exact|glob|regex' });
      col('match', m);
    }
    if (b['status'] !== undefined) {
      const s = b['status'] as number;
      if (typeof s !== 'number' || s < 100 || s > 599) return reply.code(400).send({ error: 'status must be 100-599' });
      col('status', s);
    }
    if (b['headers'] !== undefined) {
      if (b['headers'] === null) col('headers_json', null);
      else {
        const h = b['headers'] as Record<string, string>;
        if (typeof h !== 'object' || Array.isArray(h)) return reply.code(400).send({ error: 'headers must be an object' });
        col('headers_json', JSON.stringify(h));
      }
    }
    if (b['delayMs'] !== undefined) col('delay_ms', (b['delayMs'] as number | null) === null ? null : Math.max(0, b['delayMs'] as number));
    if (b['throttleKbps'] !== undefined) col('throttle_kbps', (b['throttleKbps'] as number | null) === null ? null : Math.max(0, b['throttleKbps'] as number));
    if (b['failure'] !== undefined) {
      const f = b['failure'] as string | null;
      if (f !== null && !['timeout', 'reset', 'malformed', 'throttle'].includes(f)) return reply.code(400).send({ error: 'failure must be timeout|reset|malformed|throttle' });
      col('failure', f);
    }
    if (b['seq'] !== undefined) {
      if (b['seq'] === null) col('seq_json', null);
      else {
        const s = b['seq'] as Array<{ status: number; delayMs?: number; bodyPath?: string }>;
        if (!Array.isArray(s) || s.length === 0 || s.some((e) => typeof e['status'] !== 'number')) {
          return reply.code(400).send({ error: 'seq must be a non-empty array of {status, delayMs?, bodyPath?}' });
        }
        col('seq_json', JSON.stringify(s));
      }
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'no updatable fields provided' });
    col('created_by', 'editor');
    col('sha256', createHash('sha256').update(`${id}|${Date.now()}`).digest('hex'));
    db.prepare(`UPDATE presets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    syncPresetsToMitm();
    return { ok: true, id };
  });

  // body write: text lands in the B6 bodies dir (tmp+rename, B4a atomicity),
  // body_path set, optional contentType merged into headers_json.
  app.put('/api/forge/presets/:id/body', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { text?: string; contentType?: string | null };
    const existing = db.prepare('SELECT id, headers_json FROM presets WHERE id = ?').get(id) as { id: string; headers_json: string | null } | undefined;
    if (!existing) return reply.code(404).send({ error: 'preset not found' });
    if (typeof b['text'] !== 'string') return reply.code(400).send({ error: 'text required' });
    const buf = Buffer.from(b['text'], 'utf8');
    if (buf.length > 262_144) return reply.code(415).send({ error: `body too large for the editor (${buf.length}B > 256KB) — edit the file at its body_path directly` });
    const { writeFileSync, mkdirSync, renameSync } = await import('node:fs');
    const bodiesDir = forgeStateService({ db, forgeState }).bodiesDir;
    mkdirSync(bodiesDir, { recursive: true });
    const finalPath = join(bodiesDir, `${id}.body`);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, buf);
    renameSync(tmpPath, finalPath); // atomic — the addon never sees a torn body
    if (b['contentType'] !== undefined) {
      let headers: Record<string, string> = {};
      try { headers = existing.headers_json ? JSON.parse(existing.headers_json) as Record<string, string> : {}; } catch { /* malformed — rebuild */ }
      if (b['contentType'] === null || b['contentType'] === '') delete headers['content-type'];
      else headers['content-type'] = b['contentType'];
      db.prepare('UPDATE presets SET headers_json = ? WHERE id = ?').run(Object.keys(headers).length ? JSON.stringify(headers) : null, id);
    }
    db.prepare('UPDATE presets SET body_path = ? WHERE id = ?').run(finalPath, id);
    syncPresetsToMitm();
    return { ok: true, bodyPath: finalPath, bytes: buf.length };
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

  // ── M3 scenario management: rename, delete, membership read/write.
  // References are by stable id (plans.scenario_id, queue scenarioId) — rename
  // is safe for saved plans; delete leaves a dangling id that fail-opens to
  // live traffic at play time (disclosed in the UI confirm).
  app.patch('/api/forge/scenarios/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string; description?: string | null; launchArg?: string | null };
    const row = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'scenario not found' });
    if (b.name !== undefined) {
      if (!b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
      const clash = db.prepare('SELECT id FROM scenarios WHERE name = ? AND id != ?').get(b.name.trim(), id);
      if (clash) return reply.code(409).send({ error: `a scenario named "${b.name.trim()}" already exists` });
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.name !== undefined) { sets.push('name = ?'); vals.push(b.name.trim()); }
    if (b.description !== undefined) { sets.push('description = ?'); vals.push(b.description); }
    if (b.launchArg !== undefined) { sets.push('launch_arg = ?'); vals.push(b.launchArg); }
    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    db.prepare(`UPDATE scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return { ok: true, id };
  });

  app.delete('/api/forge/scenarios/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'scenario not found' });
    // membership rows cascade (FK) — but a mid-activation delete would leave
    // the in-process proxy serving ghost presets; clear the override path.
    forgeStateService({ db, forgeState }).clearScenario();
    return { ok: true };
  });

  app.get('/api/forge/scenarios/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'scenario not found' });
    const members = db.prepare(
      `SELECT so.preset_id, so.enabled, p.method, p.path_pattern, p.status
       FROM scenario_overrides so JOIN presets p ON p.id = so.preset_id
       WHERE so.scenario_id = ? ORDER BY p.created_at DESC`,
    ).all(id);
    return { scenario: row, members };
  });

  // replace-set semantics: the body IS the full membership list.
  app.put('/api/forge/scenarios/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { members?: Array<{ presetId: string; enabled?: boolean }> };
    const row = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'scenario not found' });
    if (!Array.isArray(b.members)) return reply.code(400).send({ error: 'members array required' });
    for (const m of b.members) {
      if (typeof m?.presetId !== 'string') return reply.code(400).send({ error: 'each member needs presetId' });
      if (!db.prepare('SELECT 1 FROM presets WHERE id = ?').get(m.presetId)) {
        return reply.code(400).send({ error: `unknown preset ${m.presetId}` });
      }
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM scenario_overrides WHERE scenario_id = ?').run(id);
      const ins = db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, ?)');
      for (const m of b.members!) ins.run(id, m.presetId, m.enabled === false ? 0 : 1);
    });
    tx();
    return { ok: true, count: b.members.length };
  });


  // activate: load scenario presets into the shared forge state for a run.
  // M3: the service owns row→spec mapping AND both proxy consumers (state
  // file + in-process serving set) — this route is now lookup + one call.
  app.post('/api/forge/scenarios/:id/activate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'scenario not found' });
    db.prepare(`UPDATE scenarios SET immutable_since = COALESCE(immutable_since, ?) WHERE id = ?`).run(Date.now(), id);
    const presets = db.prepare(
      `SELECT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id = ? AND so.enabled = 1`,
    ).all(id) as Array<Record<string, unknown>>;
    forgeStateService({ db, forgeState }).activateScenario(presets);
    return { active: presets.length };
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
      // OFF = all-service heal (kill switch): clears every stale localhost
      // proxy on every service — one POST restores the internet of a cloud
      // Mac even when the default route moved since enable. Returns what
      // healed so the caller/UI can show it.
      const healed = healStaleProxies();
      return { ...simRoutingState(), healed };
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

    // B6: bodies go under the server data dir via the state service —
    // /tmp gets purged by macOS and presets silently served nothing.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const bodiesDir = forgeStateService({ db, forgeState }).bodiesDir;
    mkdirSync(bodiesDir, { recursive: true });
    const bodyPath = join(bodiesDir, `${id}.body`);
    writeFileSync(bodyPath, Buffer.from(body.body));

    const headers = body.content_type ? { 'content-type': body.content_type } : undefined;
    const pid = `p_${createHash('sha256').update(`${t.method}${t.path}${t.status}${t.res_sha}`).digest('hex').slice(0, 8)}`;
    db.prepare(
      `INSERT OR REPLACE INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, created_by, created_at, sha256)
       VALUES (?, ?, ?, 'exact', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    // B9: path identity — the stored pattern drops the query string;
    // query-intent lives in preset guards (already supported by the addon).
    ).run(pid, t.method, t.path.split('?')[0], t.status, headers ? JSON.stringify(headers) : null, bodyPath, 'save-as-preset', Date.now(), createHash('sha256').update(`${t.res_sha}`).digest('hex'));
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
