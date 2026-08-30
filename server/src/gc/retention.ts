/** Evidence retention GC + disk quota (PLAN §11). Nightly + on-boot:
 *  - failure bundles: keep until ticket closed +90d (Jira-aware) — without Jira
 *    integration enabled, age-cap at 180d so GC never depends on an optional
 *    integration (decision §16.4)
 *  - success bundles: 14d
 *  - content dedup by sha256 (already keyed); delete orphaned artifact files
 *  - quota: warn at 80% of budget (default 50GB), PAUSE new runs at 100%
 *    (queue pre-flight checks), VACUUM after GC. */
import { statSync, existsSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

export const QUOTA_BYTES = Number.parseInt(process.env['CRUCIBLE_QUOTA_BYTES'] ?? '', 10) || 50 * 1024 * 1024 * 1024;
const WARN_RATIO = 0.8;
const DAY = 24 * 3600 * 1000;

export interface GcReport {
  deletedEvidence: number;
  deletedFiles: number;
  freedBytes: number;
  usageBytes: number;
  quotaBytes: number;
  warn: boolean;
  paused: boolean;
}

function artifactsBytes(artifactsDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += statSync(p).size; } catch { /* raced */ } }
    }
  };
  walk(artifactsDir);
  return total;
}

export function diskState(artifactsDir: string): { usageBytes: number; warn: boolean; paused: boolean } {
  const usageBytes = artifactsBytes(artifactsDir);
  return {
    usageBytes,
    warn: usageBytes >= QUOTA_BYTES * WARN_RATIO,
    paused: usageBytes >= QUOTA_BYTES,
  };
}

export function runGc(db: Database.Database, artifactsDir: string): GcReport {
  const now = Date.now();
  const jiraEnabled = Boolean(process.env['JIRA_BASE'] && process.env['JIRA_EMAIL'] && process.env['JIRA_TOKEN']);
  const failureKeepMs = jiraEnabled ? 90 * DAY : 180 * DAY;
  const successKeepMs = 14 * DAY;

  let deletedEvidence = 0;
  let deletedFiles = 0;
  let freedBytes = 0;

  const evs = db.prepare('SELECT e.id, e.path, e.bytes, e.created_at, r.status FROM evidence e JOIN runs r ON r.id = e.bundle_id').all() as Array<{
    id: string; path: string; bytes: number; created_at: number; status: string;
  }>;

  const stillReferenced = new Set<string>();
  for (const ev of evs) {
    const keepMs = ev.status === 'passed' ? successKeepMs : failureKeepMs;
    if (now - ev.created_at < keepMs) { stillReferenced.add(ev.id); continue; }
    db.prepare('DELETE FROM evidence WHERE id = ?').run(ev.id);
    // dedup: only delete the file when no other row references the same path
    const other = db.prepare('SELECT 1 FROM evidence WHERE path = ? LIMIT 1').get(ev.path);
    if (!other && existsSync(ev.path)) {
      try {
        freedBytes += statSync(ev.path).size;
        unlinkSync(ev.path);
        deletedFiles++;
      } catch { /* raced */ }
    }
    deletedEvidence++;
  }

  // prune empty run artifact dirs
  try {
    for (const name of readdirSync(artifactsDir)) {
      const dir = join(artifactsDir, name);
      try {
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
      } catch { /* not a dir */ }
    }
  } catch { /* artifacts dir missing */ }

  try { db.exec('VACUUM'); } catch { /* WAL busy — next cycle */ }

  const state = diskState(artifactsDir);
  return {
    deletedEvidence,
    deletedFiles,
    freedBytes,
    usageBytes: state.usageBytes,
    quotaBytes: QUOTA_BYTES,
    warn: state.warn,
    paused: state.paused,
  };
}

export function startGcLoop(db: Database.Database, artifactsDir: string, intervalMs = 24 * 3600 * 1000): () => void {
  const run = (): GcReport => runGc(db, artifactsDir);
  // on-boot pass (async fire — never blocks listen)
  setTimeout(() => { run(); }, 5_000);
  const timer = setInterval(() => { run(); }, intervalMs);
  return () => clearInterval(timer);
}
