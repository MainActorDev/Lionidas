/** M2 gate: POST /runs → queue → dispatcher → live run; Forge scenario round-trip. */
process.env['CRUCIBLE_DB_PATH'] = '/tmp/crucible-gate/m2.db';
process.env['CRUCIBLE_ARTIFACTS_DIR'] = '/tmp/crucible-gate/artifacts';
process.env['VITEST'] = 'true';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const enginesCfg = JSON.parse(readFileSync(join(homedir(), '.alloy', 'engines.local.json'), 'utf8')) as {
  engineB: { flowsDirSegments?: string[] };
};
const segments = enginesCfg.engineB.flowsDirSegments ?? ['flows'];

const { buildApp } = await import('../src/index.ts');
const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
const { startDispatcher, dispatchTick } = await import('../src/queue/dispatcher.ts');

const app = await buildApp();
const rt = await initAlloyRuntime();
const dispatcherDeps = { db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir, dispatchDeps: rt.deps };

const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok, info]);
  console.log(`${ok ? '✓' : '✗'} ${name}${info ? ' — ' + info : ''}`);
};

// seed device mirror (dispatcher pre-flight needs it)
app.db.raw.prepare(`INSERT OR REPLACE INTO devices(udid, name, state, lease_holder, lease_engine, last_seen) VALUES (?, 'iPhone 16 Pro', 'Booted', NULL, NULL, ?)`).run(UDID, Date.now());

// ── G1: POST /runs → 202 → dispatched → live run ──
const post = await app.app.inject({
  method: 'POST',
  url: '/api/runs',
  payload: {
    ticketKey: 'GATE-2',
    flowsDir: join('/tmp/crucible-gate', ...segments),
    udid: UDID,
    app: 'com.apple.Preferences',
    artifactPath: '/tmp/alloy-demo-app/LionParcel.app',
    srcPath: '/tmp/alloy-demo-app',
    triggeredBy: 'm2-gate',
    priority: 'manual',
  },
});
const { queueId } = post.json() as { queueId: string };
check('G1a POST /runs accepted', post.statusCode === 202 && Boolean(queueId), `queue=${queueId}`);

await dispatchTick(dispatcherDeps);
const runs = app.db.raw.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').all() as Array<{ id: string; status: string; ticket_key: string }>;
const run = runs[0]!;
check('G1b run executed', run.ticket_key === 'GATE-2' && run.status === 'failed', `status=${run.status} (1 deliberate-fail AC)`);

const steps = app.db.raw.prepare('SELECT flow_name, status FROM run_steps WHERE run_id = ? ORDER BY idx').all(run.id) as Array<{ flow_name: string; status: string }>;
check('G1c steps recorded', steps.length === 2 && steps.some((s) => s.status === 'pass') && steps.some((s) => s.status === 'fail'),
  steps.map((s) => `${s.flow_name}:${s.status}`).join(' '));

// ── G1d invalid POST rejected pre-queue (never enqueued) ──
const bad = await app.app.inject({ method: 'POST', url: '/api/runs', payload: { ticketKey: 'X' } });
check('G1d invalid POST → 400 (never queued)', bad.statusCode === 400);

// ── G2: second POST while device busy → waits; runs after ──
app.db.raw.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid) VALUES ('rbusy','GATE-2','automated','running','x',?)`).run(UDID);
const q2 = (await app.app.inject({
  method: 'POST', url: '/api/runs',
  payload: { ticketKey: 'GATE-2', flowsDir: join('/tmp/crucible-gate', ...segments), udid: UDID, app: 'com.apple.Preferences', artifactPath: '/tmp/alloy-demo-app/LionParcel.app', triggeredBy: 'm2', priority: 'manual' },
})).json() as { queueId: string };
const tickHeld = await dispatchTick(dispatcherDeps); // device busy → nothing dispatched
const stillWaiting = app.db.raw.prepare('SELECT state FROM queue WHERE id = ?').get(q2.queueId) as { state: string };
check('G2 busy device → queue waits', tickHeld === false && stillWaiting.state === 'waiting');
app.db.raw.prepare(`DELETE FROM runs WHERE id = 'rbusy'`).run();
await dispatchTick(dispatcherDeps);
const q2row = app.db.raw.prepare('SELECT state, dispatched_run_id FROM queue WHERE id = ?').get(q2.queueId) as { state: string; dispatched_run_id: string | null };
check('G2b freed → dispatched', q2row.state === 'done', `run=${q2row.dispatched_run_id ?? '—'}`);

// ── G5: Forge scenario round-trip (preset → scenario → activate → traffic) ──
const preset = (await app.app.inject({
  method: 'POST', url: '/api/forge/presets',
  payload: { pathPattern: '/api/promo', match: 'exact', status: 200, createdBy: 'gate' },
})).json() as { id: string };
const scenario = (await app.app.inject({
  method: 'POST', url: '/api/forge/scenarios',
  payload: { name: 'gate-scenario', presetIds: [preset.id], createdBy: 'gate' },
})).json() as { id: string };
const act = (await app.app.inject({ method: 'POST', url: `/api/forge/scenarios/${scenario.id}/activate` })).json() as { active: number };
check('G5a scenario activated', act.active === 1);

app.forgeState.mode = 'intercept';
const hit = await fetch(`http://127.0.0.1:${0}/api/promo`).catch(() => null); // proxy not started as listener here
// use the exported state against a scratch proxy for the round-trip:
const { startForgeProxy } = await import('../src/forge/proxy.ts');
const tmpProxy = await startForgeProxy({ db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir }, app.forgeState);
const t1 = await fetch(`http://127.0.0.1:${tmpProxy.port}/api/promo`);
const t2 = await fetch(`http://127.0.0.1:${tmpProxy.port}/unmatched`);
await tmpProxy.close();
const traffic = app.db.raw.prepare(`SELECT * FROM traffic WHERE path = '/api/promo' ORDER BY ts DESC LIMIT 1`).get() as { matched_preset_id: string | null; mode: string } | undefined;
check('G5b override + traffic logged', t1.status === 200 && t2.status === 501 && traffic?.matched_preset_id === preset.id,
  `preset hit ${t1.status}, unmatched ${t2.status}, traffic row mode=${traffic?.mode}`);

// G6: sequence preset 200→500
const seqPreset = (await app.app.inject({
  method: 'POST', url: '/api/forge/presets',
  payload: { pathPattern: '/api/flaky', match: 'exact', status: 200, seq: [{ status: 200 }, { status: 500 }], createdBy: 'gate' },
})).json() as { id: string };
app.forgeState.presets.push({
  id: seqPreset.id, method: 'GET', pathPattern: '/api/flaky', match: 'exact', status: 200,
  seq: [{ status: 200 }, { status: 500 }],
});
const seqProxy = await startForgeProxy({ db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir }, app.forgeState);
const f1 = await fetch(`http://127.0.0.1:${seqProxy.port}/api/flaky`);
const f2 = await fetch(`http://127.0.0.1:${seqProxy.port}/api/flaky`);
const f3 = await fetch(`http://127.0.0.1:${seqProxy.port}/api/flaky`);
await seqProxy.close();
check('G6 sequence 200→500→500(last repeats)', [f1.status, f2.status, f3.status].join(',') === '200,500,500');

// G8: STALE artifact via API → run fails fast with badge
// (artifact mtime = now-60s; source file touched now → source NEWER → stale)
const { utimesSync } = await import('node:fs');
const sixtyAgo = (Date.now() - 60_000) / 1000;
utimesSync('/tmp/alloy-demo-app/LionParcel.app', sixtyAgo, sixtyAgo);
const { execSync } = await import('node:child_process');
execSync('touch /tmp/crucible-gate-stale-src/NewFeature.swift');
const staleQ = (await app.app.inject({
  method: 'POST', url: '/api/runs',
  payload: { ticketKey: 'GATE-2', flowsDir: join('/tmp/crucible-gate', ...segments), udid: UDID, app: 'com.apple.Preferences', artifactPath: '/tmp/alloy-demo-app/LionParcel.app', srcPath: '/tmp/crucible-gate-stale-src', triggeredBy: 'm2', priority: 'manual' },
})).json() as { queueId: string };
await dispatchTick(dispatcherDeps);
const staleRun = app.db.raw.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get() as { freshness: string; status: string };
check('G8 STALE via API → fail-fast + badge', staleRun.freshness === 'stale_ignored' && staleRun.status === 'failed');

await app.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nM2 GATE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 2);
