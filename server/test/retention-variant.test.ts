/** Phase C T5 — per-variant retention: variant runs prune only their own
 *  variant's prior artifacts; siblings (other variants, variantless) survive. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { prunePreviousRunArtifacts } from '../src/evidence/retention.ts';

let db: Database.Database;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-t5-'));
  db = new Database(':memory:');
  migrateM1(db);
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at)
              VALUES ('tpl_r', 'retention case', NULL, 's', '[]', 'qa', 0, 0)`).run();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedRun(runId: string, variantId: string | null): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, variant_id)
              VALUES (?, 'MANUAL', 'manual', 'passed', 'qa', 's', 1, 2, 'tpl_r', ?)`).run(runId, variantId);
  mkdirSync(join(tmp, runId), { recursive: true });
  writeFileSync(join(tmp, runId, 'shot.png'), 'x');
  db.prepare(`INSERT INTO evidence(id, bundle_id, type, path, sha256, bytes, created_at) VALUES (?, ?, 'screenshot', ?, 'deadbeef', 1, 1)`).run(`ev_${runId}`, runId, join(tmp, runId, 'shot.png'));
}

describe('prunePreviousRunArtifacts — per-variant scoping', () => {
  it('variant run prunes only ITS variant\'s prior artifacts; sibling variants survive', () => {
    seedRun('r_active_old', 'active');   // prior active — should be pruned
    seedRun('r_pending_old', 'pending'); // sibling — must SURVIVE
    seedRun('r_plain_old', null);        // variantless sibling — must SURVIVE
    seedRun('r_active_new', 'active');   // the new run (kept)

    const pruned = prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_r', variantId: 'active' }, 'r_active_new');

    expect(pruned).toBe('r_active_old');
    expect(existsSync(join(tmp, 'r_active_old'))).toBe(false);           // pruned
    expect(existsSync(join(tmp, 'r_pending_old'))).toBe(true);           // sibling survives
    expect(existsSync(join(tmp, 'r_plain_old'))).toBe(true);             // variantless survives
    expect(db.prepare("SELECT COUNT(*) n FROM evidence WHERE bundle_id = 'r_active_old'").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM evidence WHERE bundle_id = 'r_pending_old'").get()).toMatchObject({ n: 1 });
  });

  it('variantless run (variantId null) prunes only variantless priors (compat)', () => {
    seedRun('r_active_old', 'active');
    seedRun('r_plain_old', null);
    seedRun('r_plain_new', null);

    const pruned = prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_r', variantId: null }, 'r_plain_new');

    expect(pruned).toBe('r_plain_old');
    expect(existsSync(join(tmp, 'r_active_old'))).toBe(true); // variant run's evidence survives
    expect(existsSync(join(tmp, 'r_plain_old'))).toBe(false);
  });

  it('omitted variantId behaves as null (legacy callers unchanged)', () => {
    seedRun('r_active_old', 'active');
    seedRun('r_plain_old', null);
    seedRun('r_plain_new', null);

    const pruned = prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_r' }, 'r_plain_new');
    expect(pruned).toBe('r_plain_old');
    expect(existsSync(join(tmp, 'r_active_old'))).toBe(true);
  });
});
