import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { EvidenceRecorder } from '../src/manual/evidence-recorder.ts';
import type { DispatchResult } from '../src/alloy/responses.ts';

/** Task 2 — video alignment anchor. startVideo() success must set
 *  runs.video_started_at (epoch ms) at the SUCCESS return; every failure
 *  path leaves it NULL. The evidence-player overlay times tap circles
 *  against this anchor. */
describe('EvidenceRecorder video_started_at', () => {
  let db: Database.Database;
  let dir: string;
  const RUN = 'run_va';
  const UDID = 'u1';
  const now = () => 1770000000000;

  function makeRecorder(dispatch: (tool: string, input: unknown) => Promise<unknown>) {
    return new EvidenceRecorder(
      {
        db,
        artifactsDir: join(dir, 'artifacts'),
        dispatch: ((tool: string, input: unknown) => dispatch(tool, input)) as never,
        dispatchDeps: {},
        respawnToolServer: () => {},
      },
      RUN,
      UDID,
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crucible-va-'));
    db = new Database(join(dir, 'test.db'));
    migrateM1(db);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, freshness) VALUES (?, 'X-1', 'manual', 'running', 'qa', ?, 'unchecked')`).run(RUN, UDID);
  });

  it('sets video_started_at on start success (epoch ms)', async () => {
    const rec = makeRecorder(async () => ({ ok: true, result: {} }) as never as DispatchResult);
    await rec.startVideo();
    const at = (db.prepare('SELECT video_started_at AS v FROM runs WHERE id = ?').get(RUN) as { v: number | null }).v;
    expect(at).toBeGreaterThan(0);
  });

  it('leaves video_started_at NULL when start fails', async () => {
    const rec = makeRecorder(async () => ({ ok: false, error: { code: 'E', message: 'engine says no' } }) as never as DispatchResult);
    await rec.startVideo();
    const at = (db.prepare('SELECT video_started_at AS v FROM runs WHERE id = ?').get(RUN) as { v: number | null }).v;
    expect(at).toBeNull();
  });

  it('leaves video_started_at NULL when start throws', async () => {
    const rec = makeRecorder(async () => { throw new Error('dispatch exploded'); });
    await rec.startVideo();
    const at = (db.prepare('SELECT video_started_at AS v FROM runs WHERE id = ?').get(RUN) as { v: number | null }).v;
    expect(at).toBeNull();
  });
});
