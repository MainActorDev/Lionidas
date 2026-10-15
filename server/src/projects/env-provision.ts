/** env_config.provision backing (plan 20261015T164500Z A1, review R1):
 *  copies gitignored env-config files that already exist on this machine into a
 *  project's workspace clone — cp semantics, NEVER contents.
 *
 *  HARD SAFETY (R1 — the copy itself was an exfiltration vector):
 *  - *.xcconfig allowlist ONLY; exact filenames; refuse any name with a path
 *    separator; refuse credential-looking names loudly
 *  - sources are REGISTERED dirs only; a provisioning LEDGER records every
 *    placement (the status page shows what the agent placed) */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const ALLOWED_EXT = '.xcconfig';
const REFUSE_PATTERNS = [/\.p8$/i, /\.p12$/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^\.env/i, /^\.git/i];

export interface ProvisionOutcome {
  copied: Array<{ file: string; sha256: string; bytes: number; from: string }>;
  missing: string[];
  conflicts: Array<{ file: string; existingSha: string; sourceSha: string }>;
  refused: Array<{ file: string; reason: string }>;
}

/** registered source dirs for a project name — the ONLY places we copy from */
export function envConfigSources(projectName: string): string[] {
  const dirs: string[] = [];
  const perProject = join(homedir(), '.lionidas', 'env-configs', projectName);
  if (existsSync(perProject)) dirs.push(perProject);
  // sibling dev-checkout convention on this machine (explicit, not a glob walk)
  const sibling = join(homedir(), 'Developer', 'w0rk', 'lionparcel', projectName);
  if (existsSync(sibling)) dirs.push(sibling);
  return dirs;
}

function shaOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

/** validate one requested name — returns a refusal reason or null */
export function validateName(name: string): string | null {
  if (name.includes('/') || name.includes('\\')) return 'path separators are not allowed — exact filenames only';
  if (basename(name) !== name) return 'not a plain filename';
  if (!name.toLowerCase().endsWith(ALLOWED_EXT)) return `allowlist: only *${ALLOWED_EXT} files`;
  for (const re of REFUSE_PATTERNS) if (re.test(name)) return 'credential-looking name refused';
  return null;
}

export function ensureProvisionLedger(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS provisioned_files(
    project_id TEXT NOT NULL,
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    from_dir TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (project_id, file)
  );`);
}

export function provisionEnvConfigs(
  db: Database.Database,
  projectId: string,
  projectName: string,
  workspace: string,
  files: string[],
  opts?: { force?: boolean },
): ProvisionOutcome {
  ensureProvisionLedger(db);
  const out: ProvisionOutcome = { copied: [], missing: [], conflicts: [], refused: [] };
  const sources = envConfigSources(projectName);
  for (const raw of files) {
    const name = String(raw).trim();
    const refusal = validateName(name);
    if (refusal) { out.refused.push({ file: name, reason: refusal }); continue; }
    const src = sources.map((d) => join(d, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
    if (!src) { out.missing.push(name); continue; }
    const srcSha = shaOf(src);
    const dst = join(workspace, name);
    if (existsSync(dst)) {
      const dstSha = shaOf(dst);
      if (dstSha === srcSha) {
        // idempotent no-op — still ledger it as current
        db.prepare('INSERT OR REPLACE INTO provisioned_files(project_id, file, sha256, from_dir, at) VALUES (?,?,?,?,?)')
          .run(projectId, name, srcSha, sources.find((d) => src.startsWith(d)) ?? '', Date.now());
        out.copied.push({ file: name, sha256: srcSha, bytes: statSync(src).size, from: 'already-current' });
        continue;
      }
      if (!opts?.force) { out.conflicts.push({ file: name, existingSha: dstSha, sourceSha: srcSha }); continue; }
    }
    copyFileSync(src, dst);
    db.prepare('INSERT OR REPLACE INTO provisioned_files(project_id, file, sha256, from_dir, at) VALUES (?,?,?,?,?)')
      .run(projectId, name, srcSha, sources.find((d) => src.startsWith(d)) ?? '', Date.now());
    out.copied.push({ file: name, sha256: srcSha, bytes: statSync(dst).size, from: sources.find((d) => src.startsWith(d)) ?? '' });
  }
  return out;
}
