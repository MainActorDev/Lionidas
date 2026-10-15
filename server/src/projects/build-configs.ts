/** Recipe store (plan 20261015T021000Z S2, review R1): recipes as server-side
 *  data. Revision chain, append-only — every change is a new revision with
 *  provenance; the ACTIVE recipe is the highest revision not superseded.
 *
 *  Resolution law (engine + detect + canary all obey it):
 *    1. repo-committed lionidas.yml at root — the repo speaks for itself, WINS
 *    2. active row here (the store)
 *    3. legacy .lionidas/lionidas.yml — import nag, not a build source post-migration
 *    4. discovery — NEVER silent: only via explicit user derive (generated row)
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface BuildConfigProvenance {
  by: 'user' | 'ai+user' | 'import' | 'derive';
  at: number;
  source?: string | null;
  evidence?: string[];
}

export interface BuildConfigRow {
  id: string;
  projectId: string;
  revision: number;
  transport: 'repo-lane' | 'generic';
  scheme: string | null;
  configuration: string | null;
  prepare: Array<{ run: string }>;
  generated: boolean;
  provenance: BuildConfigProvenance;
  supersededBy: string | null;
  verifyState: 'unverified' | 'green' | 'failed' | null;
  verifiedAt: number | null;
  createdAt: number;
}

interface RawRow {
  id: string; project_id: string; revision: number; transport: 'repo-lane' | 'generic';
  scheme: string | null; configuration: string | null; prepare_json: string;
  generated: number; provenance_json: string; superseded_by: string | null;
  verify_state: 'unverified' | 'green' | 'failed' | null; verified_at: number | null; created_at: number;
}

function toRow(r: RawRow): BuildConfigRow {
  let prep: Array<{ run: string }> = [];
  let prov: BuildConfigProvenance = { by: 'user', at: r.created_at };
  try { prep = JSON.parse(r.prepare_json) as Array<{ run: string }>; } catch { /* corrupt → empty */ }
  try { prov = { at: r.created_at, ...(JSON.parse(r.provenance_json) as object) } as BuildConfigProvenance; } catch { /* keep default */ }
  return {
    id: r.id, projectId: r.project_id, revision: r.revision, transport: r.transport,
    scheme: r.scheme, configuration: r.configuration, prepare: prep,
    generated: r.generated === 1, provenance: prov, supersededBy: r.superseded_by,
    verifyState: r.verify_state, verifiedAt: r.verified_at, createdAt: r.created_at,
  };
}

/** the ACTIVE recipe = highest revision whose superseded_by is NULL */
export function activeBuildConfig(db: Database.Database, projectId: string): BuildConfigRow | null {
  const row = db.prepare(
    'SELECT * FROM build_configs WHERE project_id = ? AND superseded_by IS NULL ORDER BY revision DESC LIMIT 1',
  ).get(projectId) as RawRow | undefined;
  return row ? toRow(row) : null;
}

export function listBuildConfigRevisions(db: Database.Database, projectId: string): BuildConfigRow[] {
  return (db.prepare('SELECT * FROM build_configs WHERE project_id = ? ORDER BY revision DESC').all(projectId) as RawRow[]).map(toRow);
}

export interface WriteBuildConfig {
  projectId: string;
  transport: 'repo-lane' | 'generic';
  scheme?: string | null;
  configuration?: string | null;
  prepare?: Array<{ run: string }>;
  generated?: boolean;
  provenance: BuildConfigProvenance;
}

/** append the next revision, superseding the current active row — one txn */
export function writeBuildConfigRevision(db: Database.Database, w: WriteBuildConfig): BuildConfigRow {
  const tx = db.transaction((): BuildConfigRow => {
    const prev = db.prepare(
      'SELECT id, revision FROM build_configs WHERE project_id = ? AND superseded_by IS NULL ORDER BY revision DESC LIMIT 1',
    ).get(w.projectId) as { id: string; revision: number } | undefined;
    const id = `rcp_${randomUUID().slice(0, 12)}`;
    const revision = (prev?.revision ?? 0) + 1;
    db.prepare(`INSERT INTO build_configs(id, project_id, revision, transport, scheme, configuration, prepare_json, generated, provenance_json, verify_state, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'unverified',?)`)
      .run(id, w.projectId, revision, w.transport, w.scheme ?? null, w.configuration ?? null,
        JSON.stringify(w.prepare ?? []), w.generated ? 1 : 0, JSON.stringify(w.provenance), Date.now());
    if (prev) db.prepare('UPDATE build_configs SET superseded_by = ? WHERE id = ?').run(id, prev.id);
    return toRow(db.prepare('SELECT * FROM build_configs WHERE id = ?').get(id) as RawRow);
  });
  return tx();
}

/** verify verdict on a revision (S4) — append-only state transition on the row */
export function stampVerify(db: Database.Database, recipeId: string, state: 'green' | 'failed', log: string | null): void {
  db.prepare('UPDATE build_configs SET verify_state = ?, verified_at = ?, verify_log = ? WHERE id = ?')
    .run(state, Date.now(), log, recipeId);
}

/** LAZY BACKFILL (review R1): a project whose columns carry values but has no
 *  recipe row gets one imported on first read — the columns are dead from then on. */
export function backfillBuildConfigFromColumns(db: Database.Database, project: { id: string; build_scheme: string | null; build_configuration: string | null }): BuildConfigRow | null {
  const existing = activeBuildConfig(db, project.id);
  if (existing) return existing;
  if (!project.build_scheme) return null;
  return writeBuildConfigRevision(db, {
    projectId: project.id,
    transport: 'generic',
    scheme: project.build_scheme,
    configuration: project.build_configuration,
    provenance: { by: 'import', at: Date.now(), source: 'projects.build_scheme (lazy backfill, review R1)' },
  });
}
