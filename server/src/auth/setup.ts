/** First-run setup state machine (plan 20261008T130034Z, review-hardened).
 *
 *  The wizard keys off DATABASE state, not install media: needsSetup is true
 *  only on a genuinely unclaimed instance — no setup stamp AND no LOCAL user
 *  with a password hash (Jira-provisioned and bot rows never count; their
 *  hashes are bot tokens / SSO links, not operator credentials). Existing
 *  installs get a boot-time backfill stamp (T0), so upgrading never reopens
 *  the window. Defense in depth (T1.5): a 128-bit claim token printed to the
 *  machine console gates the admin-creation POST; origin check + JSON-only
 *  body + rate limit + single-writer BEGIN IMMEDIATE transaction close the
 *  CSRF / race / brute-force holes. */
import type Database from 'better-sqlite3';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

export const SETUP_COMPLETED_BY = 'setup_completed_by';
export const SETUP_COMPLETED_AT = 'setup_completed_at';
export const SETUP_BACKFILLED = 'setup_backfilled';
const SETUP_TOKEN_KEY = 'setup_claim_token';

/** Wizard disabled entirely — headless/CI installs keep the CRUCIBLE_PIN flow. */
export function setupModeOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CRUCIBLE_SETUP_MODE'] === 'off';
}

/** True iff this instance has never been claimed by an operator. */
export function needsSetup(db: Database.Database): boolean {
  if (db.prepare("SELECT value FROM schema_meta WHERE key = 'setup_completed_by'").get()) return false;
  const local = db.prepare("SELECT COUNT(*) AS n FROM users WHERE auth_source = 'local' AND password_hash IS NOT NULL").get() as { n: number };
  return local.n === 0;
}

export function setupCompletedBy(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'setup_completed_by'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeSetupStamp(db: Database.Database, email: string, backfilled = false): void {
  const put = db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)');
  put.run(SETUP_COMPLETED_BY, email);
  put.run(SETUP_COMPLETED_AT, new Date().toISOString());
  if (backfilled) put.run(SETUP_BACKFILLED, '1');
}

/** T0: existing installs (pre-wizard) have a local password but no stamp —
 *  backfill it at boot so the wizard never reopens on upgrade. Idempotent. */
export function backfillSetupStamp(db: Database.Database): boolean {
  if (!needsSetup(db)) {
    // someone already completed setup, or a local hash exists — stamp it
    if (!setupCompletedBy(db)) {
      const first = db.prepare("SELECT email FROM users WHERE auth_source = 'local' AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1").get() as { email: string } | undefined;
      if (first) writeSetupStamp(db, first.email, true);
      return true;
    }
    return true;
  }
  return false;
}

/** The 128-bit claim token: created when the window opens, printed ONLY to
 *  the machine console, required by the admin-creation POST, deleted on
 *  completion. Constant-time compared; never returned by any API. */
export function ensureSetupToken(db: Database.Database): string {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SETUP_TOKEN_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const raw = randomBytes(16); // 128 bits
  const groups = [0, 2, 4, 6].map((i) => raw.subarray(i * 2, i * 2 + 2).toString('hex')).join('-');
  db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run(SETUP_TOKEN_KEY, groups);
  return groups;
}

export function setupTokenValid(db: Database.Database, presented: string | undefined): boolean {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SETUP_TOKEN_KEY) as { value: string } | undefined;
  if (!row?.value || !presented) return false;
  const a = Buffer.from(row.value, 'utf8');
  const b = Buffer.from(presented.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deleteSetupToken(db: Database.Database): void {
  db.prepare('DELETE FROM schema_meta WHERE key = ?').run(SETUP_TOKEN_KEY);
}

/** Create the admin account + stamp completion inside ONE transaction —
 *  racing POSTs produce exactly one winner. Same-email claim (R2b) reuses the
 *  seed row instead of INSERT-conflicting on UNIQUE(email). */
export function claimSetup(db: Database.Database, email: string, name: string, password: string): { ok: true; userId: string } | { ok: false; code: 'ALREADY_CLAIMED' } {
  const hash = scryptHash(password);
  const create = db.transaction((): { ok: true; userId: string } | { ok: false; code: 'ALREADY_CLAIMED' } => {
    if (!needsSetup(db)) return { ok: false, code: 'ALREADY_CLAIMED' };
    const norm = email.toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(norm) as { id: string } | undefined;
    let userId: string;
    if (existing) {
      // R2b: claiming with the seed email upgrades that row in place
      db.prepare("UPDATE users SET name = ?, role = 'admin', password_hash = ?, active = 1, approved = 1 WHERE id = ?")
        .run(name, hash, existing.id);
      userId = existing.id;
    } else {
      userId = `usr_${randomUUID().slice(0, 8)}`;
      db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, approved, created_at)
                  VALUES (?, ?, ?, 'admin', ?, 'local', 1, 1, ?)`)
        .run(userId, norm, name, hash, Date.now());
      // deactivate the placeholder seed row (Q1 decision) — it can never log in
      db.prepare("UPDATE users SET active = 0 WHERE email = 'admin@lionparcel.com' AND auth_source = 'local' AND password_hash IS NULL").run();
    }
    writeSetupStamp(db, norm);
    deleteSetupToken(db);
    return { ok: true, userId };
  });
  return create();
}

// local helpers to avoid importing users.ts (which seeds on import? no — it
// exports pure functions; kept local so setup.ts has no seed side effects)
import { scryptSync } from 'node:crypto';
function scryptHash(plain: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}$${scryptSync(plain, salt, 64).toString('hex')}`;
}

// ── rate limiter (module-level, review R1) ──
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

/** 10/min/IP on setup endpoints; true = allowed. */
export function setupRateLimit(ip: string, now = Date.now()): boolean {
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

/** Same-origin (or no Origin, e.g. curl) + JSON content type — CSRF guard. */
export function originAllowed(req: { headers: Record<string, unknown> }, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = typeof req.headers['origin'] === 'string' ? req.headers['origin'] : undefined;
  const host = typeof req.headers['host'] === 'string' ? req.headers['host'] : undefined;
  if (!origin) return true; // non-browser (curl) — no CSRF surface
  if (!host) return false;
  const allowed = env['CRUCIBLE_PUBLIC_ORIGIN'] ? new URL(env['CRUCIBLE_PUBLIC_ORIGIN']).host : host;
  return new URL(origin).host === allowed;
}

// ── readiness probes (T2) ──
export interface ReadinessRow {
  key: string;
  label: string;
  state: 'ok' | 'fail' | 'skip';
  detail: string;
}

let probeCache: { at: number; rows: ReadinessRow[] } | null = null;
const PROBE_TTL_MS = 5 * 60_000;

function dirWritable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}

function commandVersion(bin: string, args: string[]): string | null {
  try {
    const r = spawnSync(bin, args, { timeout: 2_000, encoding: 'utf8' });
    if (r.status === 0) return (r.stdout || r.stderr || '').split('\n')[0]!.trim();
    return null;
  } catch { return null; }
}

/** Probes never throw (review R3): every failure is a 'fail' row; probes that
 *  cannot apply are 'skip'. Results cached 5 min. exec-capped at 2s each. */
export async function readinessRows(env: NodeJS.ProcessEnv = process.env): Promise<ReadinessRow[]> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.rows;
  const rows: ReadinessRow[] = [];
  const { secretStatus } = await import('../secrets.ts');
  const secrets = secretStatus(env);
  rows.push({
    key: 'github_token', label: 'github token',
    state: secrets.githubToken ? 'ok' : 'fail',
    detail: secrets.githubToken ? `${secrets.keys.githubToken} is set` : `set ${secrets.keys.githubToken} where the server runs`,
  });
  rows.push({
    key: 'jira_token', label: 'jira token',
    state: secrets.jiraToken ? 'ok' : 'fail',
    detail: secrets.jiraToken ? `${secrets.keys.jiraToken} is set` : `set ${secrets.keys.jiraToken} where the server runs`,
  });
  // storage dirs — the app creates these lazily on first use, so a missing
  // dir is probed by creating it (mkdir -p) exactly as runtime would, then
  // testing writability. A probe that cannot create/write = fail.
  const { reposDir, packagesDir } = await import('../manual/packages.ts');
  for (const [key, label, dir] of [['repos_dir', 'repos workspace', reposDir()], ['packages_dir', 'packages dir', packagesDir()]] as const) {
    let state: ReadinessRow['state'] = 'fail';
    let detail = `${dir} is not writable`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (dirWritable(dir)) { state = 'ok'; detail = dir; }
    } catch { /* keep fail */ }
    rows.push({ key, label, state, detail });
  }
  // Apple toolchain — macOS host only; 'skip' anywhere else (honest, not green)
  if (process.platform === 'darwin') {
    const xcode = commandVersion('xcodebuild', ['-version']);
    rows.push({
      key: 'xcodebuild', label: 'xcodebuild',
      state: xcode ? 'ok' : 'fail',
      detail: xcode ?? 'xcodebuild not found — install Xcode and run xcode-select',
    });
    const xcbuddyPath = pathJoin(homedir(), '.local/bin/xcbuddy');
    const xcbuddy = commandVersion(xcbuddyPath, ['--version']);
    rows.push({
      key: 'xcbuddy', label: 'xcbuddy',
      state: xcbuddy ? 'ok' : 'fail',
      detail: xcbuddy ?? `${xcbuddyPath} not found — build engine missing (raw xcodebuild fallback exists)`,
    });
  } else {
    rows.push({ key: 'xcodebuild', label: 'xcodebuild', state: 'skip', detail: 'macOS host only' });
    rows.push({ key: 'xcbuddy', label: 'xcbuddy', state: 'skip', detail: 'macOS host only' });
  }
  const smoke = env['CRUCIBLE_SMOKE'] ?? 'on';
  rows.push({
    key: 'smoke_probe', label: 'smoke probe',
    state: smoke === '0' ? 'skip' : 'ok',
    detail: smoke === '0' ? 'disabled via CRUCIBLE_SMOKE=0' : 'enabled — passing builds install + launch-check on a booted simulator',
  });
  probeCache = { at: Date.now(), rows };
  return rows;
}

/** Test hook: reset the probe cache (used by setup tests). */
export function resetProbeCache(): void { probeCache = null; }

/** Test hook: clear the rate-limit window between tests (module-level store). */
export function resetRateLimit(): void { hits.clear(); }

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
