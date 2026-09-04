import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { runTemplatePlayback, PlaybackError } from '../src/manual/playback.ts';
import { recordArtifact } from '../src/manual/app-catalog-store.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';

let db: Database.Database;
let tmp: string;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
        { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false, ref: 'root' },
        { index: 1, parentIndex: 0, type: 'StaticText', label: 'Home', rect: { x: 0, y: 0, width: 10, height: 10 }, hittable: true, ref: 'n1' },
      ] } };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seedTemplate(id: string, appBundleId: string | null): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, ?, 'qa', 0, 0)`)
    .run(id, id, JSON.stringify([{ idx: 0, action: 'tap', x: 10, y: 10 }]), appBundleId);
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim', 'Sim', 'Booted', 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = 'Booted'`).run();
}

function harness(listApps?: (udid: string) => Promise<Array<{ bundleId: string }>>) {
  return { db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null },
    awaitStreamLive: null, ...(listApps ? { listApps } : {}) } as never;
}

beforeEach(() => {
  __setAlloyForTest(fakeAlloy());
  db = new Database(':memory:');
  migrateM1(db);
  tmp = mkdtempSync(join(tmpdir(), 'appcheck-'));
});
afterEach(() => {
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('playback app presence pre-check', () => {
  it('missing app + empty catalog → APP_NOT_INSTALLED, payload null artifact, NO run row', async () => {
    seedTemplate('tpl_x', 'com.test.app');
    let err: unknown;
    await runTemplatePlayback(harness(async () => [{ bundleId: 'com.apple.Preferences' }]), 'tpl_x', {}).catch((e) => { err = e; });
    expect(err).toBeInstanceOf(PlaybackError);
    const pe = err as PlaybackError;
    expect(pe.code).toBe('APP_NOT_INSTALLED');
    expect(pe.payload?.appBundleId).toBe('com.test.app');
    expect(pe.payload?.lastArtifact).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 0 });
  });

  it('missing app + catalog artifact → payload carries it; still no run row', async () => {
    seedTemplate('tpl_x', 'com.test.app');
    recordArtifact(db, { bundleId: 'com.test.app', artifactPath: '/store/com.test.app-2.0.0-1.app', appVersion: '2.0.0' });
    let err: unknown;
    await runTemplatePlayback(harness(async () => [{ bundleId: 'com.apple.Preferences' }]), 'tpl_x', {}).catch((e) => { err = e; });
    const pe = err as PlaybackError;
    expect(pe.code).toBe('APP_NOT_INSTALLED');
    expect(pe.payload?.lastArtifact?.path).toBe('/store/com.test.app-2.0.0-1.app');
    expect(pe.payload?.lastArtifact?.version).toBe('2.0.0');
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 0 });
  });

  it('app present → run proceeds', async () => {
    seedTemplate('tpl_x', 'com.test.app');
    const r = await runTemplatePlayback(harness(async () => [{ bundleId: 'com.test.app' }]), 'tpl_x', {});
    expect(r.runId).toMatch(/^run_/);
    await r.done;
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 1 });
  });

  it('listApps throws (shutdown sim) → pre-check skipped, run proceeds to engine gate', async () => {
    seedTemplate('tpl_x', 'com.test.app');
    const r = await runTemplatePlayback(harness(async () => { throw new Error('405 shutdown'); }), 'tpl_x', {});
    expect(r.runId).toMatch(/^run_/);
    await r.done;
  });

  it('TWO booted sims, recorded one shutdown, no choice → DEVICE_AMBIGUOUS with the booted list, no run row', async () => {
    seedTemplate('tpl_x', null);
    // the template's recorded device ('sim') is SHUTDOWN here — neither booted
    // candidate is the recorded one, and there are two of them
    db.prepare(`UPDATE devices SET state = 'Shutdown' WHERE udid = 'sim'`).run();
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('b1', 'Beta One', 'Booted', 'ios', 'simulator', 0)`).run();
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('b2', 'Beta Two', 'Booted', 'ios', 'simulator', 0)`).run();
    let err: unknown;
    await runTemplatePlayback(harness(async () => { throw new Error('should not be called'); }), 'tpl_x', {}).catch((e) => { err = e; });
    const pe = err as PlaybackError;
    expect(pe.code).toBe('DEVICE_AMBIGUOUS');
    expect(pe.message).toContain('2 devices are booted');
    expect(pe.payload?.booted?.map((b) => b.udid)).toEqual(['b1', 'b2']);
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 0 });
  });

  it('two booted sims, EXPLICIT udid wins → run proceeds on the chosen one', async () => {
    seedTemplate('tpl_x', 'com.test.app');
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim2', 'Sim Two', 'Booted', 'ios', 'simulator', 0)`).run();
    const r = await runTemplatePlayback(harness(async () => [{ bundleId: 'com.test.app' }]), 'tpl_x', { udid: 'sim2' });
    expect(r.udid).toBe('sim2');
    await r.done;
  });

  it('no app binding (Preferences) → no pre-check', async () => {
    seedTemplate('tpl_x', null);
    const r = await runTemplatePlayback(harness(async () => { throw new Error('should not be called'); }), 'tpl_x', {});
    await r.done;
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 1 });
  });
});
