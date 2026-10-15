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
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getProject } from './store.ts';
import { claimPackage, unclaimPackage } from './store.ts';
import { activeBuildConfig, stampVerify } from './build-configs.ts';
import { readBuildManifest, prepareCommandPath, type BuildManifest, type PrepareStep } from './manifest.ts';
import { smokeTestArtifact } from './smoke.ts';
import { discoverAppInputs, type DiscoveredInputs } from './discovery.ts';
import { packagesDir, projectWorkspace } from '../manual/packages.ts';
import { readIpaIdentity } from '../manual/packages.ts';

const BUILD_TIMEOUT_MS = 45 * 60_000;
const PREPARE_TIMEOUT_MS = 15 * 60_000;

export interface BuildRow {
  id: string; projectId: string; number: number;
  status: 'running' | 'passed' | 'failed';
  transport: 'repo-lane' | 'generic';
  scheme: string | null; configuration: string | null; resolution: string | null; smoke: string | null;
  startedAt: number; finishedAt: number | null;
  logPath: string | null;
  artifactPath: string | null; error: string | null;
}

interface RawBuild {
  id: string; project_id: string; number: number; status: BuildRow['status'];
  transport: BuildRow['transport']; scheme: string | null; configuration: string | null; resolution: string | null; smoke: string | null; started_at: number;
  finished_at: number | null; log_path: string | null; artifact_path: string | null; error: string | null;
}

function row(r: RawBuild): BuildRow {
  return {
    id: r.id, projectId: r.project_id, number: r.number, status: r.status,
    transport: r.transport, scheme: r.scheme, configuration: r.configuration ?? null, resolution: r.resolution ?? null, smoke: r.smoke ?? null, startedAt: r.started_at,
    finishedAt: r.finished_at, logPath: r.log_path, artifactPath: r.artifact_path, error: r.error,
  };
}

export function listBuilds(db: Database.Database, projectId?: string): Array<BuildRow & { projectName: string; suite: { passed: number; failed: number; running: number; total: number; failedNames?: string[] } | null }> {
  const sql = projectId
    ? `SELECT b.*, p.name AS project_name FROM builds b JOIN projects p ON p.id = b.project_id WHERE b.project_id = ? ORDER BY b.started_at DESC`
    : `SELECT b.*, p.name AS project_name FROM builds b JOIN projects p ON p.id = b.project_id ORDER BY b.started_at DESC`;
  const rows = (projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all()) as Array<RawBuild & { project_name: string }>;
  // Phase 1 build→test: suite verdict chip per build — one grouped pass
  // (review R5: queued AND running both count as running). Failed-case names
  // ride separately (first 5) for the chip tooltip.
  const agg = db.prepare(`SELECT build_id,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS p,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS f,
      SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS r,
      COUNT(*) AS t
    FROM runs WHERE build_id IS NOT NULL GROUP BY build_id`).all() as Array<{ build_id: string; p: number; f: number; r: number; t: number }>;
  const failNames = db.prepare(`SELECT r.build_id AS bid, t.name AS n FROM runs r JOIN templates t ON t.id = r.template_id
    WHERE r.build_id IS NOT NULL AND r.status = 'failed'`).all() as Array<{ bid: string; n: string }>;
  const aggBy = new Map(agg.map((a) => [a.build_id, a]));
  const failsBy = new Map<string, string[]>();
  for (const f of failNames) {
    const list = failsBy.get(f.bid) ?? [];
    if (list.length < 5) list.push(f.n);
    failsBy.set(f.bid, list);
  }
  return rows.map((r) => {
    const a = aggBy.get(r.id);
    return {
      ...row(r), projectName: r.project_name,
      suite: a ? { passed: a.p, failed: a.f, running: a.r, total: a.t, ...(failsBy.has(r.id) ? { failedNames: failsBy.get(r.id)! } : {}) } : null,
    };
  });
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

/** Recipe resolution (plan 20261015T021000Z S2, review R4). LAW:
 *  1. repo-committed root lionidas.yml — the repo speaks for itself, WINS
 *  2. active `recipes` row (server-side data) — records resolution {scheme:'recipes', recipeId, revision}
 *  3. legacy .lionidas/lionidas.yml — still readable (import nag), recorded as manifest-legacy
 *  4. discovery — NEVER silent; only reached via explicit derive (a generated recipe row)
 *  Returns the manifest the engine runs plus the resolution provenance stamped on the build row. */
export interface ResolvedBuildConfig {
  manifest: BuildManifest | null;
  resolution: { scheme: string | null; from: 'manifest' | 'manifest-legacy' | 'recipes' | 'registry' | 'discovered' | null };
  recipeId?: string;
  recipeRevision?: number;
}

export function resolveBuildConfig(db: Database.Database, projectId: string, ws: string): ResolvedBuildConfig {
  // 1 — repo-committed root manifest
  if (existsSync(join(ws, 'lionidas.yml'))) {
    try {
      const m = readBuildManifest(ws);
      if (m) return { manifest: m, resolution: { scheme: m.scheme, from: 'manifest' } };
    } catch { /* malformed root manifest falls through to the store */ }
  }
  // 2 — the recipes store
  const row = activeBuildConfig(db, projectId);
  if (row && row.transport === 'generic') {
    return {
      manifest: { scheme: row.scheme, configuration: row.configuration, prepare: row.prepare },
      resolution: { scheme: row.scheme, from: 'recipes' },
      recipeId: row.id,
      recipeRevision: row.revision,
    };
  }
  if (row && row.transport === 'repo-lane') {
    return { manifest: null, resolution: { scheme: null, from: 'recipes' }, recipeId: row.id, recipeRevision: row.revision };
  }
  // 3 — legacy .lionidas manifest (import nag lives in detection/canary, not here)
  try {
    const m = readBuildManifest(ws);
    if (m) return { manifest: m, resolution: { scheme: m.scheme, from: 'manifest-legacy' } };
  } catch { /* none */ }
  // 4 — discovery (caller decides; this function never guesses silently)
  return { manifest: null, resolution: { scheme: null, from: null } };
}

/** Verify build (plan 20261015T021000Z S4, review R7): the compile-only gate as an
 *  on-demand VERDICT for a project's active recipe. Lives HERE to share the
 *  module-private running map + per-project serial lock (mirror of startBuild).
 *  NO scheduler ships (D4) — this fires only on explicit request.
 *  Verdict lands on the recipe revision: green/failed + verified_at + log tail. */
export type VerifyResult =
  | { ok: true; verdict: 'green' | 'failed'; recipeId: string; seconds: number }
  | { ok: false; code: 'PROJECT_NOT_FOUND' | 'CLONE_FIRST' | 'NO_RECIPE' | 'BUSY'; error: string };

/** newest .app under the repo-local products dir (prepare-embedded builds land here
 *  via -derivedDataPath .derived-data conventions; falls back to a scan) */
async function productsAppFor(ws: string): Promise<string> {
  const { readdirSync } = await import('node:fs');
  const base = join(ws, '.derived-data', 'Build', 'Products');
  try {
    for (const conf of readdirSync(base)) {
      const dir = join(base, conf);
      try {
        const app = readdirSync(dir).find((f) => f.endsWith('.app'));
        if (app) return join(dir, app);
      } catch { /* not a dir */ }
    }
  } catch { /* no products yet */ }
  throw new Error('no .app found under .derived-data/Build/Products (prepare chain reported success — check its -derivedDataPath)');
}

// DESTINATION NORMALIZATION: a name-pinned simulator destination rots between
// Xcode versions (iPhone 16 vanished on Xcode 27 → xcodebuild SILENTLY fell
// back to 'My Mac' → platform mismatch instead of 'no such simulator').
// Rewrite name= destinations to the generic sim platform — machine-proof.
const normalizeDest = (cmd: string): string => cmd.replace(
  /(-destination\s+)['"]?platform=iOS Simulator,name=[^'"]+['"]?/g,
  "$1'generic/platform=iOS Simulator'");

export function startBuildVerify(db: Database.Database, projectId: string): VerifyResult {
  const proj = getProject(db, projectId);
  if (!proj) return { ok: false, code: 'PROJECT_NOT_FOUND', error: 'project not found' };
  const row = activeBuildConfig(db, projectId);
  if (!row) return { ok: false, code: 'NO_RECIPE', error: 'no active recipe — derive or import one first' };
  const ws = projectWorkspace(proj.name ?? '');
  if (!ws || !existsSync(join(ws, '.git'))) return { ok: false, code: 'CLONE_FIRST', error: `no workspace at ${ws} — clone first` };
  if (running.has(projectId)) return { ok: false, code: 'BUSY', error: 'a build/verify is already running for this project' };

  const _t0 = Date.now();
  running.set(projectId, (async () => {
    const lines: string[] = [];
    const log = (l: string): void => { lines.push(l); };
    try {
      // PREPARE FIRST (live drill catch: a CocoaPods recipe's 'pod install' must run
      // before any scheme can resolve — compileWorktree alone sees a workspace-less
      // clone and reports 'no scheme discovered'). The recipe's prepare steps are
      // part of the verified claim: verify proves prepare+build together.
      for (const [i, step0] of row.prepare.entries()) {
        const step = /(^|\s)xcodebuild\b/.test(step0.run) ? { run: normalizeDest(step0.run) } : step0;
        log(`$ prepare[${i}]: ${step.run}`);
        await runCommand('sh', ['-c', step.run], ws, log, PREPARE_TIMEOUT_MS, {});
      }
      // skip compileWorktree's own build when the prepare chain already IS the build
      // (agent-authored recipes embed the xcodebuild line as the last prepare step —
      // running it twice is wasted minutes and doubled failure surfaces)
      const lastIsBuild = /(^|\s)(xcodebuild|xcbuddy)/.test(row.prepare[row.prepare.length - 1]?.run ?? '');
      const res = lastIsBuild
        ? { scheme: row.scheme ?? 'recipe', app: await productsAppFor(ws) }
        : await compileWorktree(ws, log);
      stampVerify(db, row.id, 'green', `BUILD OK ${res.scheme} → ${res.app.split('/').pop()}`);
    } catch (err) {
      const tail = lines.slice(-40).join('\n');
      stampVerify(db, row.id, 'failed', `COMPILE FAILED: ${err instanceof Error ? err.message.slice(0, 800) : String(err).slice(0, 800)}\n${tail}`.slice(0, 4000));
    } finally {
      running.delete(projectId);
    }
  })());
  // the async work stamps the verdict; report the accepted start (the UI polls
  // the recipe row for the verdict — same shape as build polling)
  return { ok: true, verdict: 'green', recipeId: row.id, seconds: 0 };
}

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
  // ── input resolution (plan 20261015T021000Z S2): root manifest > recipes store >
  // legacy .lionidas > registry(discovery only via explicit derive) ──
  // manifest errors (strict schema) fail the build BEFORE any compile.
  const resolved = resolveBuildConfig(db, projectId, ws);
  const recipeId = resolved.recipeId ?? null;
  let manifest: BuildManifest | null = resolved.manifest;
  if (transport === 'generic' && !manifest) {
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
  const resolutionFrom = resolved.resolution.from ?? schemeFrom.from;
  const resolution = JSON.stringify({
    scheme: resolutionFrom === 'recipes' ? 'recipes' : schemeFrom.from,
    configuration: configFrom.from,
    ...(recipeId ? { recipeId, recipeRevision: resolved.recipeRevision } : {}),
    ...(resolved.resolution.from === 'manifest-legacy' ? { legacy: true } : {}),
  });
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
      // T2 stamping contract: children may stamp CURRENT_PROJECT_VERSION
      // from LIONIDAS_BUILD_NUMBER (prepare scripts / xcbuddy / xcodebuild)
      const benv: Record<string, string> = { LIONIDAS_BUILD_NUMBER: String(number), LIONIDAS_BUILD_ID: id };
      const ipaPath = transport === 'repo-lane'
        ? await runRepoLane(ws, log, benv)
        : await runGeneric(ws, scheme, configuration, log, (s) => safeDb(() => db.prepare('UPDATE builds SET scheme = ? WHERE id = ?').run(s, id)), manifest?.prepare ?? [], benv);
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
      // ── smoke gate: a green build whose app dies on launch is NOT a pass ──
      // (brainstorm 20261008T004500Z). Probe first, then set the verdict once:
      // crash → failed + SMOKE_CRASH; skipped → passed (probe infra ≠ app).
      let smokeCol: string | null = null;
      try {
        const outcome = smokeTestArtifact(dest, log);
        smokeCol = outcome.result;
        log(outcome.detail);
        if (outcome.result === 'crash') {
          // the artifact stays on disk for inspection, but a launch-dead app
          // is not a deliverable: drop the row's path AND unclaim the package
          // (claim happens pre-probe) so it never shows as installable.
          // Crash line names the cause.
          safeDb(() => { unclaimPackage(db, dest); });
          safeDb(() => db.prepare(`UPDATE builds SET status = 'failed', finished_at = ?, smoke = 'crash', error = ? WHERE id = ?`)
            .run(Date.now(), `[SMOKE_CRASH] ${outcome.crashLine ?? outcome.detail}`.slice(0, 2000), id));
          return;
        }
      } catch (e) {
        log(`smoke: probe error — skipped (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
      }
      safeDb(() => db.prepare(`UPDATE builds SET status = 'passed', finished_at = ?, artifact_path = ?, smoke = ? WHERE id = ?`)
        .run(Date.now(), dest, smokeCol ?? 'skipped', id));
      // Phase 2 T1: retention pass after every settle — bounded disk with
      // evidence immunity (this build is newest, so it is always kept)
      try {
        const { enforceRetention } = await import('./retention.ts');
        const reports = enforceRetention(db, projectId);
        for (const r of reports) log(`retention: reclaimed ${r.deleted.length} old artifact(s)`);
      } catch { /* non-blocking */ }
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

async function runCommand(cmd: string, args: string[], cwd: string, log: (l: string) => void, timeoutMs = BUILD_TIMEOUT_MS, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // review R1: spread process.env FIRST — children keep PATH etc. — then
    // the build-context vars (LIONIDAS_BUILD_NUMBER contract, plan T2)
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv } });
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

async function runRepoLane(ws: string, log: (l: string) => void, benv: Record<string, string> = {}): Promise<string> {
  const script = join(ws, 'scripts', 'build-sim.sh');
  if (existsSync(script)) {
    log(`$ scripts/build-sim.sh`);
    await runCommand('sh', [script], ws, log, BUILD_TIMEOUT_MS, benv);
  } else {
    log(`$ bundle exec fastlane build_sim`);
    await runCommand('bundle', ['exec', 'fastlane', 'build_sim'], ws, log, BUILD_TIMEOUT_MS, benv);
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

/** compile-only gate (the /implement-identifiers flow): runs the SAME proven
 *  path as a full build — transport pick, manifest prepare steps, preflight,
 *  SPM resolve, xcbuddy/xcodebuild — but stops at the .app: no Payload zip,
 *  no .ipa, no smoke, no package claim. Purpose: prove the edits COMPILE on
 *  the simulator slice before the host pushes them. */
export async function compileWorktree(ws: string, log: (l: string) => void): Promise<{ scheme: string; app: string }> {
  const transport = pickTransport(ws);
  let manifest: BuildManifest | null = null;
  if (transport === 'generic') manifest = readBuildManifest(ws); // strict schema — a typo fails here, before any compile
  let scheme: string | null = manifest?.scheme ?? null;
  const configuration = manifest?.configuration ?? 'Debug';
  if (!scheme) {
    const d = discoverAppInputs(ws);
    scheme = d.appSchemes.length === 1 ? d.appSchemes[0]! : null;
  }
  // runGeneric handles prepare (prepare-sim.sh: config wiring + xcodegen + scipio
  // + SPM resolve) then preflight + build. With skipPackaging it returns the .app.
  const app = await runGeneric(ws, scheme, configuration, log, undefined, manifest?.prepare ?? [], {}, true);
  return { scheme: scheme ?? 'discovered', app };
}

async function runGeneric(ws: string, scheme: string | null, configuration: string | null, log: (l: string) => void, onScheme?: (s: string) => void, prepare: PrepareStep[] = [], benv: Record<string, string> = {}, skipPackaging = false): Promise<string> {
  const conf = configuration ?? 'Debug';
  // PREPARE (manifest v2): the repo declares its own setup steps (spec
  // surgery, scipio, bundler …). The repo owns setup knowledge — Lionidas
  // runs what it declares, never re-implements. When prepare is declared it
  // OWNS project generation: the engine's xcodegen fallback is skipped.
  if (prepare.length > 0) {
    for (const [i, step] of prepare.entries()) {
      const scriptPath = prepareCommandPath(step.run);
      if (!existsSync(join(ws, scriptPath))) {
        throw new Error(`PREPARE_FAILED: prepare[${i}] run "${scriptPath}" not found in the repo`);
      }
      log(`$ prepare[${i}]: ${step.run}`);
      try {
        // repo scripts are usually committed +x; if not, execute via sh <path>
        const target = join(ws, scriptPath);
        const executable = (() => { try { return (statSync(target).mode & 0o111) !== 0; } catch { return false; } })();
        if (executable) {
          await runCommand('sh', ['-c', step.run], ws, log, PREPARE_TIMEOUT_MS, benv);
        } else {
          await runCommand('sh', [scriptPath, ...step.run.trim().split(/\s+/).slice(1)], ws, log, PREPARE_TIMEOUT_MS, benv);
        }
      } catch (e) {
        throw new Error(`PREPARE_FAILED: prepare[${i}] (${step.run}) — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else if (existsSync(join(ws, 'project.yml')) && !hasXcodeproj(ws)) {
    // xcodegen fallback (no prepare declared): project.yml-only repos have
    // no schemes until the .xcodeproj is generated.
    log('$ xcodegen generate');
    await runCommand('xcodegen', ['generate'], ws, log, 5 * 60_000, benv);
  }
  // post-prepare discovery: a prepare step may have generated the project
  if (!scheme) {
    const d = discoverAppInputs(ws);
    if (d.appSchemes.length === 1) {
      scheme = d.appSchemes[0]!;
      log(`# scheme discovered: ${scheme}`);
      onScheme?.(scheme);
    } else if (d.appSchemes.length > 1) {
      throw new Error(`SCHEME_AMBIGUOUS: ${d.appSchemes.length} app schemes found (${d.appSchemes.join(', ')}) — pin one via lionidas.yml or the project's build inputs`);
    }
  }
  if (!scheme) throw new Error('no scheme discovered — xcodebuild -list returned nothing');
  // PREFLIGHT (seconds, pre-compile — plan T4.6): the resolved scheme and
  // configuration must exist; a wrong input dies here, not 15 minutes in.
  const pre = ['-showBuildSettings', '-scheme', scheme, '-sdk', 'iphonesimulator', '-configuration', conf];
  log(`$ xcodebuild ${pre.join(' ')} (preflight)`);
  try {
    await runCommand('xcodebuild', pre, ws, () => undefined, 120_000, benv);
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
  await runCommand('xcodebuild', resolveArgs, ws, log, 15 * 60_000, benv);
  // xcbuddy (Lionidas internal tool): a friendly xcodebuild wrapper that
  // auto-resolves the SPM graph, auto-injects isolated caches (.derived-data/
  // .spm-clones/ in the repo — exactly our convention), fuzzy-matches
  // simulators, and emits a JSON failure envelope. Preferred when present;
  // raw xcodebuild is the fallback for tool-less environments.
  const xcbuddy = which('xcbuddy');
  const dd = join(ws, '.derived-data');
  if (xcbuddy) {
    // --isolated is REQUIRED, not cosmetic: without it xcbuddy builds into the DEFAULT
    // Xcode DerivedData (hash-named, user-global) while the products lookup below reads
    // the repo-local .derived-data/ — a green build then fails the 'no .app found'
    // check (Foodiary live catch: 'Build Succeeded in 3s', verify stamped failed).
    const args = ['build', '--scheme', scheme, '--isolated', '--json'];
    log(`$ xcbuddy ${args.join(' ')} (isolated caches, sim destination; config via project defaults)`);
    await runCommand(xcbuddy, args, ws, log, BUILD_TIMEOUT_MS, benv);
  } else {
    const args = [
      '-scheme', scheme, '-sdk', 'iphonesimulator', '-configuration', conf,
      '-derivedDataPath', dd,
      '-clonedSourcePackagesDirPath', join(ws, '.spm-clones'),
      '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-skipPackageUpdates',
      'build',
    ];
    log(`$ xcodebuild ${args.join(' ')}`);
    await runCommand('xcodebuild', args, ws, log, BUILD_TIMEOUT_MS, benv);
  }
  const products = join(dd, 'Build', 'Products', `${conf}-iphonesimulator`);
  let appDir: string | null = null;
  try {
    appDir = readdirSync(products).map((f) => join(products, f)).find((p) => p.endsWith('.app')) ?? null;
  } catch { /* not found below */ }
  if (!appDir) throw new Error(`no .app found under ${products}`);
  if (skipPackaging) return appDir; // compile-only: the .app IS the verdict
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
