import type Database from 'better-sqlite3';
/** ensure state grammar (phase A S1, plan 20261017T112229Z): parse, errors,
 *  round-trip, completions vocabulary, slot classification, substitution
 *  carry-through, and the fail-loud engine stub (S3 replaces the stub with
 *  the convergence executor). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCaseYaml, caseToYaml } from '../../shared/src/case-yaml.ts';
import { buildCompletions } from '../../shared/src/yaml-completions.ts';
import { slotAt } from '../../shared/src/yaml-slots.ts';
import { substituteStep } from '../src/manual/template-env.ts';

const P = (steps: string) => `name: t\nsteps:\n${steps}`;

describe('ensure state — parse', () => {
  it('parses the scalar state id in setup AND mid-steps (decision Q2)', () => {
    const setup = parseCaseYaml(`name: t\napp: com.example.app\nsetup:\n  - ensure state: fresh_install\nsteps:\n  - expect: home_indicator`);
    expect(setup.errors).toHaveLength(0);
    expect(setup.case?.setup?.[0]).toMatchObject({ action: 'ensureState', ensureState: 'fresh_install' });

    const mid = parseCaseYaml(P('  - ensure state: on_home\n'));
    expect(mid.errors).toHaveLength(0);
    expect(mid.case?.steps[0]).toMatchObject({ action: 'ensureState', ensureState: 'on_home' });
  });

  it.each([
    ['uppercase', '  - ensure state: FreshInstall\n'],
    ['spaces', '  - ensure state: "two words"\n'],
    ['empty body', '  - ensure state:\n'],
    ['mapping body', '  - ensure state: { state: fresh_install }\n'],
    ['leading digit', '  - ensure state: 1st_state\n'],
  ])('rejects %s with the state-id shape error', (_n, y) => {
    const r = parseCaseYaml(P(y));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.message).toMatch(/ensure state takes a state id/);
  });

  it('error names the app states page (authoring surface)', () => {
    const r = parseCaseYaml(P('  - ensure state: NOPE\n'));
    expect(r.errors[0]?.message).toMatch(/registered on the app states page/);
  });
});

describe('ensure state — round-trip', () => {
  it('parse → emit → parse preserves the state id and narrate', () => {
    const src = P('  - ensure state: fresh_install\n') + '    narrate: Given a fresh install\n';
    const r = parseCaseYaml(src);
    expect(r.errors).toHaveLength(0);
    const out = caseToYaml(r.case!);
    expect(out).toContain('- ensure state: fresh_install');
    expect(out).toContain('narrate: Given a fresh install');
    const back = parseCaseYaml(out);
    expect(back.errors).toHaveLength(0);
    expect(back.case?.steps[0]).toMatchObject({ action: 'ensureState', ensureState: 'fresh_install', narrate: 'Given a fresh install' });
  });

  it('emits the scalar spelling for stored steps (no yaml form regression)', () => {
    const out = caseToYaml({ name: 't', tags: [], steps: [{ action: 'ensureState', ensureState: 'logged_in', idx: 0 }] });
    expect(out).toContain('- ensure state: logged_in');
  });
});

describe('ensure state — completions + slots', () => {
  it('step-action skeleton offers ensure state', () => {
    const cs = buildCompletions('step-action', { selectors: [], caseNames: [], apps: [], tags: [] }, '');
    const hit = cs.find((c) => c.label === 'ensure state');
    expect(hit).toMatchObject({ apply: 'ensure state: ', type: 'keyword' });
  });

  it('state-id slot completes from the appStates vocabulary, degrades to [] when absent', () => {
    const vocab = { selectors: [], caseNames: [], apps: [], tags: [], appStates: [{ state: 'fresh_install', bundle: 'com.x' }] };
    expect(buildCompletions('state-id', vocab, '')).toEqual([
      { label: 'fresh_install', detail: 'app state · com.x', apply: 'fresh_install', type: 'text' },
    ]);
    expect(buildCompletions('state-id', { selectors: [], caseNames: [], apps: [], tags: [] }, '')).toEqual([]);
  });

  it('slotAt classifies the value position after "ensure state: " and the partial two-word action', () => {
    const doc = 'name: t\nsteps:\n  - ensure state: fre';
    expect(slotAt(doc, doc.length)).toBe('state-id');
    expect(slotAt('name: t\nsteps:\n  - ensure sta', 25)).toBe('step-action');
  });
});

describe('ensure state — substitution carry-through (lesson c)', () => {
  it('substituteStep carries the field verbatim (no env refs in state ids)', () => {
    const out = substituteStep({ idx: 0, action: 'ensureState', ensureState: 'fresh_install' }, {});
    expect(out).toMatchObject({ action: 'ensureState', ensureState: 'fresh_install' });
    expect(out.error).toBeUndefined();
  });
});

/** Engine stub (S1 ships ahead of the S3 executor): a declared precondition
 *  must FAIL LOUD with STATE_ENGINE_PENDING — never silently pass, never
 *  hang the run. Mirrors the playback-location harness shape. */
describe('ensure state — playback stub fails loud until S3', () => {
  let db: Database.Database;
  let tmp: string;
  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const DatabaseMod = (await import('better-sqlite3')).default;
    const { migrateM1 } = await import('../src/db/schema.ts');
    const { __setAlloyForTest } = await import('../src/alloy/client.ts');
    tmp = mkdtempSync(join(tmpdir(), 'es-'));
    db = new DatabaseMod(':memory:');
    migrateM1(db);
    __setAlloyForTest({
      dispatch: async (tool: string) => {
        if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
          { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
          { index: 1, parentIndex: 0, type: 'StaticText', label: 'Home', rect: { x: 0, y: 0, width: 10, height: 10 }, hittable: true, ref: 'n1' },
        ] } };
        return { ok: true, result: {} };
      },
    } as never);
  });
  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    const { __setAlloyForTest } = await import('../src/alloy/client.ts');
    __setAlloyForTest(null);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a mid-steps ensure state fails the run with STATE_ENGINE_PENDING and skips the rest', async () => {
    const { runTemplatePlayback } = await import('../src/manual/playback.ts');
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
                VALUES ('tpl_es1', 'tpl_es1', 'sim', ?, NULL, 'qa', 0, 0)`)
      .run(JSON.stringify([
        { idx: 0, action: 'ensureState', ensureState: 'fresh_install' },
        { idx: 1, action: 'expect', selector: { label: 'Never Reached' } },
      ]));
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim', 'Sim', 'Booted', 'ios', 'simulator', 0)
                ON CONFLICT(udid) DO UPDATE SET state = 'Booted'`).run();
    const bus = { emit: () => undefined } as never;
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: null } as never, 'tpl_es1', {});
    await r.done;
    const steps = db.prepare('SELECT idx, name, status, reason FROM run_steps WHERE run_id = ? ORDER BY idx').all(r.runId) as Array<{ idx: number; name: string; status: string; reason: string | null }>;
    expect(steps[0]).toMatchObject({ name: 'ensure state fresh_install', status: 'fail' });
    expect(steps[0]?.reason).toMatch(/STATE_ENGINE_PENDING.*fresh_install/);
    expect(steps[1]).toMatchObject({ status: 'skip', reason: 'not reached' });
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
    expect(run.status).toBe('failed');
  });
});
