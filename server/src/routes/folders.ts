import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireRole } from '../auth/roles.ts';

/** Folders — app-scoped multilevel test-case organization (plan 20260928T023000Z rev 2).
 *  cPanel model: navigation, not disclosure. Sibling names unique per
 *  (app, parent); paths derive at read time via the parent chain — renames
 *  never rewrite descendants. Delete is tree-guarded: refused while the
 *  folder OR any descendant holds cases or subfolders. */

interface FolderRow { id: string; app_bundle_id: string; parent_id: string | null; name: string; created_by: string; created_at: number; updated_at: number }

const MAX_DEPTH = 8;

/** all descendant folder ids of `rootId` (inclusive of rootId) */
function subtreeIds(db: Database.Database, rootId: string): string[] {
  const out: string[] = [];
  const q = [rootId];
  while (q.length > 0) {
    const cur = q.shift()!;
    if (out.includes(cur)) continue; // cycle guard (data corruption defense)
    out.push(cur);
    const kids = db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(cur) as Array<{ id: string }>;
    q.push(...kids.map((k) => k.id));
  }
  return out;
}

/** breadcrumb path labels from root to `id` */
function folderPath(db: Database.Database, id: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  let cur = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(id) as { id: string; name: string; parent_id: string | null } | undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(cur.parent_id) as typeof cur | undefined : undefined;
  }
  return out;
}

/** how many cases + subfolders live under `id`'s subtree (the delete guard) */
function subtreeUsage(db: Database.Database, ids: string[]): { cases: number; subfolders: number } {
  const ph = ids.map(() => '?').join(',');
  const cases = (db.prepare(`SELECT COUNT(*) AS n FROM templates WHERE folder_id IN (${ph})`).get(...ids) as { n: number }).n;
  const subfolders = ids.length - 1; // descendants besides the root of the subtree
  return { cases, subfolders };
}

export function registerFolderRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/folders', { preHandler: requireRole('operator') }, async (req, reply) => {
    const b = req.body as { appBundleId?: string; parentId?: string | null; name?: string };
    if (!b.appBundleId || !b.name?.trim()) return reply.code(400).send({ error: 'appBundleId and name required' });
    const name = b.name.trim();
    // parent validation: same app + depth cap
    let depth = 1;
    if (b.parentId) {
      const parent = db.prepare('SELECT * FROM folders WHERE id = ?').get(b.parentId) as FolderRow | undefined;
      if (!parent) return reply.code(409).send({ error: `parent folder "${b.parentId}" not found` });
      if (parent.app_bundle_id !== b.appBundleId) return reply.code(409).send({ error: `parent folder belongs to ${parent.app_bundle_id} — folders are app-scoped` });
      depth = folderPath(db, parent.id).length + 1;
      if (depth > MAX_DEPTH) return reply.code(400).send({ error: `folders nest at most ${MAX_DEPTH} levels deep` });
    }
    const id = `fld_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    try {
      db.prepare('INSERT INTO folders(id, app_bundle_id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, b.appBundleId, b.parentId ?? null, name, req.user?.name ?? 'unknown', now, now);
    } catch {
      return reply.code(409).send({ error: `a folder named "${name}" already exists here` });
    }
    return reply.code(201).send({ id, appBundleId: b.appBundleId, parentId: b.parentId ?? null, name, createdBy: req.user?.name ?? 'unknown', createdAt: now, updatedAt: now });
  });

  app.patch('/api/folders/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string };
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    try {
      db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(b.name.trim(), Date.now(), id);
    } catch {
      return reply.code(409).send({ error: `a folder named "${b.name.trim()}" already exists here` });
    }
    return { id, name: b.name.trim() };
  });

  app.delete('/api/folders/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ids = subtreeIds(db, id);
    const usage = subtreeUsage(db, ids);
    if (usage.cases > 0 || usage.subfolders > 0) {
      const bits: string[] = [];
      if (usage.cases > 0) bits.push(`${usage.cases} case${usage.cases === 1 ? '' : 's'}`);
      if (usage.subfolders > 0) bits.push(`${usage.subfolders} subfolder${usage.subfolders === 1 ? '' : 's'}`);
      return reply.code(409).send({ error: `folder "${row.name}" isn't empty — ${bits.join(', ')} — move or delete them first` });
    }
    db.prepare('DELETE FROM folders WHERE id = ?').run(id); // empty chain cascades
    return reply.code(200).send({ deleted: id });
  });

  /** children of a folder (or the app root when parentId empty): folders
   *  first (name asc) with SUBTREE case counts, plus the parent's direct
   *  case ids — the UI's navigation + filtering feed (review F2). */
  app.get('/api/folders', async (req) => {
    const q = req.query as { app?: string; parentId?: string };
    if (!q.app) return { folders: [], caseIds: [], path: [] };
    const parentId = q.parentId?.trim() ? q.parentId : null;
    const kids = db.prepare('SELECT * FROM folders WHERE app_bundle_id = ? AND parent_id IS ? ORDER BY name').all(q.app, parentId) as FolderRow[];
    const folders = kids.map((k) => ({ id: k.id, name: k.name, parentId: k.parent_id, caseCount: subtreeUsage(db, subtreeIds(db, k.id)).cases, createdBy: k.created_by, createdAt: k.created_at }));
    const caseIds = parentId
      ? (db.prepare('SELECT id FROM templates WHERE folder_id = ? ORDER BY name').all(parentId) as Array<{ id: string }>).map((r) => r.id)
      : (db.prepare('SELECT id FROM templates WHERE app_bundle_id = ? AND folder_id IS NULL ORDER BY name').all(q.app) as Array<{ id: string }>).map((r) => r.id);
    const path = parentId ? folderPath(db, parentId) : [];
    return { folders, caseIds, path };
  });

  /** bulk move: N folder_id updates in ONE transaction — partial failure
   *  applies nothing. Same-app check per case. */
  app.post('/api/folders/move', { preHandler: requireRole('operator') }, async (req, reply) => {
    const b = req.body as { templateIds?: string[]; folderId?: string | null };
    const ids = (b.templateIds ?? []).filter(Boolean);
    if (ids.length === 0) return reply.code(400).send({ error: 'templateIds required' });
    let folder: FolderRow | null = null;
    if (b.folderId) {
      folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(b.folderId) as FolderRow | undefined ?? null;
      if (!folder) return reply.code(409).send({ error: `folder "${b.folderId}" not found` });
    }
    const tx = db.transaction(() => {
      for (const tid of ids) {
        const tpl = db.prepare('SELECT id, app_bundle_id FROM templates WHERE id = ?').get(tid) as { id: string; app_bundle_id: string | null } | undefined;
        if (!tpl) throw new Error(`unknown template: ${tid}`);
        if (folder && tpl.app_bundle_id !== folder.app_bundle_id) throw new Error(`case ${tid} belongs to ${tpl.app_bundle_id ?? '(no app)'} — folders are app-scoped`);
        db.prepare('UPDATE templates SET folder_id = ?, updated_at = ? WHERE id = ?').run(folder ? folder.id : null, Date.now(), tid);
      }
    });
    try { tx(); } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
    return { moved: ids.length, folderId: folder ? folder.id : null };
  });

  /** folder-level run: resolve subtree ids, drop deprecated, hand runBatch's
   *  `cases` contract to the caller (manual routes mount the actual play —
   *  this route lives there; here we expose the resolution for tests/UI). */
  app.get('/api/folders/:id/subtree-cases', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ph = subtreeIds(db, id).map(() => '?').join(',');
    const all = db.prepare(`SELECT id, status FROM templates WHERE folder_id IN (${ph}) ORDER BY name`).all(...subtreeIds(db, id)) as Array<{ id: string; status: string | null }>;
    const runnable = all.filter((t) => (t.status ?? 'active') !== 'deprecated').map((t) => t.id);
    return { all: all.map((t) => t.id), runnable };
  });
}
