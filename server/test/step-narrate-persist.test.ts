import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

/** Stage 2 (plan 20260929T030722Z): narrate persists on run_steps and rides
 *  step.started. Harness mirrors network-conditioner-playback.test.ts. */

let db: Database.Database;
let tmp: string;
const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
        { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
        { index: 1, parentIndex: 0, type: 'Button', label: 'Continue', rect: { x: 100, y: 200, width: 60, height: 30 }, hittable: true, ref: 'n1' },
      ] } };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); } } as never;

function seed(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, steps_json, tags_json, udid, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, ?, '[]', '', NULL, 'qa', 1, 1)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [] } as never, id, {});
  await r.done;
  return r.runId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'narrate-'));
  db = new Database(':memory:');
  migrateM1(db);
  events.length = 0;
  __setAlloyForTest(fakeAlloy());
  process.env.CRUCIBLE_SETTLE_MS = '10';
});

describe('narrate persistence + events', () => {
  it('narrated steps persist narrate per idx and step.started carries it', async () => {
    seed('tpl_n', [
      { idx: 0, action: 'tap', x: 130, y: 215, narrate: 'When I open the account tab' },
      { idx: 1, action: 'expect', selector: { label: 'Continue' }, narrate: 'Then Continue is visible' },
    ]);
    const runId = await play('tpl_n');
    const rows = db.prepare('SELECT idx, narrate FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as Array<{ idx: number; narrate: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.find(r => r.idx === 0)?.narrate).toBe('When I open the account tab');
    expect(rows.find(r => r.idx === 1)?.narrate).toBe('Then Continue is visible');
    const started = events.filter(e => e.type === 'step.started');
    expect(started.some(e => e.payload['narrate'] === 'When I open the account tab')).toBe(true);
  });

  it('narrate-free case → NULL narrate everywhere, statuses unchanged', async () => {
    seed('tpl_plain', [
      { idx: 0, action: 'tap', x: 130, y: 215 },
      { idx: 1, action: 'expect', selector: { label: 'Continue' } },
    ]);
    const runId = await play('tpl_plain');
    const rows = db.prepare('SELECT narrate FROM run_steps WHERE run_id = ?').all(runId) as Array<{ narrate: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every(r => r.narrate === null)).toBe(true);
    const status = (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status;
    expect(status).toBe('passed');
  });
});

import { afterEach } from 'vitest';
afterEach(() => {
  __setAlloyForTest(null);
  delete process.env.CRUCIBLE_SETTLE_MS;
  rmSync(tmp, { recursive: true, force: true });
});
