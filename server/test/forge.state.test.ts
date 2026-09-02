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
 *  through a single promise chain. */

let dir: string;
let db: Database.Database;

const deps = () => ({
  db,
  forgeState: { mode: 'hybrid', presets: [], activeRunId: null } as { mode: string; presets: unknown[]; activeRunId: string | null },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b4b-'));
  process.env['CRUCIBLE_MITM_STATE_DIR'] = dir;
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => {
  delete process.env['CRUCIBLE_MITM_STATE_DIR'];
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

function readState(): { mode: string; presets: Array<{ id: string }>; activeRunId: string | null } {
  return JSON.parse(readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8')) as { mode: string; presets: Array<{ id: string }>; activeRunId: string | null };
}

describe('forgeStateService (B4b single owner)', () => {
  it('setActiveRun during an active scenario override composes BOTH (the clobber case)', async () => {
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('db_p', 'GET', '/db', 'exact', 200, 't', 0, 'x')`).run();
    const svc = forgeStateService(deps());
    svc.activateScenario([{ id: 'ovr_p', method: 'GET', pathPattern: '/ovr', match: 'exact', status: 500 }]);
    svc.setActiveRun('run_1');
    await svc.drain();
    const st = readState();
    expect(st.presets.map((p) => p.id)).toEqual(['ovr_p']); // override survives
    expect(st.activeRunId).toBe('run_1');                    // attribution survives
  });

  it('sync() during an active override keeps the override (preset CRUD no longer clobbers)', async () => {
    const svc = forgeStateService(deps());
    svc.activateScenario([{ id: 'ovr_p', method: 'GET', pathPattern: '/ovr', match: 'exact', status: 500 }]);
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('new_p', 'GET', '/new', 'exact', 200, 't', 0, 'x')`).run();
    svc.sync();
    await svc.drain();
    expect(readState().presets.map((p) => p.id)).toEqual(['ovr_p']);
  });

  it('clearScenario returns to DB presets, keeping the active run', async () => {
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('db_p', 'GET', '/db', 'exact', 200, 't', 0, 'x')`).run();
    const svc = forgeStateService(deps());
    svc.activateScenario([{ id: 'ovr_p', method: 'GET', pathPattern: '/ovr', match: 'exact', status: 500 }]);
    svc.setActiveRun('run_2');
    svc.clearScenario();
    await svc.drain();
    const st = readState();
    expect(st.presets.map((p) => p.id)).toEqual(['db_p']);
    expect(st.activeRunId).toBe('run_2');
  });

  it('concurrent operations serialize — final state is valid and last-wins', async () => {
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('db_p', 'GET', '/db', 'exact', 200, 't', 0, 'x')`).run();
    const svc = forgeStateService(deps());
    await Promise.all([
      Promise.resolve(svc.sync()),
      Promise.resolve(svc.setActiveRun('run_a')),
      Promise.resolve(svc.activateScenario([{ id: 'ovr_p', method: 'GET', pathPattern: '/ovr', match: 'exact', status: 500 }])),
      Promise.resolve(svc.setActiveRun('run_b')),
    ]);
    await svc.drain();
    const st = readState(); // parses = not torn; compose = coherent
    expect(st.activeRunId).toBe('run_b');
    expect(st.presets.map((p) => p.id)).toEqual(['ovr_p']);
  });

  it('legacy shape: no override, no run → DB presets + activeRunId null', async () => {
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('db_p', 'GET', '/db', 'exact', 200, 't', 0, 'x')`).run();
    const svc0 = forgeStateService(deps());
    svc0.sync();
    await svc0.drain();
    const st = readState();
    expect(st.presets.map((p) => p.id)).toEqual(['db_p']);
    expect(st.activeRunId).toBeNull();
  });
});
