import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { flowHistory, alternationCount, flakeScore, shouldAutoQuarantine, applyAutoQuarantine } from '../src/domain/flake.ts';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
});

let seedClock = Date.now() - 60_000;
function seedFlowRuns(flow: string, statuses: string[], ticket = 'T', note: string | null = null): void {
  let t = seedClock;
  for (const s of statuses) {
    const runId = `r_${flow}_${t}`;
    db.prepare(
      `INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid,started_at,note)
       VALUES (?,?, 'automated','passed','t','SIM',?,?)`,
    ).run(runId, ticket, t, note);
    db.prepare(
      `INSERT INTO run_steps(run_id,idx,flow_name,kind,name,status,started_at,duration_ms,evidence_ids_json)
       VALUES (?,0,?,'flow',?,?,?,0,'[]')`,
    ).run(runId, flow, flow, s, t);
    t += 1000;
  }
  seedClock = t + 1000;
}

describe('flake math', () => {
  it('alternation count: pass,fail,pass,fail → 3', () => {
    const h = flowHistory((seedFlowRuns('f', ['pass', 'fail', 'pass', 'fail']), db), 'f');
    expect(alternationCount(h)).toBe(3);
  });
  it('stable pass → 0; skip ignored', () => {
    const h1 = flowHistory((seedFlowRuns('g', ['pass', 'pass', 'pass']), db), 'g');
    expect(alternationCount(h1)).toBe(0);
    const h2 = flowHistory((seedFlowRuns('h', ['pass', 'skip', 'pass']), db), 'h');
    expect(alternationCount(h2)).toBe(0);
  });
  it('flake score denominator', () => {
    const h = flowHistory((seedFlowRuns('i', ['pass', 'fail']), db), 'i');
    expect(flakeScore(h)).toBe(1);
  });
  it('rehearse runs excluded from history', () => {
    seedFlowRuns('j', ['pass', 'pass'], 'T', null);
    seedFlowRuns('j', ['fail'], 'T', 'rehearse');
    const h = flowHistory(db, 'j');
    expect(h.every((x) => x.status === 'pass')).toBe(true);
  });
});

describe('auto-quarantine', () => {
  it('>=3 alternations within 7d quarantines', () => {
    seedFlowRuns('flaky', ['pass', 'fail', 'pass', 'fail']);
    const last = db.prepare(`SELECT id FROM runs WHERE started_at = (SELECT MAX(started_at) FROM runs)`).get() as { id: string };
    const q = applyAutoQuarantine(db, last.id);
    expect(q).toContain('flaky');
    const row = db.prepare('SELECT reason, by FROM flow_quarantine WHERE flow_key = ? AND released_at IS NULL').get('flaky') as { reason: string; by: string };
    expect(row.by).toBe('auto');
    expect(row.reason).toContain('alternations');
  });
  it('stable flow not quarantined', () => {
    seedFlowRuns('stable', ['pass', 'pass', 'pass', 'pass']);
    const last = db.prepare(`SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`).get() as { id: string };
    expect(applyAutoQuarantine(db, last.id)).not.toContain('stable');
  });
  it('shouldAutoQuarantine false when alternations older than 7d', () => {
    seedFlowRuns('old', ['pass', 'fail', 'pass', 'fail']);
    db.prepare(`UPDATE runs SET started_at = started_at - 30*24*3600*1000`).run();
    const h = flowHistory(db, 'old');
    expect(shouldAutoQuarantine(h)).toBe(false);
  });
});
