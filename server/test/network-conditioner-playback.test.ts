import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback, abortRun, __setAbortRegistryForTest } from '../src/manual/playback.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

/** Plan 20260928T153608Z rev 2 stage 4 — playback integration:
 *  set-BEFORE-open (dyld constraint), finally clear (incl. abort),
 *  unpinned-touches-nothing (F2), honest NETWORK_CONDITION_FAILED. */

let db: Database.Database;
let tmp: string;
const condCalls: Array<{ udid: string; op: string; profile?: string }> = [];
const openCalls: string[] = [];
const timeline: string[] = []; // unified ordering: 'set' / 'open' / 'clear' in real call order
let condImpl: ((udid: string, op: { kind: 'set'; profile: string } | { kind: 'clear' }) => Promise<{ ok: boolean; reason?: string; detail?: string }>) | null = async (udid, op) => {
  condCalls.push({ udid, op: op.kind, profile: 'profile' in op ? op.profile : undefined });
  return { ok: true };
};

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_apps') { openCalls.push('open'); timeline.push('open'); }
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
        { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
        { index: 1, parentIndex: 0, type: 'Button', label: 'Sign Up', rect: { x: 100, y: 200, width: 60, height: 30 }, hittable: true, ref: 'n1' },
      ] } };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, steps: unknown[], variantsJson: string | null): void {
  db.prepare(`INSERT INTO templates(id, name, steps_json, tags_json, udid, app_bundle_id, variants_json, created_by, created_at, updated_at)
              VALUES (?, ?, ?, '[]', '', NULL, ?, 'qa', 1, 1)`).run(id, id, JSON.stringify(steps), variantsJson);
}

async function play(id: string, variant?: { id: string; network?: string }): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [], networkCondition: condImpl } as never, id, variant ? { variant } : {});
  await r.done;
  return r.runId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nc-'));
  db = new Database(':memory:');
  migrateM1(db);
  condCalls.length = 0;
  openCalls.length = 0;
  timeline.length = 0;
  condImpl = async (udid, op) => { condCalls.push({ udid, op: op.kind, profile: 'profile' in op ? op.profile : undefined }); timeline.push(op.kind); return { ok: true }; };
  process.env.CRUCIBLE_SETTLE_MS = '10';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = '4000';
  __setAbortRegistryForTest();
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_SETTLE_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  rmSync(tmp, { recursive: true, force: true });
});

describe('network conditioner playback', () => {
  it('pinned variant: set fires BEFORE the app open, clear fires in the finally (dyld constraint)', async () => {
    seed('tpl_pinned', [{ idx: 0, action: 'tap', x: 130, y: 215 }], JSON.stringify([{ id: 'slow', network: 'edge' }]));
    const runId = await play('tpl_pinned', { id: 'slow', network: 'edge' });
    const status = (db.prepare('SELECT status, note FROM runs WHERE id=?').get(runId) as { status: string; note: string });
    expect(status.status).toBe('passed');
    expect(status.note).toContain('net:edge');
    // unified timeline: set MUST precede open (dyld constraint), clear after
    const setIdx = timeline.indexOf('set');
    const openIdx = timeline.indexOf('open');
    const clearIdx = timeline.lastIndexOf('clear');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(setIdx);
    expect(clearIdx).toBeGreaterThan(openIdx);
    expect(condCalls.find((c) => c.op === 'set')!.profile).toBe('edge');
  });

  it('UNPINNED run touches nothing — a manual condition survives (F2)', async () => {
    seed('tpl_plain', [{ idx: 0, action: 'tap', x: 130, y: 215 }], null);
    const runId = await play('tpl_plain');
    expect((db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string }).status).toBe('passed');
    expect(condCalls.filter((c) => c.op === 'set' || c.op === 'clear')).toEqual([]);
  });

  it('conditioner failure fails the run honestly (NETWORK_CONDITION_FAILED), no silent wifi pass', async () => {
    seed('tpl_fail', [{ idx: 0, action: 'tap', x: 130, y: 215 }], JSON.stringify([{ id: 'x', network: '3g' }]));
    condImpl = async () => ({ ok: false, reason: 'baguette-absent', detail: 'baguette binary not found' });
    const runId = await play('tpl_fail', { id: 'x', network: '3g' });
    const row = db.prepare('SELECT status, note, blocked FROM runs WHERE id=?').get(runId) as { status: string; note: string; blocked: number };
    // infra failure semantics (the outer catch): aborted + blocked, note names the cause
    expect(row.status).toBe('aborted');
    expect(row.blocked).toBe(1);
    expect(row.note).toContain('network conditioner unavailable');
  });

  it('abort mid-run still clears the condition (finally hygiene)', async () => {
    seed('tpl_abrt', [{ idx: 0, action: 'tap', x: 130, y: 215 }], JSON.stringify([{ id: 'a', network: '3g' }]));
    // abort immediately after start: run the play, abort during done
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [], networkCondition: condImpl } as never, 'tpl_abrt', { variant: { id: 'a', network: '3g' } });
    abortRun(db, r.runId, bus as never);
    await r.done;
    expect(condCalls.some((c) => c.op === 'clear')).toBe(true);
  });
});
