import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { forgeStateService } from '../src/forge/state.ts';
import { migrateM1 } from '../src/db/schema.ts';

/** B4b: ONE owner for the addon state file. Kills the clobber flaw: preset
 *  CRUD during a scenario-backed run rewrote the file from DB presets,
 *  silently dropping the scenario override (and vice versa). Every write
 *  now COMPOSES: mode + (override ?? DB presets) + activeRunId, serialized
 *  through a single promise chain.
 *
 *  M3 (2026-09-02): activateScenario now takes DB ROWS (mapped through
 *  presetRowToSpec inside) and updates BOTH proxy consumers — the addon
 *  state file AND the in-process serving set (deps.forgeState.presets).
 *  The self-review catch: compose() wrote the file only; the in-process
 *  proxy served DB presets during scenario runs. */

let dir: string;
let db: Database.Database;
let forgeState: { mode: string; presets: unknown[]; activeRunId: string | null };

const deps = () => ({ db, forgeState });

const insertPreset = (id: string, pathPattern: string, status = 200, extra = ''): void => {
  db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status${extra ? `, ${extra}` : ''}, created_by, created_at, sha256) VALUES ('${id}', 'GET', '${pathPattern}', 'exact', ${status}${extra ? ", ''" : ''}, 't', 0, 'x')`).run();
};
const scenarioPresetRow = (id: string, pathPattern: string, status = 200): Record<string, unknown> => ({
  id, method: 'GET', path_pattern: pathPattern, match: 'exact', status, created_by: 't', created_at: 0, sha256: 'x',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b4b-'));
  process.env['CRUCIBLE_MITM_STATE_DIR'] = dir;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // FK cascade truth (openDb does this in prod)
  migrateM1(db);
  forgeState = { mode: 'hybrid', presets: [], activeRunId: null };
});
afterEach(() => {
  delete process.env['CRUCIBLE_MITM_STATE_DIR'];
  delete process.env['CRUCIBLE_MITM_BODIES_DIR'];
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

function readState(): { mode: string; presets: Array<{ id: string }>; activeRunId: string | null } {
  return JSON.parse(readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8')) as { mode: string; presets: Array<{ id: string }>; activeRunId: string | null };
}

describe('forgeStateService (B4b single owner)', () => {
  it('setActiveRun during an active scenario override composes BOTH (the clobber case)', async () => {
    insertPreset('db_p', '/db');
    const svc = forgeStateService(deps());
    svc.activateScenario([scenarioPresetRow('ovr_p', '/ovr', 500)]);
    svc.setActiveRun('run_1');
    await svc.drain();
    const st = readState();
    expect(st.presets.map((p) => p.id)).toEqual(['ovr_p']); // override survives
    expect(st.activeRunId).toBe('run_1');                    // attribution survives
  });

  it('sync() during an active override keeps the override (preset CRUD no longer clobbers)', async () => {
    const svc = forgeStateService(deps());
    svc.activateScenario([scenarioPresetRow('ovr_p', '/ovr', 500)]);
    insertPreset('new_p', '/new');
    svc.sync();
    await svc.drain();
    expect(readState().presets.map((p) => p.id)).toEqual(['ovr_p']);
  });

  it('clearScenario returns to DB presets, keeping the active run', async () => {
    insertPreset('db_p', '/db');
    const svc = forgeStateService(deps());
    svc.activateScenario([scenarioPresetRow('ovr_p', '/ovr', 500)]);
    svc.setActiveRun('run_2');
    svc.clearScenario();
    await svc.drain();
    const st = readState();
    expect(st.presets.map((p) => p.id)).toEqual(['db_p']);
    expect(st.activeRunId).toBe('run_2');
  });

  it('concurrent operations serialize — final state is valid and last-wins', async () => {
    insertPreset('db_p', '/db');
    const svc = forgeStateService(deps());
    await Promise.all([
      Promise.resolve(svc.sync()),
      Promise.resolve(svc.setActiveRun('run_a')),
      Promise.resolve(svc.activateScenario([scenarioPresetRow('ovr_p', '/ovr', 500)])),
      Promise.resolve(svc.setActiveRun('run_b')),
    ]);
    await svc.drain();
    const st = readState(); // parses = not torn; compose = coherent
    expect(st.activeRunId).toBe('run_b');
    expect(st.presets.map((p) => p.id)).toEqual(['ovr_p']);
  });

  it('legacy shape: no override, no run → DB presets + activeRunId null', async () => {
    insertPreset('db_p', '/db');
    const svc0 = forgeStateService(deps());
    svc0.sync();
    await svc0.drain();
    const st = readState();
    expect(st.presets.map((p) => p.id)).toEqual(['db_p']);
    expect(st.activeRunId).toBeNull();
  });
});

describe('M3: activateScenario(rows) updates BOTH proxy consumers', () => {
  it('scenario activation updates the state FILE and the in-process serving set (self-review catch)', async () => {
    insertPreset('db_p', '/db');
    const svc = forgeStateService(deps());
    svc.activateScenario([scenarioPresetRow('ovr_p', '/ovr', 500)]);
    await svc.drain();
    expect(readState().presets.map((p) => p.id)).toEqual(['ovr_p']);   // file consumer
    expect((forgeState.presets as Array<{ id: string }>).map((p) => p.id)).toEqual(['ovr_p']); // in-process consumer — the M3 fix
  });

  it('rows map through presetRowToSpec — row columns become wire fields (throttle survives)', async () => {
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, throttle_kbps, delay_ms, created_by, created_at, sha256) VALUES ('thr_p', 'GET', '/thr', 'exact', 200, 256, 500, 't', 0, 'x')`).run();
    const svc = forgeStateService(deps());
    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get('thr_p') as Record<string, unknown>;
    svc.activateScenario([row]);
    await svc.drain();
    const st = readState();
    const spec = st.presets[0] as { id: string; throttleKbps?: number; delayMs?: number; pathPattern: string };
    expect(spec.id).toBe('thr_p');
    expect(spec.pathPattern).toBe('/thr'); // snake_case row → camelCase wire
    expect(spec.throttleKbps).toBe(256);   // B8: throttle survives
    expect(spec.delayMs).toBe(500);
  });

  it('clearScenario resets the in-process serving set to DB presets (no ghosts)', async () => {
    insertPreset('db_p', '/db');
    const svc = forgeStateService(deps());
    svc.activateScenario([scenarioPresetRow('ovr_p', '/ovr', 500)]);
    svc.clearScenario();
    await svc.drain();
    expect((forgeState.presets as Array<{ id: string }>).map((p) => p.id)).toEqual(['db_p']);
    expect(readState().presets.map((p) => p.id)).toEqual(['db_p']);
  });
});

describe('preset bodies migration (B6)', () => {
  it('moves old /tmp bodies to the data dir and rewrites presets.body_path', () => {
    const { mkdirSync, writeFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    // old location (what macOS purges)
    const oldDir = join(dir, 'preset-bodies'); // legacy location = stateDir/preset-bodies (the /tmp default in prod)
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'p_old.body'), 'FROZEN-CONTENT');
    // a presets row pointing at the old absolute path
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, body_path, created_by, created_at, sha256) VALUES ('p_old', 'GET', '/frozen', 'exact', 200, ?, 't', 0, 'x')`)
      .run(join(oldDir, 'p_old.body'));

    process.env['CRUCIBLE_MITM_BODIES_DIR'] = join(dir, 'data-bodies');
    const svc = forgeStateService({ db, forgeState: { mode: 'hybrid', presets: [], activeRunId: null } });
    const newDir = svc.bodiesDir;
    expect(newDir).toBe(join(dir, 'data-bodies'));       // env-resolved — prod derives from CRUCIBLE_DB_PATH
    expect(existsSync(join(newDir, 'p_old.body'))).toBe(true);
    const row = db.prepare('SELECT body_path FROM presets WHERE id = ?').get('p_old') as { body_path: string };
    expect(row.body_path).toBe(join(newDir, 'p_old.body'));
    expect(existsSync(join(oldDir, 'p_old.body'))).toBe(true); // non-destructive: copy, never delete
  });
});
