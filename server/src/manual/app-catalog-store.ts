/** Last-known installable artifact per bundle id — provenance for the
 *  install feature. Writers: install route, queued-runner path. Reader:
 *  APP_NOT_INSTALLED payload + sidebar install section. */
import type Database from 'better-sqlite3';

export interface LastArtifact {
  bundleId: string;
  artifactPath: string;
  artifactSha: string | null;
  appVersion: string | null;
  recordedAt: number;
}

interface Row {
  bundle_id: string;
  artifact_path: string;
  artifact_sha: string | null;
  app_version: string | null;
  recorded_at: number;
}

export function lastArtifactFor(db: Database.Database, bundleId: string): LastArtifact | null {
  const row = db
    .prepare('SELECT bundle_id, artifact_path, artifact_sha, app_version, recorded_at FROM app_catalog WHERE bundle_id = ?')
    .get(bundleId) as Row | undefined;
  if (!row) return null;
  return {
    bundleId: row.bundle_id,
    artifactPath: row.artifact_path,
    artifactSha: row.artifact_sha,
    appVersion: row.app_version,
    recordedAt: row.recorded_at,
  };
}

export function recordArtifact(
  db: Database.Database,
  entry: { bundleId: string; artifactPath: string; artifactSha?: string | null; appVersion?: string | null },
): void {
  db.prepare(
    `INSERT INTO app_catalog(bundle_id, artifact_path, artifact_sha, app_version, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bundle_id) DO UPDATE SET
       artifact_path = excluded.artifact_path,
       artifact_sha  = excluded.artifact_sha,
       app_version   = excluded.app_version,
       recorded_at   = excluded.recorded_at`,
  ).run(entry.bundleId, entry.artifactPath, entry.artifactSha ?? null, entry.appVersion ?? null, Date.now());
}
