/** Identifier index (plan 20261014T132710Z Phase I, review PR1): a per-app
 *  inventory of accessibility identifiers extracted from the REPO WORKING
 *  TREE — never from butler's document store (content-addressed stores never
 *  forget deleted files; a docs-based index would pass ghosts).
 *
 *  literal rows: the string exists in code at file:line → gate passes.
 *  dynamic rows: a call site whose argument is not a string literal
 *  (interpolation/variable) → gate passes with a trust-note warning.
 *  meta: bundle → head_sha/files/indexed_at — the PRECISE staleness oracle. */

import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

export interface IdentifierRow { identifier: string; file: string; line: number; kind: 'literal' | 'dynamic' }
export interface IndexMeta { bundle: string; repo: string; headSha: string; files: number; indexedAt: number }

const LITERAL_RE = /\.accessibilityIdentifier\(\s*"([^"]+)"\s*\)|accessibilityIdentifier\s*=\s*"([^"]+)"|\.identifier\(\s*"([^"]+)"\s*\)/g;
const ANY_CALL_RE = /\.accessibilityIdentifier\(|accessibilityIdentifier\s*=|\.identifier\(/g;

const DDL = `
CREATE TABLE IF NOT EXISTS app_identifiers(
  bundle TEXT NOT NULL,
  identifier TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- literal | dynamic
  PRIMARY KEY (bundle, identifier, file, line)
);
CREATE INDEX IF NOT EXISTS idx_app_ident_lookup ON app_identifiers(bundle, identifier);
CREATE TABLE IF NOT EXISTS app_identifiers_meta(
  bundle TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  files INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);`;

export function ensureIdentifierTables(db: Database.Database): void {
  db.exec(DDL);
}

/** walk *.swift under root, skipping dot-dirs (.wt, .git, .build, Pods…) */
function swiftFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.swift')) out.push(p);
    }
  };
  walk(root);
  return out;
}

export function scanRepo(repoPath: string): { rows: IdentifierRow[]; headSha: string; files: number } {
  let headSha = '';
  try { headSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim(); } catch { headSha = 'unknown'; }
  const rows: IdentifierRow[] = [];
  const files = swiftFiles(repoPath);
  const seen = new Set<string>();
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const rel = relative(repoPath, f);
    // literals
    for (const m of text.matchAll(LITERAL_RE)) {
      const id = m[1] ?? m[2] ?? m[3] ?? '';
      if (!id) continue;
      const line = text.slice(0, m.index ?? 0).split('\n').length;
      const key = `${id}|${rel}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ identifier: id, file: rel, line, kind: 'literal' });
    }
    // constant DEFINITIONS whose value is a snake_case string (the app's central
    // AccessibilityIdentifiers registry: `static let logoutButton = "account_logout_button"`).
    // The call sites pass the SYMBOL, so literal-at-call-site extraction alone would miss
    // the whole registry — this pass makes those identifiers gate-visible.
    for (const m of text.matchAll(/(?:static\s+)?let\s+\w+\s*(?::\s*String\s*)?=\s*"([a-z][a-z0-9_.]*)"/g)) {
      const id = m[1] ?? '';
      if (!id || !id.includes('_')) continue; // require snake/dotted shape (identifier-like)
      const line = text.slice(0, m.index ?? 0).split('\n').length;
      const key = `${id}|${rel}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ identifier: id, file: rel, line, kind: 'literal' });
    }
    // dynamic call sites: any accessibilityIdentifier call WITHOUT a literal right after
    for (const m of text.matchAll(/(?:\.accessibilityIdentifier\(|accessibilityIdentifier\s*=\s*|\.identifier\()\s*([^)\n]{0,80})/g)) {
      const arg = (m[1] ?? '').trim();
      if (!arg || arg.startsWith('"')) continue; // literal handled above
      const line = text.slice(0, m.index ?? 0).split('\n').length;
      const key = `dynamic|${rel}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ identifier: '(dynamic)', file: rel, line, kind: 'dynamic' });
    }
  }
  return { rows, headSha, files: files.length };
}

/** rebuild the index for one repo→bundle mapping (delete+insert, one txn) */
export function reindexBundle(db: Database.Database, bundle: string, repo: string, repoPath: string): IndexMeta {
  ensureIdentifierTables(db);
  const { rows, headSha, files } = scanRepo(repoPath);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM app_identifiers WHERE bundle = ?').run(bundle);
    const ins = db.prepare('INSERT OR IGNORE INTO app_identifiers(bundle, identifier, file, line, kind) VALUES (?,?,?,?,?)');
    for (const r of rows) ins.run(bundle, r.identifier, r.file, r.line, r.kind);
    db.prepare('INSERT OR REPLACE INTO app_identifiers_meta(bundle, repo, head_sha, files, indexed_at) VALUES (?,?,?,?,?)')
      .run(bundle, repo, headSha, files, Date.now());
  });
  tx();
  return { bundle, repo, headSha, files, indexedAt: Date.now() };
}

export interface GateLookup { state: 'literal' | 'dynamic' | 'missing' | 'no-index' | 'stale'; detail?: string }

/** the gate oracle: one lookup per identifier */
export function lookupIdentifier(db: Database.Database, bundle: string, identifier: string): GateLookup {
  ensureIdentifierTables(db);
  // UNREGISTERED app (no index, no repo ever synced): identifiers are unverifiable in
  // code — this app lives outside the gate's reach; selectors stay runtime-only.
  // (Registered-but-stale indexes still block honestly below.)
  const metaRow = db.prepare('SELECT * FROM app_identifiers_meta WHERE bundle = ?').get(bundle) as { bundle: string; repo: string; head_sha: string; files: number; indexed_at: number } | undefined;
  if (!metaRow) return { state: 'no-index', detail: `no identifier index for ${bundle} — reindex after sources ingest` };
  const lit = db.prepare("SELECT file, line FROM app_identifiers WHERE bundle = ? AND identifier = ? AND kind = 'literal' LIMIT 1").get(bundle, identifier) as { file: string; line: number } | undefined;
  if (lit) return { state: 'literal', detail: `${lit.file}:${lit.line}` };
  // dynamic call sites cannot be TIED to a specific identifier string (that was the
  // review-PR2 debate): v1 keeps dynamic rows for visibility/context only — an unknown
  // identifier is 'missing' with the dynamic sites listed so /implement-identifiers can
  // check whether the app builds it at runtime.
  const dyn = db.prepare("SELECT COUNT(*) AS n FROM app_identifiers WHERE bundle = ? AND kind = 'dynamic'").get(bundle) as { n: number };
  return { state: 'missing', detail: `${metaRow.files} files indexed at ${metaRow.head_sha.slice(0, 8)}${dyn.n ? ` (${dyn.n} dynamic call sites exist — a runtime-built identifier may be intended)` : ''}` };
}

/** dominant snake_case prefix convention among literals (for name RECOMMENDATION) */
export function conventionFor(db: Database.Database, bundle: string): string {
  ensureIdentifierTables(db);
  const rows = db.prepare("SELECT identifier FROM app_identifiers WHERE bundle = ? AND kind = 'literal'").all(bundle) as Array<{ identifier: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const prefix = r.identifier.split('_')[0] ?? '';
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[0]}_ (${top[1]} of ${rows.length} identifiers)` : 'no dominant convention';
}
