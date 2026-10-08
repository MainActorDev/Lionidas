/** Artifact retention (Phase 2 T1, plan 20261008T103310Z): keep-last-N per
 *  project with EVIDENCE IMMUNITY — never delete an artifact a run row
 *  references, never the newest passing build. The .ipa file + its package
 *  claim go; the build ROW stays (history), artifact_path nulled — the same
 *  semantics as smoke-crash rows. Runs after each build settles and once at
 *  boot (wrapped by the caller; failure never blocks either). */
import type Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';

const DEFAULT_RETENTION = 10;

export interface RetentionReport {
  projectId: string;
  projectName: string;
  deleted: string[]; // artifact paths removed this pass
}

/** Apply retention for one project (or all when omitted). */
export function enforceRetention(db: Database.Database, projectId?: string): RetentionReport[] {
  const projects = (projectId
    ? db.prepare('SELECT id, name, retention FROM projects WHERE id = ?').all(projectId)
    : db.prepare('SELECT id, name, retention FROM projects').all()) as Array<{ id: string; name: string; retention: number | null }>;
  const reports: RetentionReport[] = [];
  for (const p of projects) {
    const n = p.retention ?? DEFAULT_RETENTION;
    // builds with artifacts, newest first
    const withArtifacts = db.prepare(
      'SELECT id, status, artifact_path FROM builds WHERE project_id = ? AND artifact_path IS NOT NULL ORDER BY started_at DESC',
    ).all(p.id) as Array<{ id: string; status: string; artifact_path: string }>;
    // evidence immunity: any build a run row points at survives
    const referenced = new Set(
      (db.prepare('SELECT DISTINCT build_id FROM runs WHERE build_id IS NOT NULL').all() as Array<{ build_id: string }>).map((r) => r.build_id),
    );
    // newest passing survives even beyond N (one installable good build)
    const newestPassing = withArtifacts.find((b) => b.status === 'passed');
    const keep = new Set<string>();
    for (const [i, b] of withArtifacts.entries()) {
      if (i < n || referenced.has(b.id) || b.id === newestPassing?.id) keep.add(b.id);
    }
    const deleted: string[] = [];
    for (const b of withArtifacts) {
      if (keep.has(b.id)) continue;
      const path = b.artifact_path;
      try { if (existsSync(path)) rmSync(path); } catch { /* already gone / busy — treat as done */ }
      try { db.prepare('DELETE FROM package_owner WHERE package_path = ?').run(path); } catch { /* claim absent */ }
      db.prepare('UPDATE builds SET artifact_path = NULL WHERE id = ?').run(b.id);
      deleted.push(path);
    }
    if (deleted.length > 0) reports.push({ projectId: p.id, projectName: p.name, deleted });
  }
  return reports;
}
