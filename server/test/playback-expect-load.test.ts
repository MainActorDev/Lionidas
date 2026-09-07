import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import { migrateM1 } from '../src/db/schema.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import type { SnapNode } from '../src/manual/selector.ts';

let db: Database.Database;
let tmp: string;
let snapCalls: number;
let populateAtCall: number; // alloy_snapshot call index that first serves the target label
let mutating: boolean; // earlier reads serve a different label each time (page loading)

const nodes = (labels: string[]): SnapNode[] =>
  [{ // app root — settle gate needs root + ≥1 node
    index: 0, parentIndex: -1, type: 'Application', label: 'App',
    rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false, ref: 'root',
  }, ...labels.map((label, i) => ({
    index: i + 1, parentIndex: 0, type: 'StaticText', label,
    rect: { x: 0, y: i * 10, width: 100, height: 10 }, hittable: true, ref: `n${i + 1}`,
  }))];

const TARGET = 'III. ACCOUNT REGISTRATION';

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') {
        snapCalls += 1;
        if (snapCalls >= populateAtCall) return { ok: true, result: { nodes: nodes([TARGET]), root: { rect: { width: 428, height: 926 } } } };
        // pre-population: a MUTATING tree — different placeholder each read,
        // like a remote webview still streaming its content in
        const label = mutating ? `loading ${snapCalls}` : 'shell';
        return { ok: true, result: { nodes: nodes([label]), root: { rect: { width: 428, height: 926 } } } };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seedTemplate(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, NULL, 428, 926, '[]', 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<{ runId: string }> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined } as never, id, {});
  await r.done;
  return { runId: r.runId };
}

function stepRow(runId: string): { status: string; reason: string | null; evaluated_json: string | null } {
  return db.prepare('SELECT status, reason, evaluated_json FROM run_steps WHERE run_id = ? AND idx = 0').get(runId) as never;
}

describe('expect settle — late webview content', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'exp-load-'));
    db = new Database(join(tmp, 'c.db'));
    db.exec('PRAGMA journal_mode = WAL;');
    migrateM1(db);
    process.env.CRUCIBLE_EXPECT_SETTLE_MS = '20';  // base budget: tiny
    process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
    process.env.CRUCIBLE_EXPECT_MAX_MS = '2000';   // mutation ceiling for the test
    snapCalls = 0;
    mutating = true;
    __setAlloyForTest(fakeAlloy());
  });

  afterEach(() => {
    __setAlloyForTest(null);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.CRUCIBLE_EXPECT_SETTLE_MS;
    delete process.env.CRUCIBLE_EXPECT_POLL_MS;
    delete process.env.CRUCIBLE_EXPECT_MAX_MS;
  });

  it('label arriving AFTER the base budget still passes while the tree keeps mutating (remote webview)', async () => {
    populateAtCall = 8; // arrives well past the 20ms base budget; each prior read mutates
    seedTemplate('late', [{ idx: 0, action: 'expect', selector: { label: TARGET } }]);
    const { runId } = await play('late');
    const row = stepRow(runId);
    expect(row.status).toBe('pass');
    expect(JSON.parse(row.evaluated_json!).matched).toBe(1);
  });

  it('NEGATIVE: quiet tree, label never arrives → fails at the base budget, no ceiling hang', async () => {
    mutating = false; // static 'shell' tree — no mutation, no match
    populateAtCall = Number.MAX_SAFE_INTEGER;
    seedTemplate('absent', [{ idx: 0, action: 'expect', selector: { label: TARGET } }]);
    const t0 = Date.now();
    const { runId } = await play('absent');
    const wall = Date.now() - t0;
    const row = stepRow(runId);
    expect(row.status).toBe('fail');
    expect(row.reason).toContain('not found');
    // fast negative: the 2s mutation ceiling must NOT be consumed (startup
    // overhead alone runs ~700ms, so bound at 1200 — a ceiling hang would be ≥2s)
    expect(wall).toBeLessThan(1200);
  });
});
