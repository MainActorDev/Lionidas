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
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getProject } from './store.ts';
import { claimPackage } from './store.ts';
import { readBuildManifest, type BuildManifest } from './manifest.ts';
import { discoverAppInputs, type DiscoveredInputs } from './discovery.ts';
import { packagesDir, projectWorkspace } from '../manual/packages.ts';
import { readIpaIdentity } from '../manual/packages.ts';

const BUILD_TIMEOUT_MS = 45 * 60_000;

export interface BuildRow {
  id: string; projectId: string; number: number;
  status: 'running' | 'passed' | 'failed';
  transport: 'repo-lane' | 'generic';
  scheme: string | null; configuration: string | null; resolution: string | null;
  startedAt: number; finishedAt: number | null;
  logPath: string | null;
  artifactPath: string | null; error: string | null;
}

interface RawBuild {
  id: string; project_id: string; number: number; status: BuildRow['status'];
  transport: BuildRow['transport']; scheme: string | null; configuration: string | null; resolution: string | null; started_at: number;
  finished_at: number | null; log_path: string | null; artifact_path: string | null; error: string | null;
}

function row(r: RawBuild): BuildRow {
  return {
    id: r.id, projectId: r.project_id, number: r.number, status: r.status,
    transport: r.transport, scheme: r.scheme, configuration: r.configuration ?? null, resolution: r.resolution ?? null, startedAt: r.started_at,
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
  // ── input resolution (plan T4): manifest > registry > discovery ──
  // manifest errors (strict schema) fail the build BEFORE any compile.
  let manifest: BuildManifest | null = null;
  if (transport === 'generic') {
    try {
      manifest = readBuildManifest(ws);
    } catch (e) {
      // strict schema: a repo that speaks must be heard — a typo never
      // silently falls through to guessing
      const msg = e instanceof Error ? e.message : String(e);
      try { appendFileSync(logPath, `✕ ${msg}\n`); } catch { /* best-effort */ }
      const errId = `bld_${randomUUID().slice(0, 12)}`;
      const errNum = ((db.prepare('SELECT MAX(number) AS n FROM builds WHERE project_id = ?').get(projectId) as { n: number | null })?.n ?? 0) + 1;
      db.prepare(`INSERT INTO builds(id, project_id, number, status, transport, started_at, log_path, error)
                  VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`)
        .run(errId, projectId, errNum, transport, Date.now(), join(artifactsDir(), `${errId}.log`), msg);
      return { ok: false, code: 'PROJECT_NOT_FOUND', error: msg };
    }
  }
  const regScheme = (proj as { buildScheme?: string | null }).buildScheme ?? null;
  const regConfig = (proj as { buildConfiguration?: string | null }).buildConfiguration ?? null;
  // best-effort sync discovery for the immediate response; xcodegen repos
  // discover later (post-generate) inside runGeneric and UPDATE the row.
  let discr: DiscoveredInputs | null = null;
  if (transport === 'generic') {
    try { discr = discoverAppInputs(ws); } catch { discr = null; }
  }
  const resolveInput = (m: string | null, r: string | null, d: (() => string | null) | null): { value: string | null; from: 'manifest' | 'registry' | 'discovered' | null } => {
    if (m) return { value: m, from: 'manifest' };
    if (r) return { value: r, from: 'registry' };
    const v = d?.() ?? null;
    return { value: v, from: v ? 'discovered' : null };
  };
  let schemeFrom = resolveInput(manifest?.scheme ?? null, regScheme, discr ? () => (discr.appSchemes.length === 1 ? discr.appSchemes[0]! : null) : null);
  // AMBIGUITY: 2+ app schemes and neither manifest nor registry pinned one
  if (schemeFrom.value == null && discr && discr.appSchemes.length > 1) {
    const err = `SCHEME_AMBIGUOUS: ${discr.appSchemes.length} app schemes found (${discr.appSchemes.join(', ')}) — pin one via lionidas.yml or the project's build inputs`;
    try { appendFileSync(logPath, `✕ ${err}\n`); } catch { /* best-effort */ }
    db.prepare(`INSERT INTO builds(id, project_id, number, status, transport, scheme, started_at, log_path, error)
                VALUES (?, ?, ?, 'failed', ?, NULL, ?, ?, ?)`)
      .run(id, projectId, number, transport, Date.now(), logPath, err);
    running.delete(projectId); runningBuildIds.delete(projectId);
    return { ok: false, code: 'BUILD_RUNNING', error: err };
  }
  const scheme = schemeFrom.value;
  const configFrom = resolveInput(manifest?.configuration ?? null, regConfig, discr ? () => (discr.configurations.includes('Debug') ? 'Debug' : discr.configurations[0] ?? null) : null);
  const configuration = configFrom.value;
  const resolution = JSON.stringify({ scheme: schemeFrom.from, configuration: configFrom.from });
  db.prepare(`INSERT INTO builds(id, project_id, number, status, transport, scheme, configuration, resolution, started_at, log_path)
              VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, number, transport, scheme, configuration, resolution, Date.now(), logPath);
  const log = (line: string): void => { try { appendFileSync(logPath, `${line}\n`); } catch { /* log best-effort */ } };
  log(`# build ${number} · ${proj.name} · transport=${transport}${scheme ? ` · scheme=${scheme}` : ''}${configuration ? ` · config=${configuration}` : ''}`);
  log(`# inputs: ${resolution}${manifest ? ' · manifest=present' : ''}`);

  const p = (async (): Promise<void> => {
    // DB writes are guarded: the caller (route/tests) may close the handle
    // while a long build still settles — never let that throw unhandled.
    const safeDb = (fn: () => void): void => { try { fn(); } catch { /* db closed mid-build — status stays as-is */ } };
    try {
      const ipaPath = transport === 'repo-lane'
        ? await runRepoLane(ws, log)
        : await runGeneric(ws, scheme, configuration, log, (s) => safeDb(() => db.prepare('UPDATE builds SET scheme = ? WHERE id = ?').run(s, id)));
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

/** Locate an executable on PATH (server PATH + ~/.local/bin for user tools). */
function which(bin: string): string | null {
  const dirs = `${process.env.PATH ?? ''}${delimiter}${join(process.env.HOME ?? '/root', '.local', 'bin')}`.split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin);
    try { if (statSync(p).isFile() && (statSync(p).mode & 0o111) !== 0) return p; } catch { /* next */ }
  }
  return null;
}

function hasXcodeproj(ws: string): boolean {
  try { return readdirSync(ws).some((f) => f.endsWith('.xcodeproj')); } catch { return false; }
}

async function runGeneric(ws: string, scheme: string | null, configuration: string | null, log: (l: string) => void, onScheme?: (s: string) => void): Promise<string> {
  const conf = configuration ?? 'Debug';
  // xcodegen FIRST: project.yml-only repos have no schemes until the
  // .xcodeproj is generated (discovery before generate finds nothing).
  if (existsSync(join(ws, 'project.yml')) && !hasXcodeproj(ws)) {
    log('$ xcodegen generate');
    await runCommand('xcodegen', ['generate'], ws, log, 5 * 60_000);
    if (!scheme) {
      const d = discoverAppInputs(ws);
      scheme = d.appSchemes.length === 1 ? d.appSchemes[0]! : null;
      if (scheme) { log(`# scheme discovered: ${scheme}`); onScheme?.(scheme); }
      else if (d.appSchemes.length > 1) throw new Error(`SCHEME_AMBIGUOUS: ${d.appSchemes.length} app schemes found (${d.appSchemes.join(', ')}) — pin one via lionidas.yml or the project's build inputs`);
    }
  }
  if (!scheme) throw new Error('no scheme discovered — xcodebuild -list returned nothing');
  // PREFLIGHT (seconds, pre-compile — plan T4.6): the resolved scheme and
  // configuration must exist; a wrong input dies here, not 15 minutes in.
  const pre = ['-showBuildSettings', '-scheme', scheme, '-sdk', 'iphonesimulator', '-configuration', conf];
  log(`$ xcodebuild ${pre.join(' ')} (preflight)`);
  try {
    await runCommand('xcodebuild', pre, ws, () => undefined, 120_000);
    log('# preflight OK');
  } catch (e) {
    const avail = discoverAppInputs(ws);
    throw new Error(`preflight failed for scheme "${scheme}" / configuration "${conf}"${avail.appSchemes.length ? ` — available app schemes: ${avail.appSchemes.join(', ')}` : ''}: ${e instanceof Error ? e.message.split('\n').pop() : String(e)}`);
  }
  // UNLOCKED resolve pass first: a freshly xcodegen'd project has no
  // Package.resolved in its workspace (and a repo-committed one may be
  // stale) — locked builds (-disableAutomaticPackageResolution, which
  // xcbuddy injects in isolated mode) fail without it. Resolve once here,
  // warm .spm-clones, then the locked build is deterministic.
  const resolveArgs = ['-resolvePackageDependencies', '-clonedSourcePackagesDirPath', join(ws, '.spm-clones')];
  log(`$ xcodebuild ${resolveArgs.join(' ')}`);
  await runCommand('xcodebuild', resolveArgs, ws, log, 15 * 60_000);
  // xcbuddy (Lionidas internal tool): a friendly xcodebuild wrapper that
  // auto-resolves the SPM graph, auto-injects isolated caches (.derived-data/
  // .spm-clones/ in the repo — exactly our convention), fuzzy-matches
  // simulators, and emits a JSON failure envelope. Preferred when present;
  // raw xcodebuild is the fallback for tool-less environments.
  const xcbuddy = which('xcbuddy');
  const dd = join(ws, '.derived-data');
  if (xcbuddy) {
    const args = ['build', '--scheme', scheme, '--json'];
    log(`$ xcbuddy ${args.join(' ')} (auto: isolated caches, sim destination; config via project defaults)`);
    await runCommand(xcbuddy, args, ws, log);
  } else {
    const args = [
      '-scheme', scheme, '-sdk', 'iphonesimulator', '-configuration', conf,
      '-derivedDataPath', dd,
      '-clonedSourcePackagesDirPath', join(ws, '.spm-clones'),
      '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-skipPackageUpdates',
      'build',
    ];
    log(`$ xcodebuild ${args.join(' ')}`);
    await runCommand('xcodebuild', args, ws, log);
  }
  const products = join(dd, 'Build', 'Products', `${conf}-iphonesimulator`);
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
