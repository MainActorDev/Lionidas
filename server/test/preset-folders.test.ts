import { registerPresetFolderRoutes } from '../src/routes/preset-folders.ts';
import { registerForgeRoutes } from '../src/forge/routes.ts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';

/** Plan 20260928T105500Z stage 3 — preset folders (global tree, manual
 *  organization by app per operator) + endpoint grouping is UI-side.
 *  Matcher/serving unchanged: folders are pure organization. */

let db: Database.Database;
let app: FastifyInstance;

const mkPreset = (id: string, path: string, method = 'GET', folder: string | null = null): void => {
  db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, created_by, created_at, sha256, guards_json, folder_id)
              VALUES (?, ?, ?, 'exact', 200, '{}', NULL, NULL, NULL, NULL, NULL, 'qa', 1, 'x', NULL, ?)`).run(id, method, path, folder);
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 'qa', role: 'operator' }; });
  registerPresetFolderRoutes(app, db);
  registerForgeRoutes(app, db, {} as never);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('preset folders CRUD + filter', () => {
  it('folder CRUD: create/nest/rename/delete-empty; delete with preset → 409 both counts', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { name: 'consumer app' } })).json() as { id: string };
    const f2 = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { parentId: f1.id, name: 'tariff' } })).json() as { id: string };
    const dup = await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { name: 'consumer app' } });
    expect(dup.statusCode).toBe(409);
    mkPreset('p_1', '/v1/tariff', 'GET', f2.id);
    const blocked = await app.inject({ method: 'DELETE', url: `/api/preset-folders/${f1.id}` });
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json() as { error: string };
    expect(body.error).toContain('1 preset');
    expect(body.error).toContain('1 subfolder');
    await app.inject({ method: 'PATCH', url: '/api/forge/presets/p_1', payload: { folderId: null } });
    expect((await app.inject({ method: 'DELETE', url: `/api/preset-folders/${f2.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/preset-folders/${f1.id}` })).statusCode).toBe(200);
  });

  it('presets list filters by folder (root = folderless; subtree inside); PATCH moves', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { name: 'appA' } })).json() as { id: string };
    mkPreset('p_root', '/v1/x');
    mkPreset('p_in', '/v1/tariff', 'GET', f1.id);
    const root = (await (await app.inject({ method: 'GET', url: '/api/forge/presets?folderId=' })).json()) as { presets: Array<{ id: string }> };
    expect(root.presets.map((p) => p.id)).toEqual(['p_root']);
    const inside = (await (await app.inject({ method: 'GET', url: `/api/forge/presets?folderId=${f1.id}` })).json()) as { presets: Array<{ id: string }> };
    expect(inside.presets.map((p) => p.id)).toEqual(['p_in']);
    const moved = await app.inject({ method: 'PATCH', url: '/api/forge/presets/p_root', payload: { folderId: f1.id } });
    expect(moved.statusCode).toBe(200);
    const root2 = (await (await app.inject({ method: 'GET', url: '/api/forge/presets?folderId=' })).json()) as { presets: Array<{ id: string }> };
    expect(root2.presets).toEqual([]);
  });

  it('REGRESSION (nested folders): a parent lists its DIRECT presets only — moving presets into a child removes them from the parent view; folder counts stay subtree-based', async () => {
    const app1 = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { name: 'app-one' } })).json() as { id: string };
    const home = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { parentId: app1.id, name: 'home' } })).json() as { id: string };
    mkPreset('p_a', '/v1/a', 'GET', app1.id);
    mkPreset('p_b', '/v1/b', 'GET', app1.id);
    // before: parent shows both
    let inApp = (await (await app.inject({ method: 'GET', url: `/api/forge/presets?folderId=${app1.id}` })).json()) as { presets: Array<{ id: string }> };
    expect(inApp.presets.map((p) => p.id).sort()).toEqual(['p_a', 'p_b']);
    // move both into home
    await app.inject({ method: 'PATCH', url: '/api/forge/presets/p_a', payload: { folderId: home.id } });
    await app.inject({ method: 'PATCH', url: '/api/forge/presets/p_b', payload: { folderId: home.id } });
    // after: parent shows NONE (direct children only) — the reported bug
    inApp = (await (await app.inject({ method: 'GET', url: `/api/forge/presets?folderId=${app1.id}` })).json()) as { presets: Array<{ id: string }> };
    expect(inApp.presets).toEqual([]);
    // …while home shows both, root shows none, and app-one's COUNT is still 2 (subtree)
    const inHome = (await (await app.inject({ method: 'GET', url: `/api/forge/presets?folderId=${home.id}` })).json()) as { presets: Array<{ id: string }> };
    expect(inHome.presets.map((p) => p.id).sort()).toEqual(['p_a', 'p_b']);
    const atRoot = (await (await app.inject({ method: 'GET', url: '/api/forge/presets?folderId=' })).json()) as { presets: Array<{ id: string }> };
    expect(atRoot.presets).toEqual([]);
    const kids = (await (await app.inject({ method: 'GET', url: `/api/preset-folders?parentId=${app1.id}` })).json()) as { folders: Array<{ name: string; presetCount: number }> };
    expect(kids.folders[0]!.presetCount).toBe(2); // home's own subtree count (both presets live in home)
    const rootList = (await (await app.inject({ method: 'GET', url: '/api/preset-folders' })).json()) as { folders: Array<{ name: string; presetCount: number }> };
    expect(rootList.folders.find((f) => f.name === 'app-one')!.presetCount).toBe(2); // subtree count stays
  });

  it('children listing: folders with subtree preset counts + direct preset ids + path', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { name: 'w' } })).json() as { id: string };
    const f2 = (await app.inject({ method: 'POST', url: '/api/preset-folders', payload: { parentId: f1.id, name: 'c' } })).json() as { id: string };
    mkPreset('p_deep', '/v1/t', 'GET', f2.id);
    mkPreset('p_direct', '/v1/d', 'GET', f1.id);
    const inner = (await (await app.inject({ method: 'GET', url: `/api/preset-folders?parentId=${f1.id}` })).json()) as { folders: Array<{ name: string; presetCount: number }>; presets: Array<{ id: string }>; path: Array<{ name: string }> };
    expect(inner.folders[0]!.presetCount).toBe(1);
    expect(inner.presets.map((p) => p.id)).toEqual(['p_direct']);
    expect(inner.path.map((p) => p.name)).toEqual(['w']);
  });
});
