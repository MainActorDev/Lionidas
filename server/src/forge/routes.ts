/** Forge management routes: presets, scenarios, traffic, mode. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ForgeState } from './proxy.ts';

export function registerForgeRoutes(app: FastifyInstance, db: Database.Database, forgeState: ForgeState): void {
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
    return { id };
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
    forgeState.presets = presets.map((p) => ({
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
    return { active: forgeState.presets.length };
  });

  app.post('/api/forge/mode', async (req) => {
    const b = req.body as { mode?: string };
    if (b.mode && ['record', 'hybrid', 'intercept'].includes(b.mode)) {
      forgeState.mode = b.mode as 'record' | 'hybrid' | 'intercept';
    }
    return { mode: forgeState.mode };
  });

  app.get('/api/forge/traffic', async (req) => {
    const q = req.query as { runId?: string; limit?: string };
    const limit = Math.min(Number.parseInt(q.limit ?? '100', 10) || 100, 500);
    const rows = q.runId
      ? db.prepare('SELECT * FROM traffic WHERE run_id = ? ORDER BY ts DESC LIMIT ?').all(q.runId, limit)
      : db.prepare('SELECT * FROM traffic ORDER BY ts DESC LIMIT ?').all(limit);
    return { traffic: rows };
  });
}
