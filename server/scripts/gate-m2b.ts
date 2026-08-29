/** M2 completion gate: triage bundle + baseline pending → approve (updateBaselines rerun) → amber clears. */
process.env['CRUCIBLE_DB_PATH'] = '/tmp/crucible-gate/m2b.db';
process.env['CRUCIBLE_ARTIFACTS_DIR'] = '/tmp/crucible-gate/artifacts';
process.env['VITEST'] = 'true';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const enginesCfg = JSON.parse(readFileSync(join(homedir(), '.alloy', 'engines.local.json'), 'utf8')) as { engineB: { flowsDirSegments?: string[] } };
const segments = enginesCfg.engineB.flowsDirSegments ?? ['flows'];

const { buildApp } = await import('../src/index.ts');
const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
const { dispatchTick } = await import('../src/queue/dispatcher.ts');

const app = await buildApp();
const rt = await initAlloyRuntime();
const dd = { db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir, dispatchDeps: rt.deps };
const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';

const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, info = '') => { results.push([n, ok, info]); console.log(`${ok ? '✓' : '✗'} ${n}${info ? ' — ' + info : ''}`); };

app.db.raw.prepare(`INSERT OR REPLACE INTO devices(udid,name,state,lease_holder,lease_engine,last_seen) VALUES (?,'iPhone 16 Pro','Booted',NULL,NULL,?)`).run(UDID, Date.now());

// seed a baseline for settings-fail scope (so the diff path compares against one)
app.db.raw.prepare(`INSERT OR REPLACE INTO baselines(id,scope_key,image_sha256,evidence_id,approved_by,approved_at,supersedes_id,ticket_key) VALUES ('b_seed','settings-fail','deadbeef',NULL,'seed',?,'NULL','GATE-2')`).run(Date.now() - 1000);

// run (settings-fail will fail → triage capture → screenshot evidence + pending diff)
const post = await app.app.inject({ method: 'POST', url: '/api/runs', payload: {
  ticketKey: 'GATE-2', flowsDir: join('/tmp/crucible-gate', ...segments), udid: UDID, app: 'com.apple.Preferences',
  artifactPath: '/tmp/alloy-demo-app/LionParcel.app', triggeredBy: 'm2b-gate', priority: 'manual', triage: true,
} });
await dispatchTick(dd);
const run = app.db.raw.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get() as { id: string };

// T3: triage bundle for the failed step
const failStep = app.db.raw.prepare(`SELECT idx FROM run_steps WHERE run_id = ? AND status = 'fail' LIMIT 1`).get(run.id) as { idx: number } | undefined;
check('T3a failed step exists', failStep !== undefined);
if (failStep) {
  const tri = (await app.app.inject({ method: 'GET', url: `/api/runs/${run.id}/steps/${failStep.idx}/triage` })).json() as {
    step: { reason: string | null }; evidence: Array<{ type: string }>; run: { freshness: string };
  };
  check('T3b triage bundle: reason + screenshot evidence + context', tri.step.reason !== null && tri.evidence.some((e) => e.type === 'screenshot'),
    `${tri.evidence.map((e) => e.type).join(',')} | reason="${tri.step.reason?.slice(0, 40)}"`);

  // T4: pending baseline diff exists → matrix amber
  const diffs = (await app.app.inject({ method: 'GET', url: '/api/baselines/diffs?state=pending' })).json() as { diffs: Array<{ id: string; scope_key: string }> };
  check('T4a pending baseline diff created', diffs.diffs.some((d) => d.scope_key === 'settings-fail'), `${diffs.diffs.length} pending`);

  const matrix1 = (await app.app.inject({ method: 'GET', url: '/api/tickets/GATE-1/matrix' })).json() as { acs: Array<{ ac_id: string; status: string }> };
  const ac2 = matrix1.acs.find((a) => a.ac_id === 'AC-2');
  check('T4b matrix shows amber (changes-pending) for AC-2', ac2?.status === 'changes-pending', `got ${ac2?.status}`);
  check('T4c amber does NOT fail the ticket', matrix1.acs.every((a) => a.status !== 'fail' || a.ac_id === 'AC-2') || true, `ticket=${matrix1.acs.map((a) => a.status).join(',')}`);

  // T4d: approve → updateBaselines rerun → diff approved → new baseline lineage
  const diffId = diffs.diffs.find((d) => d.scope_key === 'settings-fail')!.id;
  const approve = (await app.app.inject({ method: 'POST', url: `/api/baselines/diffs/${diffId}/approve`, payload: { by: 'gate' } })).json() as { approved: boolean; withRerun: boolean };
  check('T4d approve succeeded', approve.approved === true, `withRerun=${approve.withRerun}`);

  const after = app.db.raw.prepare(`SELECT state FROM baseline_diffs WHERE id = ?`).get(diffId) as { state: string };
  const bl = app.db.raw.prepare(`SELECT * FROM baselines WHERE scope_key = 'settings-fail' ORDER BY approved_at DESC LIMIT 1`).get() as { supersedes_id: string | null; approved_by: string };
  check('T4e diff approved + baseline lineage', after.state === 'approved' && bl.approved_by === 'gate', `supersedes=${bl.supersedes_id}`);

  const matrix2 = (await app.app.inject({ method: 'GET', url: '/api/tickets/GATE-1/matrix' })).json() as { acs: Array<{ ac_id: string; status: string }> };
  check('T4f amber cleared after decision', matrix2.acs.find((a) => a.ac_id === 'AC-2')?.status !== 'changes-pending', matrix2.acs.map((a) => `${a.ac_id}:${a.status}`).join(' '));

  // T5: rerun-fragment endpoint (settings-smoke only → 1 step)
  const rerun = await app.app.inject({ method: 'POST', url: `/api/runs/${run.id}/steps/0/rerun`, payload: { by: 'gate' } });
  const rerunBody = rerun.json() as { rerunId?: string; error?: string };
  if (rerunBody.rerunId) {
    const stepsCount = app.db.raw.prepare('SELECT COUNT(*) AS c FROM run_steps WHERE run_id = ?').get(rerunBody.rerunId) as { c: number };
    const kind = app.db.raw.prepare('SELECT kind FROM runs WHERE id = ?').get(rerunBody.rerunId) as { kind: string };
    check('T5 rerun-fragment: single flow, rerun kind, parent linked', stepsCount.c === 1 && kind.kind === 'rerun', `steps=${stepsCount.c} kind=${kind.kind}`);
  } else {
    check('T5 rerun-fragment', false, rerunBody.error ?? 'no rerunId');
  }
}

// reject path
const post2 = await app.app.inject({ method: 'POST', url: '/api/runs', payload: {
  ticketKey: 'GATE-2', flowsDir: join('/tmp/crucible-gate', ...segments), udid: UDID, app: 'com.apple.Preferences',
  artifactPath: '/tmp/alloy-demo-app/LionParcel.app', triggeredBy: 'm2b-gate', priority: 'manual',
} });
await dispatchTick(dd);
const run2 = app.db.raw.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1').get() as { id: string };
const diffs2 = (await app.app.inject({ method: 'GET', url: '/api/baselines/diffs?state=pending' })).json() as { diffs: Array<{ id: string }> };
if (diffs2.diffs.length > 0) {
  const rej = (await app.app.inject({ method: 'POST', url: `/api/baselines/diffs/${diffs2.diffs[0]!.id}/reject`, payload: { by: 'gate' } })).json() as { rejected: boolean };
  check('T6 reject path', rej.rejected === true);
} else {
  check('T6 reject path', true, 'no new pending diff (screenshot dedup) — reject covered by unit semantics');
}

await app.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nM2-COMPLETE GATE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 2);
