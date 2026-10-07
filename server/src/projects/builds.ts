/** CI builds (plan 20261007T054500Z): build a registered project's clone into
 *  a SIMULATOR .ipa that lands in the packages dir, auto-claimed to the
 *  project. Transport (decision Q1=C): prefer the repo's own build lane —
 *  scripts/build-sim.sh, else fastlane build_sim (only when a Gemfile backs
 *  it) — else the generic path (xcodegen + auto-discovered scheme +
 *  xcodebuild -sdk iphonesimulator + zip Payload/).
 *
 *  Execution: spawn (long builds), log appended to
 *  artifacts/builds/<id>.log, per-project serial queue, 45-min kill timeout.
 *  Wrong-platform artifacts fail with the named reason (guard parity). */
import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getProject } from './store.ts';
import { claimPackage } from './store.ts';
import { packagesDir, projectWorkspace } from '../manual/packages.ts';
import { readIpaIdentity } from '../manual/packages.ts';

const BUILD_TIMEOUT_MS = 45 * 60_000;

export interface BuildRow {
  id: string; projectId: string; number: number; status: 'running' | 'passed' | 'failed';
  transport: 'repo-lane' | 'generic'; scheme: string | null;
  startedAt: number; finishedAt: number | null; logPath: string | null;
  artifactPath: string | null; error: string | null;
}

interface RawBuild {
  id: string; project_id: string; number: number; status: BuildRow['status'];
  transport: BuildRow['transport']; scheme: string | null; started_at: number;
  finished_at: number | null; log_path: string | null; artifact_path: string | null; error: string | null;
}

function row(r: RawBuild): BuildRow {
  return {
    id: r.id, projectId: r.project_id, number: r.number, status: r.status,
    transport: r.transport, scheme: r.scheme, startedAt: r.started_at,
    finishedAt: r.finished_at, logPath: r.log_path, artifactPath: r.artifact_path, error: r.error,
  };
}

export function listBuilds(db: Database.Database, projectId?: string): Array<BuildRow & { projectName: string }> {
  const sql = projectId
    ? `SELECT b.*, p.name AS project_name FROM builds b JOIN projects p ON p.id = b.project_id WHERE b.project_id = ? ORDER BY b.started_at DESC`
    : `SELECT b.*, p.name AS project_name FROM builds b JOIN projects p ON p.id = b.project_id ORDER BY b.started_at DESC`;
  const rows = (projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all()) as Array<RawBuild & { project_name: string }>;
  return rows.map((r) => ({ ...row(r), projectName: r.project_name }));
}

export function getBuild(db: Database.Database, id: string): BuildRow | null {
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as RawBuild | undefined;
  return r ? row(r) : null;
}

export function buildLog(id: string, fromBytes = 0): string {
  const p = join(artifactsDir(), `${id}.log`);
  try {
    const fd = readFileSync(p);
    return fd.subarray(fromBytes).toString();
  } catch { return ''; }
}
export function logSize(id: string): number {
  try { return statSync(join(artifactsDir(), `${id}.log`)).size; } catch { return 0; }
}

function artifactsDir(): string {
  const d = process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts';
  return join(d, 'builds');
}

// ── per-project serial queue ──
const running = new Map<string, Promise<void>>();
const runningBuildIds = new Map<string, string>();

export type StartResult =
  | { ok: true; build: BuildRow }
  | { ok: false; code: 'PROJECT_NOT_FOUND' | 'CLONE_FIRST' | 'BUILD_RUNNING'; error: string };

export function startBuild(db: Database.Database, projectId: string): StartResult {
  const proj = getProject(db, projectId);
  if (!proj) return { ok: false, code: 'PROJECT_NOT_FOUND', error: 'project not found' };
  const ws = projectWorkspace(proj.name);
  if (!existsSync(join(ws, '.git'))) return { ok: false, code: 'CLONE_FIRST', error: `no workspace at ${ws} — clone the project first` };
  if (running.has(projectId)) {
    const rid = runningBuildIds.get(projectId);
    const cur = rid ? db.prepare('SELECT number FROM builds WHERE id = ?').get(rid) as { number: number } | undefined : undefined;
    return { ok: false, code: 'BUILD_RUNNING', error: `build #${cur?.number ?? '?'} is already running for this project` };
  }
  const number = ((db.prepare('SELECT MAX(number) AS n FROM builds WHERE project_id = ?').get(projectId) as { n: number | null })?.n ?? 0) + 1;
  const id = `bld_${randomUUID().slice(0, 12)}`;
  mkdirSync(artifactsDir(), { recursive: true });
  const logPath = join(artifactsDir(), `${id}.log`);
  const transport = pickTransport(ws);
  const scheme = transport === 'generic' ? discoverScheme(ws) : null;
  db.prepare(`INSERT INTO builds(id, project_id, number, status, transport, scheme, started_at, log_path)
              VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(id, projectId, number, transport, scheme, Date.now(), logPath);
  const log = (line: string): void => { try { appendFileSync(logPath, `${line}\n`); } catch { /* log best-effort */ } };
  log(`# build ${number} · ${proj.name} · transport=${transport}${scheme ? ` · scheme=${scheme}` : ''}`);

  const p = (async (): Promise<void> => {
    // DB writes are guarded: the caller (route/tests) may close the handle
    // while a long build still settles — never let that throw unhandled.
    const safeDb = (fn: () => void): void => { try { fn(); } catch { /* db closed mid-build — status stays as-is */ } };
    try {
      const ipaPath = transport === 'repo-lane'
        ? await runRepoLane(ws, log)
        : await runGeneric(ws, scheme, log);
      // platform guard parity: reject device/macos artifacts
      const idn = readIpaIdentity(ipaPath);
      if (!idn) throw new Error(`cannot read identity from built artifact ${ipaPath}`);
      if (idn.platform !== 'iphonesimulator') {
        throw new Error(`built .ipa targets ${idn.platform} — the build recipe must produce a simulator slice (-sdk iphonesimulator)`);
      }
      // final home: packages dir, claimed to the project
      const version = idn.version ?? 'unknown';
      const finalName = `${proj.name}-${version}-${number}.ipa`;
      const dest = join(packagesDir(), finalName);
      mkdirSync(packagesDir(), { recursive: true });
      copyFileSync(ipaPath, dest);
      claimPackage(db, dest, projectId);
      log(`✓ artifact → ${dest} (claimed to ${proj.name})`);
      safeDb(() => db.prepare(`UPDATE builds SET status = 'passed', finished_at = ?, artifact_path = ? WHERE id = ?`).run(Date.now(), dest, id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✕ ${msg}`);
      safeDb(() => db.prepare(`UPDATE builds SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`).run(Date.now(), msg.slice(0, 2000), id));
    } finally {
      running.delete(projectId);
      runningBuildIds.delete(projectId);
    }
  })();
  running.set(projectId, p);
  runningBuildIds.set(projectId, id);
  return { ok: true, build: getBuild(db, id)! };
}

function pickTransport(ws: string): 'repo-lane' | 'generic' {
  if (existsSync(join(ws, 'scripts', 'build-sim.sh'))) return 'repo-lane';
  const fastfile = join(ws, 'fastlane', 'Fastfile');
  if (existsSync(fastfile) && existsSync(join(ws, 'Gemfile'))) {
    try {
      if (/lane\s+:build_sim\b/.test(readFileSync(fastfile, 'utf8'))) return 'repo-lane';
    } catch { /* fall through */ }
  }
  return 'generic';
}

/** xcodebuild -list -json → first scheme not ending in Tests. */
function discoverScheme(ws: string): string | null {
  try {
    const out = spawnSyncJson('xcodebuild', ['-list', '-json'], ws) as { project?: { schemes?: string[] } } | null;
    const schemes: string[] = out?.project?.schemes ?? [];
    return schemes.find((s) => !/Tests?$/i.test(s)) ?? schemes[0] ?? null;
  } catch { return null; }
}

function spawnSyncJson(cmd: string, args: string[], cwd: string): unknown {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return JSON.parse(execFileSync(cmd, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).toString());
  } catch { return null; }
}

async function runCommand(cmd: string, args: string[], cwd: string, log: (l: string) => void, timeoutMs = BUILD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let killed = false;
    let tail = '';
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => log(d.toString().trimEnd()));
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trimEnd();
      log(s);
      tail = `${tail}${s}\n`.slice(-2000); // keep the tail for the error message
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) reject(new Error(`timed out after ${Math.round(timeoutMs / 60000)}m`));
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0] ?? ''} exited ${code}${tail ? `: ${tail.trim().split('\n').pop()}` : ''}`));
    });
  });
}

async function runRepoLane(ws: string, log: (l: string) => void): Promise<string> {
  const script = join(ws, 'scripts', 'build-sim.sh');
  if (existsSync(script)) {
    log(`$ scripts/build-sim.sh`);
    await runCommand('sh', [script], ws, log);
  } else {
    log(`$ bundle exec fastlane build_sim`);
    await runCommand('bundle', ['exec', 'fastlane', 'build_sim'], ws, log);
  }
  // the lane contract: leaves a *.ipa (or the path) — find newest in <ws>/build
  const outDir = join(ws, 'build');
  const ipa = newestIpa(outDir) ?? newestIpa(ws);
  if (!ipa) throw new Error('repo lane produced no .ipa (expected in <repo>/build/)');
  return ipa;
}

async function runGeneric(ws: string, scheme: string | null, log: (l: string) => void): Promise<string> {
  if (!scheme) throw new Error('no scheme discovered — xcodebuild -list returned nothing');
  if (existsSync(join(ws, 'project.yml')) && !existsSync(join(ws, '*.xcodeproj'))) {
    log('$ xcodegen generate');
    await runCommand('xcodegen', ['generate'], ws, log, 5 * 60_000);
  }
  // cache conventions (any SPM repo benefits; mirrors the intl repo's rules)
  const dd = join(ws, '.derived-data');
  const args = [
    '-scheme', scheme, '-sdk', 'iphonesimulator', '-configuration', 'Debug',
    '-derivedDataPath', dd,
    '-clonedSourcePackagesDirPath', join(ws, '.spm-clones'),
    '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-skipPackageUpdates',
    'build',
  ];
  log(`$ xcodebuild ${args.join(' ')}`);
  await runCommand('xcodebuild', args, ws, log);
  const products = join(dd, 'Build', 'Products', 'Debug-iphonesimulator');
  let appDir: string | null = null;
  try {
    appDir = readdirSync(products).map((f) => join(products, f)).find((p) => p.endsWith('.app')) ?? null;
  } catch { /* not found below */ }
  if (!appDir) throw new Error(`no .app found under ${products}`);
  // stage + zip Payload/
  const stage = mkdtempSync(join(tmpdir(), 'bld-'));
  try {
    mkdirSync(join(stage, 'Payload'));
    // copy the whole .app bundle
    const { cpSync } = await import('node:fs');
    cpSync(appDir, join(stage, 'Payload', appDir.split('/').pop()!), { recursive: true });
    const ipa = join(stage, 'app.ipa');
    await runCommand('zip', ['-q', '-r', '-X', ipa, 'Payload'], stage, () => undefined, 10 * 60_000);
    // move out of the temp stage into a stable temp the caller copies from
    const stable = join(tmpdir(), `bld-out-${randomUUID().slice(0, 8)}.ipa`);
    copyFileSync(ipa, stable);
    return stable;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function newestIpa(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ipa')).map((f) => join(dir, f));
    if (files.length === 0) return null;
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
  } catch { return null; }
}
