import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';

let db: Database.Database;
let app: FastifyInstance;
beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

function seed(id: string, name: string, steps: unknown[], opts: { tags?: string[]; app?: string } = {}): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, ?, ?, 'qa', 0, 0)`)
    .run(id, name, JSON.stringify(steps), opts.app ?? null, JSON.stringify(opts.tags ?? []));
}

describe('GET /api/templates/vocabulary', () => {
  it('aggregates selectors with uses + source cases, ranked by uses', async () => {
    seed('tpl_1', 'tnc', [
      { idx: 0, action: 'tap', x: 1, y: 2, selector: { label: 'Beranda' } },
      { idx: 1, action: 'expect', selector: { label: 'Beranda' } },
      { idx: 2, action: 'tap', x: 3, y: 4, selector: { identifier: 'ic_barcode' } },
    ], { tags: ['smoke'] });
    seed('tpl_2', 'scan', [
      { idx: 0, action: 'tap', x: 5, y: 6, selector: { label: 'Beranda' } },
    ], { app: 'com.x.y', tags: ['smoke', 'regression'] });
    const r = await app.inject({ method: 'GET', url: '/api/templates/vocabulary' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { selectors: Array<{ value: string; kind: string; uses: number; cases: string[] }> };
    const ber = b.selectors.find((s) => s.value === 'Beranda')!;
    expect(ber.uses).toBe(3);
    expect(ber.cases).toEqual(['tnc', 'scan']);
    expect(b.selectors[0]!.value).toBe('Beranda');   // ranked: 3 uses before 1
  });

  it('caseNames lists all names; apps/tags distinct; empty selectors for selector-less steps', async () => {
    seed('tpl_1', 'tnc', [{ idx: 0, action: 'scroll', direction: 'down' }], { tags: ['smoke'] });
    seed('tpl_2', 'other', [{ idx: 0, action: 'scroll', direction: 'up' }], { app: 'com.a.b', tags: ['smoke', 'rc'] });
    const r = await app.inject({ method: 'GET', url: '/api/templates/vocabulary' });
    const b = r.json() as { caseNames: string[]; apps: string[]; tags: string[]; selectors: unknown[] };
    expect(b.caseNames).toEqual(['tnc', 'other']);
    expect(b.apps).toEqual(['com.a.b']);
    expect(b.tags).toEqual(['smoke', 'rc']);
    expect(b.selectors).toEqual([]);
  });

  it('tolerates malformed steps_json (skips bad rows, never 500s)', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, tags_json, created_by, created_at, updated_at)
                VALUES ('tpl_bad', 'bad', 'sim', '{not json', '[]', 'qa', 0, 0)`).run();
    const r = await app.inject({ method: 'GET', url: '/api/templates/vocabulary' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { caseNames: string[] };
    expect(b.caseNames).toContain('bad');   // name still listed — only selectors skipped
  });
});
