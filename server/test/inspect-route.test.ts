import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startManualSession } from '../src/manual/session.ts';
import { inspectSample } from '../src/manual/inspect-route-fns.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import { migrateM1 } from '../src/db/schema.ts';

let db: Database.Database;
let tmp: string;
let shotPath: string;
let shotOk = true;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') {
        return {
          ok: true,
          result: {
            nodes: [
              { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false },
            ],
          },
        };
      }
      if (tool === 'alloy_screenshot') {
        expect(args['udid']).toBe('udid-x');
        if (!shotOk) return { ok: false, error: { message: 'engine cold' } };
        return { ok: true, result: { path: shotPath } };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;
const mkDeps = () => ({ db, bus, dispatchDeps: {} }) as never;

/** One 3× (1179×2556) canvas hosting two probe regions:
 *  - rounded brand-red button  rx=12pt at logical (32,100,200,66)
 *  - near-black 17pt text band at logical (32,300,300,50), white bg */
async function makeFixture(): Promise<string> {
  const svg = `<svg width="1179" height="2556">
    <rect width="1179" height="2556" fill="#FFFFFF"/>
    <rect x="96" y="300" width="600" height="198" rx="36" fill="#FF0000"/>
    <text x="96" y="1080" font-family="Helvetica" font-size="51" fill="#111111">Selamat pagi</text>
  </svg>`;
  const p = join(tmp, 'shot.png');
  writeFileSync(p, await sharp(Buffer.from(svg)).png().toBuffer());
  return p;
}

describe('inspectSample — pixel-estimate endpoint fns', () => {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'crucible-sample-'));
    db = new Database(join(tmp, 't.db'));
    db.pragma('journal_mode = WAL');
    migrateM1(db);
    shotOk = true;
    shotPath = await makeFixture();
    __setAlloyForTest(fakeAlloy());
  });
  afterEach(() => {
    __setAlloyForTest(null);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('button region: fill hex ≈ #FF0000, token brand500, radius ≈ 12pt, no text sampling', async () => {
    const sessionId = (await startManualSession(mkDeps(), 'udid-x', 'op')).sessionId;
    const r = await inspectSample(mkDeps(), sessionId, { x: 32, y: 100, width: 200, height: 66 }, 393, 'Button');
    expect(r.fill).not.toBeNull();
    expect(r.fill!.color.toUpperCase()).toBe('#FF0000');
    expect(r.fill!.token).toBe('backgroundBrand/brand500');
    expect(r.radius).not.toBeNull();
    expect(Math.abs(r.radius!.pt - 12)).toBeLessThanOrEqual(1.5);
    expect(r.text).toEqual({ color: null, token: null, sizePt: null }); // non-text node: all text fields null (independent)
    expect(r.scale).toBe(3);
  });

  it('text region: ink color near #111111, sizePt within ±2 of 17', async () => {
    const sessionId = (await startManualSession(mkDeps(), 'udid-x', 'op')).sessionId;
    const r = await inspectSample(mkDeps(), sessionId, { x: 32, y: 320, width: 300, height: 50 }, 393, 'StaticText');
    expect(r.text).not.toBeNull();
    const parts = [r.text!.color.slice(1, 3), r.text!.color.slice(3, 5), r.text!.color.slice(5, 7)].map((h) => parseInt(h, 16));
    const [rr = 0, gg = 0, bb = 0] = parts;
    expect(Math.abs(rr - 0x11) + Math.abs(gg - 0x11) + Math.abs(bb - 0x11)).toBeLessThan(60);
    expect(r.text!.sizePt).not.toBeNull();
    expect(Math.abs(r.text!.sizePt! - 17)).toBeLessThanOrEqual(2);
  });

  it('non-text nodeType → text null, fill still sampled', async () => {
    const sessionId = (await startManualSession(mkDeps(), 'udid-x', 'op')).sessionId;
    const r = await inspectSample(mkDeps(), sessionId, { x: 32, y: 100, width: 200, height: 66 }, 393, 'Other');
    expect(r.text).toBeNull();
    expect(r.fill!.color.toUpperCase()).toBe('#FF0000');
  });

  it('BAD_RECT: rect < 2×2 or missing logicalW → ManualSessionError code BAD_RECT', async () => {
    const sessionId = (await startManualSession(mkDeps(), 'udid-x', 'op')).sessionId;
    await expect(inspectSample(mkDeps(), sessionId, { x: 0, y: 0, width: 1, height: 1 }, 393, null)).rejects.toMatchObject({ code: 'BAD_RECT' });
    await expect(inspectSample(mkDeps(), sessionId, { x: 0, y: 0, width: 10, height: 10 }, 0, null)).rejects.toMatchObject({ code: 'BAD_RECT' });
  });

  it('screenshot dispatch failure → LEASE_LOST', async () => {
    shotOk = false;
    const sessionId = (await startManualSession(mkDeps(), 'udid-x', 'op')).sessionId;
    await expect(inspectSample(mkDeps(), sessionId, { x: 32, y: 100, width: 200, height: 66 }, 393, 'Button')).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});
