import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { unzipSync } from 'fflate';

/** Plan 20260927T164000Z — duplicate / export(zip) / import (yaml + zip).
 *  One resolution bar: import enforces the PUT-yaml checks via the shared
 *  resolveCaseRefs helper (review F1). Transport for zip is JSON base64
 *  (review F2). Closed loop: export → delete → import reproduces cases. */

let db: Database.Database;
let app: FastifyInstance;

const inject = (user: { name: string; role: string } | null): void => {
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = user; });
};

const mkCase = (id: string, name: string, steps: unknown[], tags: string[] = []): void => {
  db.prepare(
    `INSERT INTO templates(id, name, steps_json, tags_json, udid, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'tester', 1, 1)`,
  ).run(id, name, JSON.stringify(steps), JSON.stringify(tags));
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  inject({ name: 'qa', role: 'operator' });
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('duplicate', () => {
  it('copies the full case verbatim, draft status, (copy) name', async () => {
    mkCase('tpl_aaaaaaa1', 'login flow', [{ action: 'tap', tap: 'btn' }], ['smoke']);
    const res = await app.inject({ method: 'POST', url: '/api/templates/tpl_aaaaaaa1/duplicate' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; status: string; steps: unknown[]; tags: string[] };
    expect(body.name).toBe('login flow (copy)');
    expect(body.status).toBe('draft');
    expect(body.steps).toEqual([expect.objectContaining({ action: 'tap', tap: 'btn' })]);
    expect(body.tags).toEqual(['smoke']);
    expect(body.id).not.toBe('tpl_aaaaaaa1');
  });

  it('suffix bumps: (copy), (copy 2) — collision never surfaces', async () => {
    mkCase('tpl_aaaaaaa1', 'x', [{ action: 'scroll', direction: 'down' }]);
    const c1 = (await app.inject({ method: 'POST', url: '/api/templates/tpl_aaaaaaa1/duplicate' })).json() as { name: string };
    const row1 = db.prepare('SELECT id FROM templates WHERE name = ?').get(c1.name) as { id: string };
    const c2 = (await app.inject({ method: 'POST', url: '/api/templates/tpl_aaaaaaa1/duplicate' })).json() as { name: string };
    const c3 = (await app.inject({ method: 'POST', url: '/api/templates/tpl_aaaaaaa1/duplicate' })).json() as { name: string };
    expect(c2.name).toBe('x (copy 2)');
    expect(c3.name).toBe('x (copy 3)');
    // duplicating the COPY continues the sequence from the copy's own stem
    const c4 = (await app.inject({ method: 'POST', url: `/api/templates/${row1.id}/duplicate` })).json() as { name: string };
    expect(c4.name).toBe('x (copy) (copy)');
  });

  it('404 on unknown id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/templates/nope/duplicate' })).statusCode).toBe(404);
  });

  it('duplicating a deprecated case revives it as draft', async () => {
    mkCase('tpl_bbbbbbb1', 'old', [{ action: 'scroll', direction: 'down' }]);
    db.prepare("UPDATE templates SET status = 'deprecated' WHERE id = 'tpl_bbbbbbb1'").run();
    const res = await app.inject({ method: 'POST', url: '/api/templates/tpl_bbbbbbb1/duplicate' });
    expect((res.json() as { status: string }).status).toBe('draft');
  });
});

describe('import — yaml', () => {
  it('single document imports as draft with fresh id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml: 'name: imported case\nsteps:\n  - scroll: down\n' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: Array<{ id: string; name: string }>; renamed: unknown[] };
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]!.name).toBe('imported case');
    expect(body.renamed).toHaveLength(0);
    const row = db.prepare('SELECT status, steps_json FROM templates WHERE id = ?').get(body.imported[0]!.id) as { status: string; steps_json: string };
    expect(row.status).toBe('draft');
    expect(JSON.parse(row.steps_json)).toEqual([expect.objectContaining({ action: 'scroll', direction: 'down' })]);
  });

  it('multi-document import splits on ---', async () => {
    const yaml = 'name: one\nsteps:\n  - scroll: down\n---\nname: two\nsteps:\n  - scroll: up\n';
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { imported: unknown[] }).imported).toHaveLength(2);
  });

  it('any invalid document rejects ALL (all-or-nothing, named)', async () => {
    const yaml = 'name: good\nsteps:\n  - scroll: down\n---\nname: bad\nsteps: []\n';
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string; allRejected: boolean }).allRejected).toBe(true);
    expect((res.json() as { error: string }).error).toContain('document 2');
    // nothing inserted
    expect((db.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number }).n).toBe(0);
  });

  it('unknown scenario in a variant → 422 naming it (save-bar parity, review F1)', async () => {
    const yaml = 'name: v case\nsteps:\n  - scroll: down\nvariants:\n  - id: v1\n    scenarios: [does-not-exist]\n';
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain('does-not-exist');
  });

  it('unknown screen ref → 422 (save-bar parity)', async () => {
    const yaml = 'name: s case\napp: com.example.app\nsteps:\n  - arrive: home\n';
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain('unknown screen');
  });

  it('name collision suffixes (imported) with bump', async () => {
    mkCase('tpl_ccccccc1', 'clash', [{ action: 'scroll', direction: 'down' }]);
    const yaml = 'name: clash\nsteps:\n  - scroll: down\n';
    const r1 = (await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } })).json() as { imported: Array<{ name: string }>; renamed: Array<{ from: string; to: string }> };
    const r2 = (await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } })).json() as { imported: Array<{ name: string }> };
    expect(r1.imported[0]!.name).toBe('clash (imported)');
    expect(r1.renamed[0]).toEqual({ from: 'clash', to: 'clash (imported)' });
    expect(r2.imported[0]!.name).toBe('clash (imported 2)');
  });

  it('runFlow name → id maps on import', async () => {
    mkCase('tpl_child001', 'the child', [{ action: 'scroll', direction: 'down' }]);
    const yaml = 'name: parent case\nsteps:\n  - runFlow: the child\n';
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: Array<{ id: string }> };
    const row = db.prepare('SELECT steps_json FROM templates WHERE id = ?').get(body.imported[0]!.id) as { steps_json: string };
    expect(JSON.parse(row.steps_json)[0].templateId).toBe('tpl_child001');
  });

  it('empty yaml → 422 named; no body shape → 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/templates/import', payload: {} })).statusCode).toBe(400);
  });
});

describe('export — zip', () => {
  it('no ids = every template; entries re-parse; manifest lists them (F4/F6)', async () => {
    mkCase('tpl_ddddddd1', 'alpha case', [{ action: 'scroll', direction: 'down' }]);
    mkCase('tpl_ddddddd2', 'beta case', [{ action: 'scroll', direction: 'up' }]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(String(res.headers['content-disposition'])).toContain('lionidas-testcases-');
    const entries = unzipSync(new Uint8Array(res.rawPayload ?? Buffer.from(res.body as string, 'binary')));
    const names = Object.keys(entries).sort();
    expect(names).toEqual(['alpha-case.yaml', 'beta-case.yaml', 'manifest.json']);
    // every yaml entry re-parses (round-trip proof)
    for (const n of names) {
      if (!n.endsWith('.yaml')) continue;
      const text = Buffer.from(entries[n]!).toString('utf8');
      const { parseCaseYaml } = await import('@crucible/shared/case-yaml');
      const parsed = parseCaseYaml(text);
      expect(parsed.ok).toBe(true);
    }
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf8')) as { cases: Array<{ name: string; file: string }> };
    expect(manifest.cases.map((c) => c.name).sort()).toEqual(['alpha case', 'beta case']);
  });

  it('ids subset; unknown ids skipped, manifest reflects reality (F5)', async () => {
    mkCase('tpl_eeeeeee1', 'kept', [{ action: 'scroll', direction: 'down' }]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/export?ids=tpl_eeeeeee1,tpl_ghost00' });
    const entries = unzipSync(new Uint8Array(res.rawPayload ?? Buffer.from(res.body as string, 'binary')));
    const yamlNames = Object.keys(entries).filter((k) => k.endsWith('.yaml'));
    expect(yamlNames).toEqual(['kept.yaml']);
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf8')) as { cases: string[] };
    expect(manifest.cases).toHaveLength(1);
  });

  it('duplicate slugs dedupe with -2 inside the archive', async () => {
    mkCase('tpl_fffffff1', 'same name!', [{ action: 'scroll', direction: 'down' }]);
    mkCase('tpl_fffffff2', 'same name?', [{ action: 'scroll', direction: 'up' }]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/export' });
    const entries = unzipSync(new Uint8Array(res.rawPayload ?? Buffer.from(res.body as string, 'binary')));
    const yamlNames = Object.keys(entries).filter((k) => k.endsWith('.yaml')).sort();
    expect(yamlNames).toEqual(['same-name-2.yaml', 'same-name.yaml']);
  });

  it('empty DB exports an empty zip with empty manifest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/export' });
    expect(res.statusCode).toBe(200);
    const entries = unzipSync(new Uint8Array(res.rawPayload ?? Buffer.from(res.body as string, 'binary')));
    expect(Object.keys(entries)).toEqual(['manifest.json']);
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf8')) as { cases: unknown[] };
    expect(manifest.cases).toEqual([]);
  });
});

describe('import — zip (base64 JSON transport, F2)', () => {
  it('the closed loop: export → delete → import reproduces the cases (plan acceptance)', async () => {
    mkCase('tpl_ggggggg1', 'loop one', [{ action: 'scroll', direction: 'down' }], ['a']);
    mkCase('tpl_ggggggg2', 'loop two', [{ action: 'scroll', direction: 'up' }]);
    const exported = (await app.inject({ method: 'GET', url: '/api/templates/export' })).rawPayload!;
    expect(exported.length).toBeGreaterThan(0);

    db.prepare('DELETE FROM templates').run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number }).n).toBe(0);

    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { filename: 'lionidas-testcases.zip', zipBase64: Buffer.from(exported).toString('base64') } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: Array<{ name: string }> };
    expect(body.imported.map((c) => c.name).sort()).toEqual(['loop one', 'loop two']);
    const row = db.prepare("SELECT steps_json, tags_json FROM templates WHERE name = 'loop one'").get() as { steps_json: string; tags_json: string };
    expect(JSON.parse(row.steps_json)).toEqual([expect.objectContaining({ action: 'scroll', direction: 'down' })]);
    expect(JSON.parse(row.tags_json)).toEqual(['a']);
  });

  it('corrupt zip → 422 named', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { filename: 'x.zip', zipBase64: Buffer.from('not a zip').toString('base64') } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain('corrupt zip');
  });

  it('zip with no yaml entries → 422', async () => {
    const { zipSync } = await import('fflate');
    const zip = zipSync({ 'readme.txt': new TextEncoder().encode('hello') });
    const res = await app.inject({ method: 'POST', url: '/api/templates/import', payload: { filename: 'x.zip', zipBase64: Buffer.from(zip).toString('base64') } });
    expect(res.statusCode).toBe(422);
  });
});

describe('authorization', () => {
  it('non-operator is refused on all three surfaces', async () => {
    const fresh = Fastify();
    fresh.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 'v', role: 'viewer' }; });
    registerTemplateRoutes(fresh, db);
    await fresh.ready();
    expect((await fresh.inject({ method: 'POST', url: '/api/templates/tpl_x/duplicate' })).statusCode).toBe(403);
    expect((await fresh.inject({ method: 'GET', url: '/api/templates/export' })).statusCode).toBe(403);
    expect((await fresh.inject({ method: 'POST', url: '/api/templates/import', payload: { yaml: 'name: v\nsteps:\n  - scroll: down\n' } })).statusCode).toBe(403);
    await fresh.close();
  });
});
