/** Project registry store: one project = one repo (brainstorm
 *  20261005T071623Z). The auth token is stored plaintext (git needs the
 *  value, not a hash — review M1) but this module owns the ONLY projection:
 *  every list/get returns `authSet`, never the token. Do not add raw
 *  SELECT * paths; the test pins the field's absence in route JSON. */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface ProjectRow {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string | null;
  defaultBranch: string | null;
  authSet: boolean;
  buildScheme: string | null;
  buildConfiguration: string | null;
  repoShape: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawRow {
  id: string; name: string; repo_url: string; local_path: string | null;
  default_branch: string | null; auth_token: string | null;
  build_scheme: string | null; build_configuration: string | null; repo_shape: string | null;
  created_at: number; updated_at: number;
}

const COLS = 'id, name, repo_url, local_path, default_branch, auth_token, build_scheme, build_configuration, repo_shape, created_at, updated_at';

function project(r: RawRow): ProjectRow {
  return {
    id: r.id, name: r.name, repoUrl: r.repo_url, localPath: r.local_path,
    defaultBranch: r.default_branch, authSet: r.auth_token != null && r.auth_token.length > 0,
    buildScheme: r.build_scheme ?? null, buildConfiguration: r.build_configuration ?? null, repoShape: r.repo_shape ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listProjects(db: Database.Database): ProjectRow[] {
  return (db.prepare(`SELECT ${COLS} FROM projects ORDER BY name`).all() as RawRow[]).map(project);
}

export function getProject(db: Database.Database, id: string): ProjectRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM projects WHERE id = ?`).get(id) as RawRow | undefined;
  return r ? project(r) : null;
}

export interface ProjectInput {
  name: string;
  repoUrl: string;
  localPath?: string | null;
  defaultBranch?: string | null;
  authToken?: string | null; // null/absent = keep existing on update; '' = clear
  buildScheme?: string | null; // '' / null = clear (input resolution: manifest > registry > discovery)
  buildConfiguration?: string | null;
}

export function createProject(db: Database.Database, input: ProjectInput): ProjectRow {
  const now = Date.now();
  const id = `prj_${randomUUID().slice(0, 12)}`;
  db.prepare(`INSERT INTO projects(id, name, repo_url, local_path, default_branch, auth_token, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.name, input.repoUrl, input.localPath ?? null, input.defaultBranch ?? null, input.authToken ?? null, now, now);
  return getProject(db, id)!;
}

export function updateProject(db: Database.Database, id: string, input: Partial<ProjectInput>): ProjectRow | null {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as RawRow | undefined;
  if (!cur) return null;
  const token = input.authToken === undefined ? cur.auth_token // keep
    : input.authToken === '' || input.authToken === null ? null // explicit clear
    : input.authToken;
  const norm = (v: string | null | undefined, keep: string | null): string | null =>
    v === undefined ? keep : (v === '' ? null : v);
  db.prepare(`UPDATE projects SET name = ?, repo_url = ?, local_path = ?, default_branch = ?, auth_token = ?, build_scheme = ?, build_configuration = ?, updated_at = ? WHERE id = ?`)
    .run(
      input.name ?? cur.name,
      input.repoUrl ?? cur.repo_url,
      input.localPath === undefined ? cur.local_path : (input.localPath || null),
      input.defaultBranch === undefined ? cur.default_branch : (input.defaultBranch || null),
      token,
      norm(input.buildScheme, cur.build_scheme),
      norm(input.buildConfiguration, cur.build_configuration),
      Date.now(),
      id,
    );
  return getProject(db, id);
}

export function deleteProject(db: Database.Database, id: string): boolean {
  // package_owner rides ON DELETE CASCADE (claims die with the project)
  const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return r.changes > 0;
}

/** The token value for future consumers (CI pull / agent clone) — server-side
 *  only; never route this into an API response. */
export function projectAuthToken(db: Database.Database, id: string): string | null {
  const r = db.prepare('SELECT auth_token FROM projects WHERE id = ?').get(id) as { auth_token: string | null } | undefined;
  return r?.auth_token ?? null;
}

// ── package attribution (packages are files; claims map path → project) ──

export function claimPackage(db: Database.Database, packagePath: string, projectId: string): boolean {
  if (!getProject(db, projectId)) return false;
  db.prepare(`INSERT INTO package_owner(package_path, project_id) VALUES (?, ?)
              ON CONFLICT(package_path) DO UPDATE SET project_id = excluded.project_id`)
    .run(packagePath, projectId);
  return true;
}

export function unclaimPackage(db: Database.Database, packagePath: string): void {
  db.prepare('DELETE FROM package_owner WHERE package_path = ?').run(packagePath);
}

/** path → project name map for GET /api/packages to join in. */
export function packageOwners(db: Database.Database, paths: string[]): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  if (paths.length === 0) return out;
  const placeholders = paths.map(() => '?').join(',');
  const rows = db.prepare(`SELECT po.package_path, p.id, p.name FROM package_owner po
                           JOIN projects p ON p.id = po.project_id
                           WHERE po.package_path IN (${placeholders})`).all(...paths) as Array<{ package_path: string; id: string; name: string }>;
  for (const r of rows) out.set(r.package_path, { id: r.id, name: r.name });
  return out;
}
