import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { migrateM1 } from '../src/db/schema.ts';
import { postDarwinNotification } from '../src/manual/apps.ts';

/** Signal refresh (plan 20260925T002337Z): the runner's `signal` gesture
 *  posts a Darwin notification INTO the sim's notifyd domain via
 *  `simctl spawn <udid> notifyutil -p <name>` — host notifyutil cannot
 *  reach it. This pins the exact argv shape (device-op lives in apps.ts,
 *  the allowlisted module). Same fakeXcrun seam as app-install.test.ts. */

const REAL_PATH = process.env.PATH!;

function fakeXcrun(dir: string, opts: { fail?: boolean }): void {
  const script = join(dir, 'xcrun');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
    opts.fail ? 'echo "spawn failed" >&2; exit 70' : '',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
}

let bin: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'sig-bin-'));
  process.env.PATH = `${bin}:${REAL_PATH}`;
});

afterEach(() => {
  process.env.PATH = REAL_PATH;
  rmSync(bin, { recursive: true, force: true });
});

describe('postDarwinNotification', () => {
  it('spawns notifyutil INSIDE the sim with the notification name', async () => {
    fakeXcrun(bin, {});
    await postDarwinNotification('30B2-UDID', 'com.crucible.refresh.home');
    const calls = readFileSync(join(bin, 'calls.log'), 'utf-8').trim().split('\n');
    expect(calls).toEqual(['simctl spawn 30B2-UDID notifyutil -p com.crucible.refresh.home']);
  });

  it('propagates spawn failure (simctl spawn broken → SCREEN_ENTRY_FAILED upstream)', async () => {
    fakeXcrun(bin, { fail: true });
    await expect(postDarwinNotification('u', 'n')).rejects.toThrow();
  });
});

describe('grammar — signal gesture (shared validation)', () => {
  it('is accepted with no selector and exported bare', async () => {
    const { validateScreen } = await import('@crucible/shared/app-screens');
    const errors = validateScreen({ id: 'home', entry: { tab: { label: 'Home' } }, refresh: { gesture: 'signal' }, states: { loaded: { all: [{ label: 'x' }] } } });
    expect(errors).toEqual([]);
    // and the runner-facing check stays honest: back-forward without selector still 422s (regression pin)
    expect(validateScreen({ id: 's', entry: { tab: { label: 'H' } }, refresh: { gesture: 'back-forward' }, states: { loaded: { all: [{ label: 'x' }] } } }).length).toBeGreaterThan(0);
  });
});

// keep tsc honest about the unused import tree when Database/migrateM1 are pruned
void Database; void migrateM1; void existsSync;


// ── B.3: runner refresh('signal') path ─────────────────────────────────────
import { ScreenRunner, type ScreenRunnerDeps } from '../src/manual/screen-runner.ts';
import { mkdtempSync as mkScratch } from 'node:fs';
import { join as joinP } from 'node:path';

describe('ScreenRunner.refresh — signal gesture', () => {
  it('posts com.crucible.refresh.<screen> into the sim and guard-1 confirms on traffic', async () => {
    fakeXcrun(bin, {}); // plant AFTER the outer beforeEach recreated bin for THIS test
    const root = mkScratch(joinP(tmpdir(), 'sig-runner-'));
    const sdb = new Database(joinP(root, 't.db'));
    sdb.exec(`CREATE TABLE app_screens(app_bundle_id TEXT NOT NULL, screen_id TEXT NOT NULL, entry_json TEXT NOT NULL, refresh_json TEXT, states_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(app_bundle_id, screen_id))`);
    sdb.exec(`CREATE TABLE traffic(id TEXT PRIMARY KEY, run_id TEXT, ts INTEGER NOT NULL, mode TEXT NOT NULL, method TEXT NOT NULL, host TEXT, path TEXT NOT NULL, matched_preset_id TEXT, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, req_sha TEXT, res_sha TEXT)`);
    sdb.prepare(`INSERT INTO app_screens VALUES ('b','home','{}','{"gesture":"signal"}','{"loaded":{"all":[{"label":"x"}]}}',1)`).run();
    // the fetch arrives shortly after the signal (the app re-dispatches)
    setTimeout(() => sdb.prepare(`INSERT INTO traffic(id,run_id,ts,mode,method,path,matched_preset_id,status,latency_ms) VALUES ('t1','run_sig',?,'hybrid','GET','/r','p1',200,5)`).run(Date.now()), 30);

    const runner = new ScreenRunner({
      db: sdb, appBundleId: 'b', runId: 'run_sig', udid: 'SIMID',
      dispatch: (async () => ({ ok: true, result: { nodes: [] } })) as ScreenRunnerDeps['dispatch'],
      forgeActivate: () => undefined,
      budgets: { settleMs: 50, worldConfirmMs: 400, worldConfirmPollMs: 20, statePollMs: 10 },
    });
    const out = await runner.refresh('home');
    const calls = readFileSync(join(bin, 'calls.log'), 'utf-8').trim().split('\n');
    expect(calls.some((c) => c === 'simctl spawn SIMID notifyutil -p com.crucible.refresh.home')).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.note ?? '').toContain('signal');
    sdb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails SWAP_NOT_CONFIRMED when the app ignores the signal (no traffic)', async () => {
    fakeXcrun(bin, {});
    const root = mkScratch(joinP(tmpdir(), 'sig-runner2-'));
    const sdb = new Database(joinP(root, 't.db'));
    sdb.exec(`CREATE TABLE app_screens(app_bundle_id TEXT NOT NULL, screen_id TEXT NOT NULL, entry_json TEXT NOT NULL, refresh_json TEXT, states_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(app_bundle_id, screen_id))`);
    sdb.exec(`CREATE TABLE traffic(id TEXT PRIMARY KEY, run_id TEXT, ts INTEGER NOT NULL, mode TEXT NOT NULL, method TEXT NOT NULL, host TEXT, path TEXT NOT NULL, matched_preset_id TEXT, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, req_sha TEXT, res_sha TEXT)`);
    sdb.prepare(`INSERT INTO app_screens VALUES ('b','home','{}','{"gesture":"signal"}','{"loaded":{"all":[{"label":"x"}]}}',1)`).run();
    const runner = new ScreenRunner({
      db: sdb, appBundleId: 'b', runId: 'run_sig2', udid: 'SIMID',
      dispatch: (async () => ({ ok: true, result: { nodes: [] } })) as ScreenRunnerDeps['dispatch'],
      forgeActivate: () => undefined,
      budgets: { settleMs: 50, worldConfirmMs: 150, worldConfirmPollMs: 20, statePollMs: 10 },
    });
    const out = await runner.refresh('home');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('SWAP_NOT_CONFIRMED'); // narrowed: ok=false carries code
    sdb.close();
    rmSync(root, { recursive: true, force: true });
  });
});
