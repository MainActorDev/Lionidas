import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireRole } from '../auth/roles.ts';

/** Scenario folders — GLOBAL multilevel organization for network scenarios
 *  (plan 20260928T092527Z rev 2). Same cPanel model as testcase folders
 *  (routes/folders.ts) minus app scoping: scenarios match URL patterns, not
 *  bundles, so the tree has ONE root. Navigation, not disclosure; sibling
 *  names unique per parent; paths derive at read; delete is tree-guarded
 *  (refused while the subtree holds scenarios or subfolders — review F7:
 *  the 409 names BOTH counts). */

interface ScenarioFolderRow { id: string; parent_id: string | null; name: string; created_by: string; created_at: number; updated_at: number }

const MAX_DEPTH = 8;

/** all descendant folder ids of `rootId` (inclusive) — recursive-CTE equivalent,
 *  iterative with a cycle guard (data-corruption defense) */
export function scenarioSubtreeIds(db: Database.Database, rootId: string): string[] {
  const out: string[] = [];
  const q = [rootId];
  while (q.length > 0) {
    const cur = q.shift()!;
    if (out.includes(cur)) continue;
    out.push(cur);
    const kids = db.prepare('SELECT id FROM scenario_folders WHERE parent_id = ?').all(cur) as Array<{ id: string }>;
    q.push(...kids.map((k) => k.id));
  }
  return out;
}

/** breadcrumb path labels from root to `id` */
export function scenarioFolderPath(db: Database.Database, id: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  let cur = db.prepare('SELECT id, name, parent_id FROM scenario_folders WHERE id = ?').get(id) as { id: string; name: string; parent_id: string | null } | undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? db.prepare('SELECT id, name, parent_id FROM scenario_folders WHERE id = ?').get(cur.parent_id) as typeof cur | undefined : undefined;
  }
  return out;
}

/** how many scenarios + subfolders live under `ids`' subtree (delete guard) */
function subtreeUsage(db: Database.Database, ids: string[]): { scenarios: number; subfolders: number } {
  const ph = ids.map(() => '?').join(',');
  const scenarios = (db.prepare(`SELECT COUNT(*) AS n FROM scenarios WHERE folder_id IN (${ph})`).get(...ids) as { n: number }).n;
  return { scenarios, subfolders: ids.length - 1 };
}

export function registerScenarioFolderRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/scenario-folders', { preHandler: requireRole('operator') }, async (req, reply) => {
    const b = req.body as { parentId?: string | null; name?: string };
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    const name = b.name.trim();
    let depth = 1;
    if (b.parentId) {
      const parent = db.prepare('SELECT * FROM scenario_folders WHERE id = ?').get(b.parentId) as ScenarioFolderRow | undefined;
      if (!parent) return reply.code(409).send({ error: `parent folder "${b.parentId}" not found` });
      depth = scenarioFolderPath(db, parent.id).length + 1;
      if (depth > MAX_DEPTH) return reply.code(400).send({ error: `folders nest at most ${MAX_DEPTH} levels deep` });
    }
    const id = `sfld_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    try {
      db.prepare('INSERT INTO scenario_folders(id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, b.parentId ?? null, name, req.user?.name ?? 'unknown', now, now);
    } catch {
      return reply.code(409).send({ error: `a folder named "${name}" already exists here` });
    }
    return reply.code(201).send({ id, parentId: b.parentId ?? null, name, createdBy: req.user?.name ?? 'unknown', createdAt: now, updatedAt: now });
  });

  app.patch('/api/scenario-folders/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string };
    const row = db.prepare('SELECT * FROM scenario_folders WHERE id = ?').get(id) as ScenarioFolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    try {
      db.prepare('UPDATE scenario_folders SET name = ?, updated_at = ? WHERE id = ?').run(b.name.trim(), Date.now(), id);
    } catch {
      return reply.code(409).send({ error: `a folder named "${b.name.trim()}" already exists here` });
    }
    return { id, name: b.name.trim() };
  });

  app.delete('/api/scenario-folders/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM scenario_folders WHERE id = ?').get(id) as ScenarioFolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ids = scenarioSubtreeIds(db, id);
    const usage = subtreeUsage(db, ids);
    if (usage.scenarios > 0 || usage.subfolders > 0) {
      const bits: string[] = [];
      if (usage.scenarios > 0) bits.push(`${usage.scenarios} scenario${usage.scenarios === 1 ? '' : 's'}`);
      if (usage.subfolders > 0) bits.push(`${usage.subfolders} subfolder${usage.subfolders === 1 ? '' : 's'}`);
      return reply.code(409).send({ error: `folder "${row.name}" isn't empty — ${bits.join(', ')} — move or delete them first` });
    }
    db.prepare('DELETE FROM scenario_folders WHERE id = ?').run(id);
    return reply.code(200).send({ deleted: id });
  });

  /** children of a folder (or the global root when parentId empty): folders
   *  first (name asc) with SUBTREE scenario counts, plus the folder's direct
   *  scenario rows (id + name) and the breadcrumb path. */
  app.get('/api/scenario-folders', async (req) => {
    const q = req.query as { parentId?: string };
    const parentId = q.parentId?.trim() ? q.parentId : null;
    const kids = db.prepare('SELECT * FROM scenario_folders WHERE parent_id IS ? ORDER BY name').all(parentId) as ScenarioFolderRow[];
    const folders = kids.map((k) => ({ id: k.id, name: k.name, parentId: k.parent_id, scenarioCount: subtreeUsage(db, scenarioSubtreeIds(db, k.id)).scenarios, createdBy: k.created_by, createdAt: k.created_at }));
    const scenarios = parentId
      ? (db.prepare('SELECT id, name FROM scenarios WHERE folder_id = ? ORDER BY name').all(parentId) as Array<{ id: string; name: string }>)
      : (db.prepare('SELECT id, name FROM scenarios WHERE folder_id IS NULL ORDER BY name').all() as Array<{ id: string; name: string }>);
    const path = parentId ? scenarioFolderPath(db, parentId) : [];
    return { folders, scenarios, path };
  });
}
