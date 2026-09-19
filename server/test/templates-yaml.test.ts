import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { migrateM1 } from '../src/db/schema.ts';

/** T1: YAML routes — validate (pure), GET :id/yaml (name resolution for
 *  runFlow), PUT :id/yaml (validate → resolve → persist). One validator backs
 *  both preview and save. */

let db: Database.Database;
let app: FastifyInstance;

const mkCase = (id: string, name: string, steps: unknown[], extra = ''): void => {
  db.prepare(
    `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at${extra ? ', app_name, app_version' : ''})
     VALUES (?, ?, NULL, NULL, '', 428, 926, ?, NULL, '[]', 't', 1, 1${extra ? ", NULL, NULL" : ''})`,
  ).run(id, name, JSON.stringify(steps));
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('POST /api/templates/yaml/validate (pure)', () => {
  it('valid yaml → ok with parsed case', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates/yaml/validate', payload: { yaml: 'name: x\nsteps:\n  - scroll: down\n' } });
    expect(res.statusCode).toBe(200);
    const b = res.json() as { ok: boolean; case: { name: string; steps: unknown[] } };
    expect(b.ok).toBe(true);
    expect(b.case.name).toBe('x');
    expect(b.case.steps).toHaveLength(1);
  });
  it('invalid yaml → ok:false with errors (not a 500)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates/yaml/validate', payload: { yaml: 'steps: []' } });
    const b = res.json() as { ok: boolean; errors: Array<{ message: string }> };
    expect(b.ok).toBe(false);
    expect(b.errors.length).toBeGreaterThan(0);
  });
});

describe('GET /api/templates/:id/yaml', () => {
  it('serializes steps; runFlow ids resolve to child case NAMES', async () => {
    mkCase('tpl_child01', 'dismiss-onboarding', [{ action: 'scroll', direction: 'down', idx: 0 }]);
    mkCase('tpl_parent1', 'parent', [
      { action: 'tap', x: 10, y: 20, idx: 0, selector: { label: 'Go' } },
      { action: 'runFlow', templateId: 'tpl_child01', idx: 1 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/tpl_parent1/yaml' });
    expect(res.statusCode).toBe(200);
    const { yaml } = res.json() as { yaml: string };
    expect(yaml).toContain('name: parent');
    expect(yaml).toContain('on: Go');
    expect(yaml).toContain('runFlow: { name: dismiss-onboarding }');
    expect(yaml).not.toContain('tpl_child01'); // id never surfaces to humans
  });
  it('404 unknown', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/templates/nope/yaml' })).statusCode).toBe(404);
  });
});

describe('PUT /api/templates/:id/yaml', () => {
  it('round-trip: GET yaml → edit → PUT → steps_json reflects the edit', async () => {
    mkCase('tpl_editme1', 'edit me', [{ action: 'tap', x: 1, y: 2, idx: 0, selector: { label: 'Old' } }]);
    const got = (await app.inject({ method: 'GET', url: '/api/templates/tpl_editme1/yaml' })).json() as { yaml: string };
    const edited = got.yaml
      .replace('on: Old', 'on: New')
      .replace('name: edit me', 'name: edited name')
      + '  - expect: Saved\n';
    const res = await app.inject({ method: 'PUT', url: '/api/templates/tpl_editme1/yaml', payload: { yaml: edited } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT name, steps_json FROM templates WHERE id = ?').get('tpl_editme1') as { name: string; steps_json: string };
    expect(row.name).toBe('edited name');
    const steps = JSON.parse(row.steps_json) as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ selector: { label: 'New' } });
    expect(steps[1]).toMatchObject({ action: 'expect', selector: { label: 'Saved' } });
  });

  it('422 with the validator errors on schema violation', async () => {
    mkCase('tpl_badyaml', 'bad', [{ action: 'scroll', direction: 'down', idx: 0 }]);
    const res = await app.inject({ method: 'PUT', url: '/api/templates/tpl_badyaml/yaml', payload: { yaml: 'name: x\nsteps:\n  - tap: { point: [1, 2], optinal: true }\n' } });
    expect(res.statusCode).toBe(422);
    const b = res.json() as { errors: Array<{ message: string }> };
    expect(b.errors[0]!.message).toContain('optinal');
  });

  it('409 on runFlow name that does not exist; resolves valid names to ids', async () => {
    mkCase('tpl_flowa01', 'flow-a', [{ action: 'scroll', direction: 'down', idx: 0 }]);
    mkCase('tpl_flowb02', 'uses-flow', [{ action: 'scroll', direction: 'up', idx: 0 }]);
    const missing = await app.inject({ method: 'PUT', url: '/api/templates/tpl_flowb02/yaml', payload: { yaml: 'name: x\nsteps:\n  - runFlow: no-such-case\n' } });
    expect(missing.statusCode).toBe(409);
    const ok = await app.inject({ method: 'PUT', url: '/api/templates/tpl_flowb02/yaml', payload: { yaml: 'name: x\nsteps:\n  - runFlow: flow-a\n' } });
    expect(ok.statusCode).toBe(200);
    const steps = JSON.parse((db.prepare('SELECT steps_json FROM templates WHERE id = ?').get('tpl_flowb02') as { steps_json: string }).steps_json) as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ action: 'runFlow', templateId: 'tpl_flowa01' }); // name resolved to id
  });

  it('rename collision via yaml → 409 (templates.name is UNIQUE — ambiguity impossible)', async () => {
    mkCase('tpl_dup00001', 'taken', []);
    mkCase('tpl_dup00002', 'renamer', []);
    const res = await app.inject({ method: 'PUT', url: '/api/templates/tpl_dup00002/yaml', payload: { yaml: 'name: taken\nsteps:\n  - scroll: down\n' } });
    expect(res.statusCode).toBe(409);
    expect(((res.json() as { errors: Array<{ message: string }> }).errors[0]!.message)).toContain('already exists');
  });

  it('404 unknown id', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/templates/nope/yaml', payload: { yaml: 'name: x\nsteps:\n  - scroll: down\n' } })).statusCode).toBe(404);
  });
});

describe('GET /api/templates/:id/evidence/:kind (resolver)', () => {
  it('404 for unknown kind and never-run template', async () => {
    const badKind = await app.inject({ method: 'GET', url: '/api/templates/tp1/evidence/nonsense' });
    expect(badKind.statusCode).toBe(404);
    const noRun = await app.inject({ method: 'GET', url: '/api/templates/tp-none/evidence/screenshot' });
    expect(noRun.statusCode).toBe(404);
  });

  it('redirects to the evidence file route for the newest finished run', async () => {
    mkCase('tp-ev', 'ev case', [{ idx: 0, action: 'scroll', direction: 'down' }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id)
                VALUES ('r-ev1', 'T', 'manual', 'passed', 'qa', 's', 1, 2, 'n', 'tp-ev')`).run();
    db.prepare(`INSERT INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at)
                VALUES ('ev-shot1', 'r-ev1', 'screenshot', '/tmp/x.png', 'h', 1, NULL, 0)`).run();
    const res = await app.inject({ method: 'GET', url: '/api/templates/tp-ev/evidence/screenshot' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/api/evidence/ev-shot1/file');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('404 when the newest run lacks that kind', async () => {
    mkCase('tp-ev2', 'ev case 2', [{ idx: 0, action: 'scroll', direction: 'down' }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id)
                VALUES ('r-ev2', 'T', 'manual', 'passed', 'qa', 's', 1, 2, 'n', 'tp-ev2')`).run();
    const res = await app.inject({ method: 'GET', url: '/api/templates/tp-ev2/evidence/video' });
    expect(res.statusCode).toBe(404);
  });

  it('list endpoint carries evidence flags', async () => {
    mkCase('tp-flag', 'flag case', [{ idx: 0, action: 'scroll', direction: 'down' }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id)
                VALUES ('r-flag', 'T', 'manual', 'passed', 'qa', 's', 1, 2, 'n', 'tp-flag')`).run();
    db.prepare(`INSERT INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at)
                VALUES ('ev-f1', 'r-flag', 'screenshot', '/tmp/y.png', 'h', 1, NULL, 0)`).run();
    const res = await app.inject({ method: 'GET', url: '/api/templates' });
    const b = res.json() as { templates: Array<{ id: string; evidence?: { screenshot: boolean; video: boolean } }> };
    const flagged = b.templates.find((t) => t.id === 'tp-flag');
    expect(flagged?.evidence).toEqual({ screenshot: true, video: false });
    const none = b.templates.find((t) => t.id === 'tp-ev2') ?? b.templates.find((t) => !t.evidence);
    if (none && none.id === 'tp-ev2') expect(none.evidence).toEqual({ screenshot: false, video: false });
  });
});

describe('evidence resolver — per-expect preference', () => {
  function seedRunWithSteps(tid: string, steps: Array<{ idx: number; name: string; status: string; ev?: string }>): void {
    mkCase(tid, 'c', [{ idx: 0, action: 'scroll', direction: 'down' }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id)
                VALUES ('r-' || ?, 'T', 'manual', 'passed', 'qa', 's', 1, 2, 'n', ?)`).run(tid, tid);
    for (const st of steps) {
      db.prepare(`INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, started_at, duration_ms, evidence_ids_json)
                  VALUES ('r-' || ?, ?, 't', 'expect', ?, ?, 0, 0, ?)`).run(tid, st.idx, st.name, st.status, JSON.stringify(st.ev ? [st.ev] : []));
    }
    for (const st of steps) {
      if (st.ev) db.prepare(`INSERT INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at)
                             VALUES (?, 'r-' || ?, 'screenshot', '/tmp/' || ? || '.png', ?, 1, NULL, 0)`).run(st.ev, tid, st.ev, st.ev);
    }
  }

  it('prefers the FAILED expect screenshot over later passing ones', async () => {
    seedRunWithSteps('tp-f', [
      { idx: 0, name: 'expect A', status: 'pass', ev: 'ev-a' },
      { idx: 1, name: 'expect B', status: 'fail', ev: 'ev-b' },
      { idx: 2, name: 'expect C', status: 'pass', ev: 'ev-c' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/tp-f/evidence/screenshot' });
    expect(res.headers['location']).toBe('/api/evidence/ev-b/file');
  });

  it('all-pass → LAST expect screenshot', async () => {
    seedRunWithSteps('tp-p', [
      { idx: 0, name: 'expect A', status: 'pass', ev: 'ev-p1' },
      { idx: 1, name: 'expect B', status: 'pass', ev: 'ev-p2' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/tp-p/evidence/screenshot' });
    expect(res.headers['location']).toBe('/api/evidence/ev-p2/file');
  });

  it('gallery endpoint lists step shots in order + video last', async () => {
    seedRunWithSteps('tp-g', [{ idx: 0, name: 'expect A', status: 'pass', ev: 'ev-g1' }]);
    db.prepare(`INSERT INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at)
                VALUES ('ev-gvid', 'r-' || 'tp-g', 'video', '/tmp/v.mp4', 'h', 1, NULL, 0)`).run();
    const res = await app.inject({ method: 'GET', url: '/api/templates/tp-g/evidence' });
    const b = res.json() as { lanes: Array<{ variantId: string | null; runId: string; runStatus: string; startedAt: number; items: Array<{ stepIdx: number; kind: string; evId: string }> }> };
    expect(b.lanes).toHaveLength(1);
    expect(b.lanes[0]!.variantId).toBeNull();          // variantless lane
    expect(b.lanes[0]!.runId).toBe('r-tp-g');
    expect(b.lanes[0]!.runStatus).toBe('passed');      // lane header fields (008-C)
    expect(typeof b.lanes[0]!.startedAt).toBe('number');
    expect(b.lanes[0]!.items.map((i) => i.evId)).toEqual(['ev-g1', 'ev-gvid']);
    expect(b.lanes[0]!.items[1]!.stepIdx).toBe(-1);
  });

  it('gallery groups ONE LANE PER VARIANT — each lane its newest finished run', async () => {
    seedRunWithSteps('tp-vg', [{ idx: 0, name: 'expect A', status: 'pass', ev: 'ev-vg1' }]);
    // two variant runs: my newer than sg (same template)
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id, variant_id)
                VALUES ('r-vg-sg', 'T', 'manual', 'passed', 'qa', 's', 100, 200, 'n', 'tp-vg', 'sg')`).run();
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id, variant_id)
                VALUES ('r-vg-my', 'T', 'manual', 'passed', 'qa', 's', 300, 400, 'n', 'tp-vg', 'my')`).run();
    // an OLDER sg run — must NOT appear (lane keeps newest only)
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id, variant_id)
                VALUES ('r-vg-sg-old', 'T', 'manual', 'passed', 'qa', 's', 10, 20, 'n', 'tp-vg', 'sg')`).run();
    const res = await app.inject({ method: 'GET', url: '/api/templates/tp-vg/evidence' });
    const b = res.json() as { lanes: Array<{ variantId: string | null; runId: string }> };
    expect(b.lanes.map((l) => l.variantId)).toEqual([null, 'my', 'sg']);   // ORDER BY variant_id: NULL first
    expect(b.lanes.find((l) => l.variantId === 'sg')!.runId).toBe('r-vg-sg');
    expect(b.lanes.find((l) => l.variantId === 'my')!.runId).toBe('r-vg-my');
  });

  it('?variant= scopes gallery to ONE lane ("" = variantless)', async () => {
    seedRunWithSteps('tp-vs', [{ idx: 0, name: 'expect A', status: 'pass', ev: 'ev-vs1' }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id, variant_id)
                VALUES ('r-vs-sg', 'T', 'manual', 'passed', 'qa', 's', 100, 200, 'n', 'tp-vs', 'sg')`).run();
    const only = await app.inject({ method: 'GET', url: '/api/templates/tp-vs/evidence?variant=sg' });
    expect(((only.json() as { lanes: Array<{ variantId: string | null }> }).lanes).map((l) => l.variantId)).toEqual(['sg']);
    const base = await app.inject({ method: 'GET', url: '/api/templates/tp-vs/evidence?variant=' });
    expect(((base.json() as { lanes: Array<{ variantId: string | null }> }).lanes).map((l) => l.variantId)).toEqual([null]);
    const missing = await app.inject({ method: 'GET', url: '/api/templates/tp-vs/evidence?variant=nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('resolver + run-taps honor ?variant= lanes (same run per lane)', async () => {
    seedRunWithSteps('tp-rv', [{ idx: 0, name: 'expect A', status: 'pass', ev: 'ev-rv1' }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id, variant_id, video_started_at)
                VALUES ('r-rv-sg', 'T', 'manual', 'passed', 'qa', 's', 100, 200, 'n', 'tp-rv', 'sg', 150)`).run();
    // my lane newer than sg lane overall — unscoped picks my; ?variant=sg must still pick sg
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, note, template_id, variant_id, video_started_at)
                VALUES ('r-rv-my', 'T', 'manual', 'passed', 'qa', 's', 300, 400, 'n', 'tp-rv', 'my', 350)`).run();
    db.prepare(`INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, started_at, duration_ms, evidence_ids_json)
                VALUES ('r-rv-sg', 0, 't', 'expect', 'expect A', 'pass', 0, 0, '["ev-rv1"]')`).run();
    const unscoped = await app.inject({ method: 'GET', url: '/api/templates/tp-rv/evidence/screenshot' });
    expect(unscoped.statusCode).toBe(404);   // legacy unscoped = latest overall (my) — that lane has no shots
    const sg = await app.inject({ method: 'GET', url: '/api/templates/tp-rv/evidence/screenshot?variant=sg' });
    expect(sg.headers['location']).toBe('/api/evidence/ev-rv1/file');
    const tapsSg = await app.inject({ method: 'GET', url: '/api/templates/tp-rv/run-taps?variant=sg' });
    expect((tapsSg.json() as { runId: string }).runId).toBe('r-rv-sg');
    const tapsMy = await app.inject({ method: 'GET', url: '/api/templates/tp-rv/run-taps?variant=my' });
    expect((tapsMy.json() as { runId: string }).runId).toBe('r-rv-my');
  });
});
