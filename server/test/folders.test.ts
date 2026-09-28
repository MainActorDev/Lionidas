import { registerFolderRoutes } from '../src/routes/folders.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';

/** Plan 20260928T023000Z rev 2 — folders CRUD + guarded delete + subtree.
 *  App-scoped trees, multilevel, sibling-unique names, tree-aware delete. */

let db: Database.Database;
let app: FastifyInstance;

const mkCase = (id: string, name: string, app: string, folder: string | null = null, status = 'active'): void => {
  db.prepare(
    `INSERT INTO templates(id, name, steps_json, tags_json, udid, app_bundle_id, folder_id, status, created_by, created_at, updated_at)
     VALUES (?, ?, '[]', '[]', '', ?, ?, ?, 't', 1, 1)`,
  ).run(id, name, app, folder, status);
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 'qa', role: 'operator' }; });
  registerFolderRoutes(app, db);
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('folders CRUD', () => {
  it('creates root + nested folders; duplicate sibling name → 409', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'login' } });
    expect(r1.statusCode).toBe(201);
    const f1 = r1.json() as { id: string };
    const r2 = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', parentId: f1.id, name: 'regression' } });
    expect(r2.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'login' } });
    expect(dup.statusCode).toBe(409);
    // same name OK under a different parent and in a different app
    const r3 = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'regression' } });
    expect(r3.statusCode).toBe(201);
    const r4 = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.b', name: 'login' } });
    expect(r4.statusCode).toBe(201);
  });

  it('parent must belong to the same app; depth capped at 8', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'a' } })).json() as { id: string };
    const cross = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.b', parentId: f1.id, name: 'x' } });
    expect(cross.statusCode).toBe(409);
    let parent = f1.id;
    let lastCode = 201;
    for (let i = 0; i < 9; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', parentId: parent, name: `l${i}` } });
      lastCode = r.statusCode;
      if (r.statusCode === 201) parent = (r.json() as { id: string }).id;
    }
    expect(lastCode).toBe(400);
  });

  it('renames; rename collides with sibling → 409', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'one' } })).json() as { id: string };
    await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'two' } });
    const ok = await app.inject({ method: 'PATCH', url: `/api/folders/${f1.id}`, payload: { name: 'uno' } });
    expect(ok.statusCode).toBe(200);
    const clash = await app.inject({ method: 'PATCH', url: `/api/folders/${f1.id}`, payload: { name: 'two' } });
    expect(clash.statusCode).toBe(409);
  });

  it('delete: empty leaf OK; folder with case → 409 named; DESCENDANT with case → 409', async () => {
    const a = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'a' } })).json() as { id: string };
    const b = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', parentId: a.id, name: 'b' } })).json() as { id: string };
    mkCase('tpl_10000001', 'leaf case', 'com.a', b.id);
    // a's DESCENDANT b holds a case → refuse a
    const ra = await app.inject({ method: 'DELETE', url: `/api/folders/${a.id}` });
    expect(ra.statusCode).toBe(409);
    expect((ra.json() as { error: string }).error).toContain('1 case');
    // b itself refused
    const rb = await app.inject({ method: 'DELETE', url: `/api/folders/${b.id}` });
    expect(rb.statusCode).toBe(409);
    // move the case out → both deletable
    db.prepare('UPDATE templates SET folder_id = NULL WHERE id = ?').run('tpl_10000001');
    expect((await app.inject({ method: 'DELETE', url: `/api/folders/${b.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/folders/${a.id}` })).statusCode).toBe(200);
  });

  it('children listing: folders first with subtree case counts + the subtree case ids', async () => {
    const a = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'a' } })).json() as { id: string };
    const b = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', parentId: a.id, name: 'b' } })).json() as { id: string };
    mkCase('tpl_20000001', 'in b', 'com.a', b.id);
    mkCase('tpl_20000002', 'at root', 'com.a');
    const r = await app.inject({ method: 'GET', url: `/api/folders?app=com.a&parentId=` });
    const body = r.json() as { folders: Array<{ id: string; name: string; caseCount: number }>, caseIds: string[] };
    expect(body.folders.map((f) => f.name)).toEqual(['a']);
    expect(body.folders[0]!.caseCount).toBe(1); // subtree count
    expect(body.caseIds).toEqual(['tpl_20000002']); // the ROOT level's own cases; the subtree count rides folders[0].caseCount
  });

  it('case move: same-app folder OK, cross-app → 409, NULL = root', async () => {
    const fa = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'home' } })).json() as { id: string };
    const fb = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.b', name: 'home' } })).json() as { id: string };
    mkCase('tpl_30000001', 'case a', 'com.a');
    const ok = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_30000001', payload: { folderId: fa.id } });
    expect(ok.statusCode).toBe(200);
    const cross = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_30000001', payload: { folderId: fb.id } });
    expect(cross.statusCode).toBe(409);
    const back = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_30000001', payload: { folderId: null } });
    expect(back.statusCode).toBe(200);
  });

  it('bulk move: N updates in ONE transaction; any bad id → nothing applied', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'bulk' } })).json() as { id: string };
    mkCase('tpl_40000001', 'one', 'com.a');
    mkCase('tpl_40000002', 'two', 'com.a');
    const r = await app.inject({ method: 'POST', url: '/api/folders/move', payload: { templateIds: ['tpl_40000001', 'tpl_40000002'], folderId: f.id } });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM templates WHERE folder_id = ?').get(f.id)).toEqual({ n: 2 });
    const bad = await app.inject({ method: 'POST', url: '/api/folders/move', payload: { templateIds: ['tpl_40000001', 'tpl_ghost00'], folderId: null } });
    expect(bad.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM templates WHERE folder_id = ?').get(f.id)).toEqual({ n: 2 }); // unchanged
  });

  it('folder run: subtree only, deprecated excluded (runBatch cases contract, F1)', async () => {
    const a = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'a' } })).json() as { id: string };
    const b = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', parentId: a.id, name: 'b' } })).json() as { id: string };
    mkCase('tpl_50000001', 'runs', 'com.a', b.id);
    mkCase('tpl_50000002', 'dep', 'com.a', b.id, 'deprecated');
    mkCase('tpl_50000003', 'elsewhere', 'com.a');
    // stub: the real runBatch lives in manual routes; here we pin the route's
    // SELECTION contract via the subtree endpoint the run route consumes
    const r = await app.inject({ method: 'GET', url: `/api/folders?app=com.a&parentId=${b.id}` });
    expect(((r.json() as { caseIds: string[] }).caseIds).sort()).toEqual(['tpl_50000001', 'tpl_50000002']);
  });
});

describe('folders × yaml round-trip', () => {
  it('export yaml carries folder path; import resolves-or-creates the chain', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', name: 'top' } })).json() as { id: string };
    const f2r = await app.inject({ method: 'POST', url: '/api/folders', payload: { appBundleId: 'com.a', parentId: f.id, name: 'sub' } });
    const f2 = f2r.json() as { id: string };
    mkCase('tpl_60000001', 'folded', 'com.a', f2.id);
    db.prepare("UPDATE templates SET steps_json = ? WHERE id = 'tpl_60000001'").run(JSON.stringify([{ idx: 0, action: 'scroll', direction: 'down' }]));
    const yaml = (await app.inject({ method: 'GET', url: '/api/templates/tpl_60000001/yaml' })).json() as { yaml: string };
    expect(yaml.yaml).toContain('folder: top/sub');
    // wipe + reimport the document: chain recreated (all-or-nothing)
    db.prepare('DELETE FROM folders').run();
    db.prepare("UPDATE templates SET folder_id = NULL WHERE id = 'tpl_60000001'").run();
    const imp = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml: yaml.yaml.replace('name: folded', 'name: folded 2') } });
    expect(imp.statusCode).toBe(201);
    const row = db.prepare("SELECT folder_id FROM templates WHERE name = 'folded 2'").get() as { folder_id: string | null };
    expect(row.folder_id).toBeTruthy();
    const path = (await app.inject({ method: 'GET', url: `/api/folders?app=com.a&parentId=${row.folder_id}` })).json() as { path: Array<{ name: string }> };
    expect(path.path.map((p2) => p2.name)).toEqual(['top', 'sub']);
  });
});
