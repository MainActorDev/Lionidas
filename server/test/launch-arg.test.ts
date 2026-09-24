import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';

/** Launch-arg live-refresh (backlog #11, plan 20260924T174000Z): playback's
 *  app open MUST carry -uitest-live-refresh — the app's once-per-creation
 *  fetch guard bypasses for appear-refetch only under this arg, and world
 *  swaps depend on the refetch (guard 1 verifies the request each time).
 *  Same fake-alloy seam as the other playback tests (no capability gate
 *  needed — crucibleAlloy is stubbed via __setAlloyForTest). */

let db: Database.Database;
let tmp: string;
const opens: Array<Record<string, unknown>> = [];

function fakeAlloy(): AlloyExports {
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string, rawIn: unknown) => {
      if (tool === 'alloy_apps' && (rawIn as { action?: string }).action === 'open') {
        opens.push(rawIn as Record<string, unknown>);
        return { ok: true, result: {} };
      }
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [{ index: 0, parentIndex: -1, type: 'StaticText', label: 'OK', rect: { x: 0, y: 0, width: 100, height: 20 }, hittable: true }], root: { rect: { width: 393, height: 852 } } } };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'larg-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  opens.length = 0;
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES ('t1', 'x', NULL, 'sim-1', ?, NULL, 393, 852, '[]', 'qa', 0, 0)`)
    .run(JSON.stringify([{ idx: 0, action: 'expect', selector: { label: 'OK' } }]));
});

afterEach(() => {
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('playback launch arg — -uitest-live-refresh', () => {
  it('the alloy_apps open carries the arg (world-swap seam)', async () => {
    __setAlloyForTest(fakeAlloy());
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 't1', {});
    await r.done;
    expect(opens.length).toBeGreaterThan(0);
    for (const o of opens) {
      expect((o['launchArgs'] as string[]) ?? []).toContain('-uitest-live-refresh');
    }
  }, 40_000); // playback settle ~20s — the vitest default 20s races it
});
