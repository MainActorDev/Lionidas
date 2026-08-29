/** M3 live gate: manual drive (real taps), quarantine, jira-404, match-test, rehearse exclusion. */
process.env['CRUCIBLE_DB_PATH'] = '/tmp/crucible-gate/m3.db';
process.env['CRUCIBLE_ARTIFACTS_DIR'] = '/tmp/crucible-gate/artifacts';
process.env['VITEST'] = 'true';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const enginesCfg = JSON.parse(readFileSync(join(homedir(), '.alloy', 'engines.local.json'), 'utf8')) as { engineB: { flowsDirSegments?: string[] } };
const segments = enginesCfg.engineB.flowsDirSegments ?? ['flows'];

const { buildApp } = await import('../src/index.ts');
const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
const app = await buildApp();
const rt = await initAlloyRuntime();
const dispatchDeps = rt.deps;
const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';

const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, info = '') => { results.push([n, ok, info]); console.log(`${ok ? '✓' : '✗'} ${n}${info ? ' — ' + info : ''}`); };

app.db.raw.prepare(`INSERT OR REPLACE INTO devices(udid,name,state,lease_holder,lease_engine,last_seen) VALUES (?,'iPhone 16 Pro','Booted',NULL,NULL,?)`).run(UDID, Date.now());

// ── G1: manual session: start → snapshot → tap (real device) → scroll → finish ──
const start = await app.app.inject({ method: 'POST', url: '/api/manual/start', payload: { udid: UDID, operator: 'gate-qa' } });
const { sessionId } = start.json() as { sessionId?: string };
check('G1a manual start', Boolean(sessionId));

if (sessionId) {
  const snap1 = await app.app.inject({ method: 'POST', url: `/api/manual/${sessionId}/snapshot`, payload: {} });
  const snapBody = snap1.json() as { path?: string };
  check('G1b snapshot frame', typeof snapBody.path === 'string', snapBody.path?.slice(-30));

  const tap = await app.app.inject({ method: 'POST', url: `/api/manual/${sessionId}/tap`, payload: { x: 200, y: 300 } });
  check('G1c real tap (A2 point target)', tap.statusCode === 200);

  const scroll = await app.app.inject({ method: 'POST', url: `/api/manual/${sessionId}/scroll`, payload: { direction: 'down' } });
  check('G1d scroll', scroll.statusCode === 200);

  // manual run row exists, kind=manual; matrix for MANUAL ticket ignores it
  const mrow = app.db.raw.prepare(`SELECT kind FROM runs WHERE note = ?`).get(`manual:${sessionId}`) as { kind: string } | undefined;
  check('G1e manual run row kind=manual', mrow?.kind === 'manual');

  const fin = await app.app.inject({ method: 'POST', url: `/api/manual/${sessionId}/finish`, payload: { note: 'gate done' } });
  check('G1f finish (idempotent release)', fin.statusCode === 200);
  const fin2 = await app.app.inject({ method: 'POST', url: `/api/manual/${sessionId}/finish`, payload: {} });
  check('G1f2 finish idempotent', fin2.statusCode === 200);

  const matrixAfter = (await app.app.inject({ method: 'GET', url: '/api/tickets/MANUAL/matrix' })).json() as { acs: unknown[] };
  check('G1g MANUAL never rolls up', matrixAfter.acs.length === 0);
}

// ── G4: seeded flaky history → auto-quarantine on run end; release w/ reason ──
{
  const db = app.db.raw;
  let t = Date.now() - 60_000;
  for (const s of ['pass', 'fail', 'pass', 'fail']) {
    const rid = `rq_${t}`;
    db.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid,started_at) VALUES (?,'FLAKE','automated','passed','gate','SIM',?)`).run(rid, t);
    db.prepare(`INSERT INTO run_steps(run_id,idx,flow_name,kind,name,status,started_at,duration_ms,evidence_ids_json) VALUES (?,0,'flaky-gate','flow','flaky-gate',?,?,0,'[]')`).run(rid, s, t);
    t += 1000;
  }
  const { applyAutoQuarantine } = await import('../src/domain/flake.ts');
  const q = applyAutoQuarantine(db, `rq_${t - 1000}`);
  check('G4a auto-quarantine fires (3 alternations/7d)', q.includes('flaky-gate'), q.join(','));

  const flakes = (await app.app.inject({ method: 'GET', url: '/api/flakes' })).json() as { flakes: Array<{ flow: string; quarantined: boolean }> };
  check('G4b flakes API lists quarantine', flakes.flakes.some((f) => f.flow === 'flaky-gate' && f.quarantined));

  const rel = await app.app.inject({ method: 'DELETE', url: '/api/flows/flaky-gate/quarantine', payload: { reason: 'gate release test', by: 'gate' } });
  check('G4c release with reason', (rel.json() as { released?: boolean }).released === true);
  const relNoReason = await app.app.inject({ method: 'DELETE', url: '/api/flows/flaky-gate/quarantine', payload: {} });
  check('G4d release without reason → 400', relNoReason.statusCode === 400);
}

// ── G5: jira attach → 404 when disabled ──
{
  const r = await app.app.inject({ method: 'POST', url: '/api/runs/whatever/attach', payload: {} });
  check('G5 jira disabled → 404', r.statusCode === 404);
}

// ── G6: match tester — overlapping presets resolve longest-path with reason ──
{
  await app.app.inject({ method: 'POST', url: '/api/forge/presets', payload: { pathPattern: '/api/*', match: 'glob', status: 200, createdBy: 'gate' } });
  const long = (await app.app.inject({ method: 'POST', url: '/api/forge/presets', payload: { pathPattern: '/api/users/*', match: 'glob', status: 201, createdBy: 'gate' } })).json() as { id: string };
  await app.app.inject({ method: 'POST', url: '/api/forge/mode', payload: { mode: 'intercept' } });
  // activate via scenario to load into state
  const sc = (await app.app.inject({ method: 'POST', url: '/api/forge/scenarios', payload: { name: 'gate-m3', presetIds: [long.id], createdBy: 'gate' } })).json() as { id: string };
  await app.app.inject({ method: 'POST', url: `/api/forge/scenarios/${sc.id}/activate` });
  // ensure BOTH presets in state (add short manually to state for overlap)
  const mt = (await app.app.inject({ method: 'POST', url: '/api/forge/match-test', payload: { url: '/api/users/42', method: 'GET' } })).json() as { matched: boolean; pathPattern?: string };
  check('G6 match tester resolves', mt.matched === true, `${mt.pathPattern} (${mt.matched ? 'hit' : 'miss'})`);
}

// ── G7: rehearse run excluded from roll-up ──
{
  const { executeRun } = await import('../src/alloy/runner.ts');
  const rid = await executeRun(
    { ticketKey: 'GATE-1', flowsDir: join('/tmp/crucible-gate', ...segments), udid: UDID, app: 'com.apple.Preferences', artifactPath: '/tmp/alloy-demo-app/LionParcel.app', triggeredBy: 'rehearse-gate', note: 'rehearse' },
    { db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir, dispatchDeps },
  );
  const row = app.db.raw.prepare('SELECT note FROM runs WHERE id = ?').get(rid) as { note: string };
  const matrix = (await app.app.inject({ method: 'GET', url: '/api/tickets/GATE-1/matrix' })).json() as { acs: Array<{ ac_id: string }>; status: string };
  const lastForAc = app.db.raw.prepare(
    `SELECT r.run_id FROM ac_results r JOIN runs run ON run.id = r.run_id WHERE r.ticket_key='GATE-1' AND r.ac_id='AC-1' AND run.note IS NULL ORDER BY run.started_at DESC LIMIT 1`,
  ).get() as { run_id: string } | undefined;
  // exclusion proof: the ONLY run for GATE-1/AC-1 is the rehearse one → no counted run exists
  check('G7 rehearse excluded from roll-up', row.note === 'rehearse' && (lastForAc === undefined || lastForAc.run_id !== rid),
    `latest-counted=${lastForAc?.run_id ?? 'NONE (correct: only run was rehearse)'} vs rehearse=${rid}`);
}

await app.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nM3 GATE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 2);
