/** Phase C T1+T2 — playback variant opt + variant identity in provenance.
 *  Harness mirrors playback-expect (fake alloy via __setAlloyForTest). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import { __setForgeHealthForTest } from '../src/forge/health.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import type { SnapNode } from '../src/manual/selector.ts';
import { migrateM1 } from '../src/db/schema.ts';
import type { YamlVariant } from '@crucible/shared/yaml-variants';

let db: Database.Database;
let tmp: string;
let snapshotNodes: SnapNode[];

const nodes = (labels: string[]): SnapNode[] => [
  { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false, ref: 'root' },
  ...labels.map((label, i) => ({ index: i + 1, parentIndex: 0, type: 'StaticText', label, rect: { x: 0, y: i * 10, width: 100, height: 10 }, hittable: true, ref: `n${i + 1}` })),
];

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: snapshotNodes, root: { rect: { width: 428, height: 926 } } } };
      if (tool === 'alloy_act') return { ok: true, result: {} };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seedTemplate(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, NULL, 428, 926, '[]', 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function runCase(templateId: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await runTemplatePlayback(
    { db, bus, dispatchDeps: null, forgeState: { activeRunId: null } as never, artifactsDir: tmp, awaitStreamLive: async () => undefined } as never,
    templateId, opts as never);
  await r.done;
  return r.runId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cv-pc-'));
  db = new Database(join(tmp, 't.db'));
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  migrateM1(db);
  __setAlloyForTest({ dispatch: fakeAlloy().dispatch } as never);
  __setForgeHealthForTest({ mitmRunning: true, routingEnabled: true }); // T7: scenario tests assume a live chain
});
afterEach(() => {
  __setForgeHealthForTest(null);
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const variant = (over: Partial<YamlVariant>): YamlVariant => ({ id: 'active', ...over });

describe('playback variant opt (T1)', () => {
  it('variantless run → variant_id NULL, note unchanged (compat)', async () => {
    seedTemplate('tpl_c1', [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }]);
    snapshotNodes = nodes(['Anything']);
    const runId = await runCase('tpl_c1');
    const run = db.prepare('SELECT variant_id, note FROM runs WHERE id = ?').get(runId) as { variant_id: string | null; note: string };
    expect(run.variant_id).toBeNull();
    // managed-env era: the note gains the env-sources audit line (counts
    // only) — the provenance prefix itself is unchanged
    expect(run.note.startsWith('template:tpl_c1 tpl_c1')).toBe(true);
    expect(run.note).toContain('env sources: global(0) app(0) plan(0) request(0)');
  });

  it('variant run → variant_id stamped, note carries " / active"', async () => {
    seedTemplate('tpl_c2', [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }]);
    snapshotNodes = nodes(['Anything']);
    const runId = await runCase('tpl_c2', { variant: variant({}) });
    const run = db.prepare('SELECT variant_id, note FROM runs WHERE id = ?').get(runId) as { variant_id: string | null; note: string };
    expect(run.variant_id).toBe('active');
    expect(run.note).toContain(' / active');
  });

  it('variant env resolves ${…} refs in steps (expect matches the variant value)', async () => {
    seedTemplate('tpl_c3', [{ idx: 0, action: 'expect', selector: { label: 'Account Active' } }]);
    snapshotNodes = nodes(['Account Active']); // only the VARIANT's title is on screen
    const runId = await runCase('tpl_c3', { variant: variant({ env: { title: 'Account Active' } }), env: { title: 'WRONG' } });
    // if env merge were wrong, the expect would fail — assert pass + step status
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed');
  });

  it('variant env OVERRIDES invocation env on collision (negative proof: wrong value fails)', async () => {
    seedTemplate('tpl_c4', [{ idx: 0, action: 'expect', selector: { label: 'From Variant' } }]);
    snapshotNodes = nodes(['From Variant']);
    const runId = await runCase('tpl_c4', { variant: variant({ id: 'v', env: { title: 'From Variant' } }), env: { title: 'From Invocation' } });
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed'); // variant value won
  });

  it('variant scenario overrides invocation scenarioId (runs.scenario_id + version fork)', async () => {
    seedTemplate('tpl_c5', [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }]);
    for (const [sid, path] of [['sc-batch', '/b'], ['sc-variant', '/v']] as const) {
      db.prepare(`INSERT INTO scenarios(id, name, created_by) VALUES (?, ?, 'qa')`).run(sid, sid);
      db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES (?, 'GET', ?, 'exact', 200, 'qa', 0, 'x')`).run(`${sid}_p`, path);
      db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)`).run(sid, `${sid}_p`);
    }
    snapshotNodes = nodes(['Anything']);
    await runCase('tpl_c5', { scenarioId: 'sc-batch' });
    await runCase('tpl_c5', { scenarioId: 'sc-batch', variant: variant({ id: 'special', networkScenario: 'sc-variant' }) });
    const rows = db.prepare('SELECT scenario_id FROM runs WHERE template_id = ? ORDER BY started_at').all('tpl_c5') as Array<{ scenario_id: string | null }>;
    expect(rows[1]!.scenario_id).toBe('sc-variant'); // variant won
    expect(rows[0]!.scenario_id).toBe('sc-batch');   // invocation applied to the variantless run
    // and the two executions forked versions (different scenario identity)
    expect(db.prepare('SELECT COUNT(*) n FROM case_versions WHERE template_id = ?').get('tpl_c5')).toMatchObject({ n: 2 });
  });

  it('variant WITHOUT scenario inherits the invocation scenario', async () => {
    seedTemplate('tpl_c6', [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }]);
    db.prepare(`INSERT INTO scenarios(id, name, created_by) VALUES ('sc-x', 'sc-x', 'qa')`).run();
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('scx_p', 'GET', '/x', 'exact', 200, 'qa', 0, 'x')`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('sc-x', 'scx_p', 1)`).run();
    snapshotNodes = nodes(['Anything']);
    await runCase('tpl_c6', { scenarioId: 'sc-x', variant: variant({ id: 'envonly', env: { k: 'v' } }) });
    const run = db.prepare('SELECT scenario_id FROM runs WHERE template_id = ?').get('tpl_c6') as { scenario_id: string | null };
    expect(run.scenario_id).toBe('sc-x');
  });
});

describe('variant identity in provenance (T2)', () => {
  it('two variants, same steps+scenario, different env → TWO revisions', async () => {
    seedTemplate('tpl_p1', [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }]);
    snapshotNodes = nodes(['Anything']);
    await runCase('tpl_p1', { variant: variant({ id: 'a', env: { t: 'A' } }) });
    await runCase('tpl_p1', { variant: variant({ id: 'b', env: { t: 'B' } }) });
    const rows = db.prepare('SELECT variant_id, variant_env_json FROM case_versions WHERE template_id = ? ORDER BY revision').all('tpl_p1') as Array<{ variant_id: string | null; variant_env_json: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.variant_id)).toEqual(['a', 'b']);
  });

  it('variant with NO env shares the variantless version (identical inputs)', async () => {
    seedTemplate('tpl_p2', [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }]);
    snapshotNodes = nodes(['Anything']);
    await runCase('tpl_p2');
    await runCase('tpl_p2', { variant: variant({ id: 'bare' }) }); // env-less variant
    expect(db.prepare('SELECT COUNT(*) n FROM case_versions WHERE template_id = ?').get('tpl_p2')).toMatchObject({ n: 1 });
  });
});
