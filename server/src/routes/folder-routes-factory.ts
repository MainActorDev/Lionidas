import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireRole } from '../auth/roles.ts';

/** Generic cPanel folder routes (plan 20260928T105500Z stage 3): the SAME
 *  tree semantics factored out of scenario-folders.ts — create/nest/rename,
 *  delete-empty 409 naming BOTH counts (folders + items), depth cap 8,
 *  sibling-unique names, children listing with subtree item counts.
 *  Registered per entity: scenarios and presets both use it. */

export interface FolderEntityConfig {
  /** routes mount under /api/${routeBase} */
  routeBase: string;
  folderTable: string;
  /** the entity table carrying folder_id */
  itemTable: string;
  /** plural noun for 409 copy, e.g. 'scenario' / 'preset' */
  itemNoun: string;
  /** id prefix, e.g. 'sfld_' / 'pfld_' */
  idPrefix: string;
  /** item columns returned in the children listing */
  itemColumns: string;
  itemOrder: string;
}

interface FolderRow { id: string; parent_id: string | null; name: string; created_by: string; created_at: number; updated_at: number }

const MAX_DEPTH = 8;

export function folderSubtreeIds(db: Database.Database, table: string, rootId: string): string[] {
  const out: string[] = [];
  const q = [rootId];
  while (q.length > 0) {
    const cur = q.shift()!;
    if (out.includes(cur)) continue;
    out.push(cur);
    const kids = db.prepare(`SELECT id FROM ${table} WHERE parent_id = ?`).all(cur) as Array<{ id: string }>;
    q.push(...kids.map((k) => k.id));
  }
  return out;
}

export function folderPath(db: Database.Database, table: string, id: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  let cur = db.prepare(`SELECT id, name, parent_id FROM ${table} WHERE id = ?`).get(id) as { id: string; name: string; parent_id: string | null } | undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? db.prepare(`SELECT id, name, parent_id FROM ${table} WHERE id = ?`).get(cur.parent_id) as typeof cur | undefined : undefined;
  }
  return out;
}

export function registerFolderRoutes(app: FastifyInstance, db: Database.Database, cfg: FolderEntityConfig): void {
  const { routeBase, folderTable, itemTable, itemNoun, idPrefix } = cfg;
  const subtreeUsage = (ids: string[]): { items: number; subfolders: number } => {
    const ph = ids.map(() => '?').join(',');
    const items = (db.prepare(`SELECT COUNT(*) AS n FROM ${itemTable} WHERE folder_id IN (${ph})`).get(...ids) as { n: number }).n;
    return { items, subfolders: ids.length - 1 };
  };

  app.post(`/api/${routeBase}`, { preHandler: requireRole('operator') }, async (req, reply) => {
    const b = req.body as { parentId?: string | null; name?: string };
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    const name = b.name.trim();
    let depth = 1;
    if (b.parentId) {
      const parent = db.prepare(`SELECT * FROM ${folderTable} WHERE id = ?`).get(b.parentId) as FolderRow | undefined;
      if (!parent) return reply.code(409).send({ error: `parent folder "${b.parentId}" not found` });
      depth = folderPath(db, folderTable, parent.id).length + 1;
      if (depth > MAX_DEPTH) return reply.code(400).send({ error: `folders nest at most ${MAX_DEPTH} levels deep` });
    }
    const id = `${idPrefix}${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    try {
      db.prepare(`INSERT INTO ${folderTable}(id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, b.parentId ?? null, name, req.user?.name ?? 'unknown', now, now);
    } catch {
      return reply.code(409).send({ error: `a folder named "${name}" already exists here` });
    }
    return reply.code(201).send({ id, parentId: b.parentId ?? null, name, createdBy: req.user?.name ?? 'unknown', createdAt: now, updatedAt: now });
  });

  app.patch(`/api/${routeBase}/:id`, { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string };
    const row = db.prepare(`SELECT * FROM ${folderTable} WHERE id = ?`).get(id) as FolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    try {
      db.prepare(`UPDATE ${folderTable} SET name = ?, updated_at = ? WHERE id = ?`).run(b.name.trim(), Date.now(), id);
    } catch {
      return reply.code(409).send({ error: `a folder named "${b.name.trim()}" already exists here` });
    }
    return { id, name: b.name.trim() };
  });

  app.delete(`/api/${routeBase}/:id`, { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`SELECT * FROM ${folderTable} WHERE id = ?`).get(id) as FolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ids = folderSubtreeIds(db, folderTable, id);
    const usage = subtreeUsage(ids);
    if (usage.items > 0 || usage.subfolders > 0) {
      const bits: string[] = [];
      if (usage.items > 0) bits.push(`${usage.items} ${itemNoun}${usage.items === 1 ? '' : 's'}`);
      if (usage.subfolders > 0) bits.push(`${usage.subfolders} subfolder${usage.subfolders === 1 ? '' : 's'}`);
      return reply.code(409).send({ error: `folder "${row.name}" isn't empty — ${bits.join(', ')} — move or delete them first` });
    }
    db.prepare(`DELETE FROM ${folderTable} WHERE id = ?`).run(id);
    return reply.code(200).send({ deleted: id });
  });

  app.get(`/api/${routeBase}`, async (req) => {
    const q = req.query as { parentId?: string };
    const parentId = q.parentId?.trim() ? q.parentId : null;
    const kids = db.prepare(`SELECT * FROM ${folderTable} WHERE parent_id IS ? ORDER BY name`).all(parentId) as FolderRow[];
    const folders = kids.map((k) => ({ id: k.id, name: k.name, parentId: k.parent_id, [`${itemNoun}Count`]: subtreeUsage(folderSubtreeIds(db, folderTable, k.id)).items, createdBy: k.created_by, createdAt: k.created_at }));
    const items = parentId
      ? (db.prepare(`SELECT ${cfg.itemColumns} FROM ${itemTable} WHERE folder_id = ? ORDER BY ${cfg.itemOrder}`).all(parentId))
      : (db.prepare(`SELECT ${cfg.itemColumns} FROM ${itemTable} WHERE folder_id IS NULL ORDER BY ${cfg.itemOrder}`).all());
    const path = parentId ? folderPath(db, folderTable, parentId) : [];
    return { folders, [itemNoun === 'scenario' ? 'scenarios' : 'presets']: items, path };
  });
}
