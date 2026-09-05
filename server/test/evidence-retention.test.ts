import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { prunePreviousRunArtifacts } from '../src/evidence/retention.ts';

let db: Database.Database;
let tmp: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
  tmp = mkdtempSync(join(tmpdir(), 'ret-'));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const seededTemplates = new Set<string>();
function seedTemplateRun(id: string, templateId: string, finished: boolean): void {
  if (!seededTemplates.has(templateId)) {
    seededTemplates.add(templateId);
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at)
                VALUES (?, ?, NULL, 'sim', '[]', 'qa', 0, 0)`).run(templateId, templateId);
  }
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id)
              VALUES (?, 'TEMPLATE', 'manual', ?, 'qa', 'sim', ?, ?, ?)`)
    .run(id, finished ? 'passed' : 'running', Date.now(), `template:${templateId} x`, templateId);
  if (finished) db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(Date.now(), id);
}

function seedEvidence(runId: string): void {
  mkdirSync(join(tmp, runId), { recursive: true });
  writeFileSync(join(tmp, runId, 'screenshot-abc-screenshot.png'), 'png');
  db.prepare(`INSERT INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at)
              VALUES (?, ?, 'screenshot', ?, 'sha', 3, NULL, 0)`).run(`ev-${runId}`, runId, join(tmp, runId, 'screenshot-abc-screenshot.png'));
  db.prepare('UPDATE runs SET artifact_path = ? WHERE id = ?').run(join(tmp, runId, 'screenshot-abc-screenshot.png'), runId);
  db.prepare(`INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, started_at, duration_ms, evidence_ids_json)
              VALUES (?, 0, 't', 'act', 'tap', 'pass', 0, 0, ?)`).run(runId, JSON.stringify([`ev-${runId}`]));
}

describe('prunePreviousRunArtifacts', () => {
  it('new template run prunes the previous finished run\'s files + evidence, keeps DB row', () => {
    seedTemplateRun('run_old', 'tpl_x', true);
    seedEvidence('run_old');
    seedTemplateRun('run_new', 'tpl_x', false);
    const pruned = prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_x' }, 'run_new');
    expect(pruned).toBe('run_old');
    expect(existsSync(join(tmp, 'run_old'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM evidence WHERE bundle_id = ?').get('run_old')).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT evidence_ids_json FROM run_steps WHERE run_id = ?').all('run_old')).toEqual([{ evidence_ids_json: '[]' }]);
    // run row survives with nulled artifact refs
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get('run_old')).toMatchObject({ status: 'passed' });
    expect(db.prepare('SELECT artifact_path FROM runs WHERE id = ?').get('run_old')).toMatchObject({ artifact_path: null });
  });

  it('never prunes a still-running previous run', () => {
    seedTemplateRun('run_live', 'tpl_y', false);
    seedEvidence('run_live');
    seedTemplateRun('run_new', 'tpl_y', false);
    const pruned = prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_y' }, 'run_new');
    expect(pruned).toBeNull();
    expect(existsSync(join(tmp, 'run_live'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM evidence WHERE bundle_id = ?').get('run_live')).toMatchObject({ c: 1 });
  });

  it('different templates are independent', () => {
    seedTemplateRun('run_a', 'tpl_a', true);
    seedEvidence('run_a');
    seedTemplateRun('run_new_b', 'tpl_b', false);
    expect(prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_b' }, 'run_new_b')).toBeNull();
    expect(existsSync(join(tmp, 'run_a'))).toBe(true);
  });

  it('first-ever run: nothing to prune', () => {
    seedTemplateRun('run_first', 'tpl_z', false);
    expect(prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_z' }, 'run_first')).toBeNull();
  });

  it('automated runs group by ticket_key (template_id NULL)', () => {
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at)
                VALUES ('run_auto1', 'ANZ-1', 'automated', 'passed', 'ci', 'sim', 1, 2)`).run();
    seedEvidence('run_auto1');
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_auto2', 'ANZ-1', 'automated', 'running', 'ci', 'sim', 3)`).run();
    expect(prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { ticketKey: 'ANZ-1' }, 'run_auto2')).toBe('run_auto1');
    expect(existsSync(join(tmp, 'run_auto1'))).toBe(false);
  });

  it('missing artifact dir: best-effort no throw', () => {
    seedTemplateRun('run_gone', 'tpl_g', true);
    // no dir, no evidence
    seedTemplateRun('run_new', 'tpl_g', false);
    expect(prunePreviousRunArtifacts({ db, artifactsDir: tmp }, { templateId: 'tpl_g' }, 'run_new')).toBe('run_gone');
  });
});
