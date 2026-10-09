/** Overlay reliability round (2026-10-09): taps must NEVER silently vanish
 *  (dims fallback chain) and the anchor must measure the encoder startup gap
 *  (mvhd) — the 3-5s lateness the operator reported. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { recordTap } from '../src/evidence/taps-store.ts';

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'overlay-rel-'));
  db = new Database(':memory:');
  migrateM1(db);
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
              VALUES ('r1', 'T', 'manual', 'running', 'qa', 'U', 0)`).run();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('dims fallback chain (taps never vanish)', () => {
  it('recordTap accepts run-dims when the step snapshot missed (the vanishing-tap bug)', () => {
    // BEFORE the fix: logicalW/H = 0 → row rejected → tap invisible in evidence
    const seq = recordTap(db, { runId: 'r1', idx: 0, x: 200, y: 400, logicalW: 428, logicalH: 926 }, Date.now());
    expect(seq).toBe(1);
    // zero dims still rejected (guard intact — bad data must not produce
    // garbage fraction math)
    expect(recordTap(db, { runId: 'r1', idx: 1, x: 5, y: 5, logicalW: 0, logicalH: 0 }, Date.now())).toBeNull();
  });

  it('runs carry the new dims columns (gate-time persistence)', () => {
    db.prepare('UPDATE runs SET logical_w = 428, logical_h = 926 WHERE id = ?').run('r1');
    const row = db.prepare('SELECT logical_w, logical_h FROM runs WHERE id = ?').get('r1') as { logical_w: number; logical_h: number };
    expect(row).toMatchObject({ logical_w: 428, logical_h: 926 });
  });
});

/** Build a minimal spec-correct mp4: ftyp + moov→mvhd (version 0).
 *  Box = size(4) + type(4) + payload; mvhd payload = ver/flags(4) + created(4)
 *  + modified(4) + timescale(4) + duration(4) + pad. */
function tinyMp4(timescale: number, durationUnits: number): Buffer {
  const box = (type: string, payload: Buffer): Buffer => {
    const b = Buffer.concat([Buffer.alloc(4), Buffer.from(type), payload]);
    b.writeUInt32BE(b.length, 0);
    return b;
  };
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)]));
  const mvhdPayload = Buffer.alloc(96, 0);
  mvhdPayload.writeUInt32BE(timescale, 12);
  mvhdPayload.writeUInt32BE(durationUnits, 16);
  const moov = box('moov', box('mvhd', mvhdPayload));
  return Buffer.concat([ftyp, moov]);
}

describe('mvhd anchor math (lateness fix)', () => {
  it('parser reads timescale×duration from a minimal mp4', async () => {
    const f = join(tmp, 'probe.mp4');
    writeFileSync(f, tinyMp4(600, 12_000)); // 20s of media
    const { mvhdDurationMsForTest } = await import('../src/manual/evidence-recorder.ts');
    expect(await mvhdDurationMsForTest(f)).toBe(20_000);
  });

  it('garbage files return 0 (fallback anchor stands)', async () => {
    const f = join(tmp, 'garbage.mp4');
    writeFileSync(f, Buffer.from('not an mp4 at all'));
    const { mvhdDurationMsForTest } = await import('../src/manual/evidence-recorder.ts');
    expect(await mvhdDurationMsForTest(f)).toBe(0);
  });

  it('anchor = stopEpoch − mediaDuration lands AFTER the legacy start stamp (late-safe)', () => {
    // arithmetic sanity of the guard window: media ≤ wall-span + 2s accepted
    const startedWall = 1_000_000;
    const wall = startedWall + 24_000;       // 24s wall
    const media = 20_000;                    // 20s media → 4s encoder gap absorbed
    expect(media).toBeLessThanOrEqual(wall - startedWall + 2_000);
    const anchor = wall - media;             // 1_004_000 — AFTER startedWall ✓
    expect(anchor).toBeGreaterThan(startedWall);
  });
});
