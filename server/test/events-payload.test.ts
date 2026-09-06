/** Task 0 (run-menu/abort plan): event payloads carry what live trackers
 *  need — run.started gains templateId; a template-run abort emits
 *  run.aborted (previously only queue-dispatcher aborts did). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback, abortRun } from '../src/manual/playback.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

let db: Database.Database;
let tmp: string;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
        { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 100, height: 100 }, hittable: false, ref: 'root' },
        { index: 1, parentIndex: 0, type: 'Button', label: 'Go', rect: { x: 10, y: 10, width: 20, height: 20 }, hittable: true, ref: 'n1' },
      ] } };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

type Emit = { type: string; payload: Record<string, unknown> };
const emitted: Emit[] = [];
const bus = { emit: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, payload }); } } as never;

function seed(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, NULL, 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [] } as never, id, {});
  await r.done;
  return r.runId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 't0-evt-'));
  db = new Database(':memory:');
  migrateM1(db); // canonical schema — hand-typed DDL drifts (hit twice before)
  process.env.CRUCIBLE_SETTLE_MS = '10';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = '4000';
  __setAlloyForTest(fakeAlloy());
  emitted.length = 0;
});
afterEach(() => {
  delete process.env.CRUCIBLE_SETTLE_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('run event payloads (Task 0)', () => {
  it('run.started carries templateId', async () => {
    seed('tpl_evt1', [{ idx: 0, action: 'tap', x: 1, y: 1 }]);
    await play('tpl_evt1');
    const started = emitted.find((e) => e.type === 'run.started');
    expect(started).toBeTruthy();
    expect(started?.payload['templateId']).toBe('tpl_evt1');
  });

  it('abortRun emits run.aborted with runId + templateId', async () => {
    seed('tpl_evt2', [{ idx: 0, action: 'tap', x: 1, y: 1 }]);
    const runId = await play('tpl_evt2');
    emitted.length = 0;
    const res = abortRun(db, runId);
    expect(res).toEqual({ already: 'finished' }); // terminal run: no emit
    expect(emitted.filter((e) => e.type === 'run.aborted')).toHaveLength(0);
  });

  it('abortRun on a RUNNING row flips the record and emits run.aborted', async () => {
    seed('tpl_evt3', [{ idx: 0, action: 'tap', x: 1, y: 1 }]);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, template_id)
                VALUES ('run_live', 'T', 'manual', 'running', 'qa', 'sim', 0, 'tpl_evt3')`).run();
    const res = abortRun(db, 'run_live', bus as never);
    expect(res).toEqual({ ok: true });
    const aborted = emitted.find((e) => e.type === 'run.aborted');
    expect(aborted).toBeTruthy();
    expect(aborted?.payload['runId']).toBe('run_live');
    expect(aborted?.payload['templateId']).toBe('tpl_evt3');
  });
});
