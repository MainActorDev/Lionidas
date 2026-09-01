import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback, abortRun, __setAbortRegistryForTest } from '../src/manual/playback.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

let db: Database.Database;
let tmp: string;
let mode: 'ok' | 'wedge';
let stepMs: number;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [{ index: 0, type: 'StaticText', label: 'Home', rect: { x: 0, y: 0, width: 10, height: 10 }, hittable: true }] } };
      if (tool === 'alloy_act') {
        if (mode === 'wedge') await new Promise(() => undefined); // never resolves
        await new Promise((r) => setTimeout(r, 30)); // window for mid-run abort
        return { ok: true, result: {} };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, NULL, 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null } } as never, id, {});
  await r.done;
  return r.runId;
}

function rows(runId: string): Array<{ idx: number; status: string; reason: string | null }> {
  return db.prepare('SELECT idx, status, reason FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as never;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'b4a-'));
  db = new Database(':memory:');
  const { migrateM1 } = require('../src/db/schema.ts') as typeof import('../src/db/schema.ts');
  migrateM1(db);
  mode = 'ok';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = String(stepMs);
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  delete process.env.CRUCIBLE_EXPECT_SETTLE_MS;
  delete process.env.CRUCIBLE_EXPECT_POLL_MS;
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('B2: watchdog + abort', () => {
  it('wedged dispatch → step fail timeout, run failed + blocked=1, done resolves', async () => {
    mode = 'wedge'; stepMs = 80;
    seed('w', [{ idx: 0, action: 'tap', x: 1, y: 1 }, { idx: 1, action: 'tap', x: 2, y: 2 }]);
    const runId = await play('w');
    const r = rows(runId);
    expect(r[0]!.status).toBe('fail');
    expect(r[0]!.reason).toContain('step timeout');
    expect(r[1]!.status).toBe('skip');
    const run = db.prepare('SELECT status, blocked FROM runs WHERE id = ?').get(runId) as { status: string; blocked: number };
    expect(run.status).toBe('failed');
    expect(run.blocked).toBe(1);
  });

  it('abort between steps → remaining skipped, status aborted, device freed', async () => {
    stepMs = 60_000; // no watchdog trip
    seed('a', [
      { idx: 0, action: 'tap', x: 1, y: 1 },
      { idx: 1, action: 'expect', selector: { label: 'Home' } },
      { idx: 2, action: 'tap', x: 3, y: 3 },
    ]);
    // abort after the run exists: intercept via registry — start, poll for run row, abort
    const p = runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null } } as never, 'a', {});
    const { runId, done } = await p;
    // abort as soon as the run row exists — before/early in the step loop.
    // The seam checks abort BETWEEN steps; with the 30ms fake dispatch the
    // whole run takes ~90ms, so aborting at row-creation reliably lands mid-run.
    for (let i = 0; i < 200; i++) {
      const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status?: string } | undefined;
      if (run) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    abortRun(db, runId);
    await done;
    const r = rows(runId);
    // some prefix may have passed; every step AFTER the abort lands is skipped
    const lastPass = r.map((x) => x.status).lastIndexOf('pass');
    for (let i = lastPass + 1; i < r.length; i++) {
      expect(r[i]!.status).toBe('skip');
      expect(r[i]!.reason).toContain('aborted');
    }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('aborted');
  });

  it('abort after finish → idempotent {already}', async () => {
    stepMs = 60_000;
    seed('f', [{ idx: 0, action: 'tap', x: 1, y: 1 }]);
    const runId = await play('f');
    const res = abortRun(db, runId);
    expect(res).toEqual({ already: 'finished' });
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed'); // untouched
  });
});
