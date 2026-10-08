/** lionidas run — CI client. One execution path: the running server's API.
 *  Exit codes: 0 all-pass · 1 app failure · 2 infra. */
import { awaitRuns, fetchFailedStep, mapExitCode, type InfraError, type RunSummary } from './runner.ts';
import { junitXml } from './junit.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// ── lionidas admin reset-password <email> — locked-out-admin recovery.
// Operates DIRECTLY on the DB file (server may be stopped): prints a one-time
// password; the operator signs in and changes it. Never reopens the wizard.
async function adminResetPassword(email: string): Promise<number> {
  const dbPath = process.env.CRUCIBLE_DB_PATH ?? './crucible.db';
  let db: import('better-sqlite3').Database;
  try {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(dbPath);
  } catch (err) {
    console.error(`lionidas: cannot open ${dbPath} (${err instanceof Error ? err.message : String(err)})`);
    return 2;
  }
  try {
    const row = db.prepare('SELECT id, email, active FROM users WHERE email = ?').get(email.toLowerCase().trim()) as { id: string; email: string; active: number } | undefined;
    if (!row) { console.error(`lionidas: no user with email ${email}`); return 2; }
    if (!row.active) { console.error(`lionidas: ${email} is deactivated — activate the account first (users page)`); return 2; }
    const { hashPassword } = await import('../auth/users.ts');
    const oneTime = randomBytes(9).toString('base64url');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(oneTime), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id); // reset forces re-login
    db.prepare('INSERT INTO auth_log(at, email, user_id, event, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), row.email, row.id, 'password_reset', 'one-time password via lionidas admin reset-password');
    console.log(`one-time password for ${row.email}: ${oneTime}`);
    console.log('sign in and change it — it is shown once.');
    return 0;
  } finally {
    db.close();
  }
}

interface Args {
  tags?: string; app?: string; udid?: string; boot?: string;
  env: Array<[string, string]>; scenario?: string; triggeredBy?: string;
  junit?: string; json: boolean; timeoutSec: number; properties: Array<[string, string]>;
  help: boolean;
}

const USAGE = `lionidas run — execute a template suite against a running Lionidas server

usage: lionidas run [options]
  --tags <list>        comma-list tag filter (AND semantics), e.g. smoke
  --app <bundle>       restrict to one app bundle id
  --udid <udid>        target device (explicit — never auto-picked)
  --boot <udid>        boot this device first (idempotent), then target it
  --env K=V            (repeatable) env vars for the runs
  --scenario <id>      forge network scenario
  --triggered-by <who> attribution recorded on runs (default: ci)
  --junit <path>       write JUnit XML (testcase per template run)
  --json               machine-readable summary to stdout
  --timeout <sec>      overall cap (default 900)
  --property K=V       (repeatable) extra JUnit <property> entries
  --help               this text

env: CRUCIBLE_URL (default http://127.0.0.1:9230)
exit: 0 all passed · 1 app failure · 2 infra/config`;

function parseArgs(argv: string[]): Args {
  const a: Args = { env: [], json: false, timeoutSec: 900, properties: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const next = (): string => { const v = argv[++i]; if (v === undefined) { fail2(`missing value for ${t}`); } return v as string; };
    if (t === '--tags') a.tags = next();
    else if (t === '--app') a.app = next();
    else if (t === '--udid') a.udid = next();
    else if (t === '--boot') a.boot = next();
    else if (t === '--scenario') a.scenario = next();
    else if (t === '--triggered-by') a.triggeredBy = next();
    else if (t === '--junit') a.junit = next();
    else if (t === '--json') a.json = true;
    else if (t === '--timeout') a.timeoutSec = Number(next());
    else if (t === '--env') { const kv = next(); const eq = kv.indexOf('='); if (eq <= 0) fail2(`--env expects KEY=VALUE (got ${kv})`); a.env.push([kv.slice(0, eq), kv.slice(eq + 1)]); }
    else if (t === '--property') { const kv = next(); const eq = kv.indexOf('='); if (eq <= 0) fail2(`--property expects KEY=VALUE`); a.properties.push([kv.slice(0, eq), kv.slice(eq + 1)]); }
    else if (t === '--help' || t === '-h') a.help = true;
    else fail2(`unknown flag: ${t}`);
  }
  return a;
}

function fail2(msg: string): never {
  console.error(`lionidas: ${msg}`);
  process.exit(2);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'admin' && argv[1] === 'reset-password') {
    const email = argv[2];
    if (!email) { console.error('usage: lionidas admin reset-password <email>'); return 2; }
    return adminResetPassword(email);
  }
  if (argv[0] === 'run') argv.shift(); // subcommand form: lionidas run --flags
  const a = parseArgs(argv);
  if (a.help) { console.log(USAGE); return 0; }
  const base = (process.env.CRUCIBLE_URL ?? 'http://127.0.0.1:9230').replace(/\/$/, '');

  // optional explicit boot first (idempotent per the power route)
  const target = a.boot ?? a.udid;
  if (a.boot) {
    try {
      const r = await fetch(`${base}/api/devices/${a.boot}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'boot' }) });
      if (!r.ok) { const b = (await r.json().catch(() => ({ error: String(r.status) }))) as { error?: string }; fail2(`boot failed: ${b.error}`); }
    } catch (err) {
      fail2(`server unreachable at ${base} — is the Lionidas stack running? (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // suite: one play-all invocation
  let batch: { runIds?: string[]; count?: number; error?: string };
  try {
    const r = await fetch(`${base}/api/templates/play-all`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(a.tags ? { tags: a.tags } : {}), ...(a.app ? { app: a.app } : {}),
        ...(target ? { udid: target } : {}), ...(a.scenario ? { scenarioId: a.scenario } : {}),
        triggeredBy: a.triggeredBy ?? 'ci',
        ...(a.env.length ? { env: Object.fromEntries(a.env) } : {}),
      }),
    });
    batch = (await r.json().catch(() => ({ error: `play-all ${r.status}` }))) as { runIds?: string[]; count?: number; error?: string };
    if (!r.ok) fail2(`batch failed: ${batch.error ?? r.status}`);
  } catch (err) {
    if ((err as { message?: string }).message?.startsWith('lionidas:')) throw err;
    fail2(`server unreachable at ${base} (${err instanceof Error ? err.message : String(err)})`);
  }
  const runIds = batch.runIds ?? [];
  if (runIds.length === 0) fail2('no templates matched the filter (empty suite = config error)');

  // poll to terminal
  const { runs, infra } = await awaitRuns(base, runIds, {
    timeoutMs: a.timeoutSec * 1000,
    fetchSteps: (b, id) => fetchFailedStep(fetch, b, id),
  });

  // readable names: map template ids → names (one request)
  try {
    const tr = await fetch(`${base}/api/templates`);
    if (tr.ok) {
      const names = new Map(((await tr.json()) as { templates: Array<{ id: string; name: string }> }).templates.map((t) => [t.id, t.name]));
      for (const r of runs) if (r.templateId) r.templateName = names.get(r.templateId) ?? null;
    }
  } catch { /* names best-effort */ }

  report(a, runs, infra);
  if (a.junit) writeJunit(a, base, runs, infra);
  return mapExitCode(runs, infra);
}

function report(a: Args, runs: RunSummary[], infra?: InfraError): void {
  if (a.json) { console.log(JSON.stringify({ runs, infra: infra ?? null }, null, 2)); return; }
  for (const r of runs) {
    const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✕' : '◌';
    console.log(`${mark} ${r.ticketKey ?? r.runId} — ${r.status}${r.failedStep ? ` (step ${r.failedStep.idx + 1}: ${r.failedStep.reason})` : ''}`);
  }
  if (infra) console.error(`◇ infra: ${infra.kind === 'timeout' ? 'timed out' : infra.message}`);
}

function writeJunit(a: Args, base: string, runs: RunSummary[], infra?: InfraError): void {
  const xml = junitXml({
    suiteName: `lionidas${a.tags ? `:${a.tags}` : ''}`,
    baseUrl: base, runs,
    properties: a.properties,
    ...(infra ? { infraMessage: infra.kind === 'timeout' ? 'timed out awaiting terminal run states' : infra.message } : {}),
  });
  try {
    if (a.junit!.includes('/')) mkdirSync(dirname(a.junit!), { recursive: true });
    writeFileSync(a.junit!, xml);
  } catch (err) {
    console.error(`lionidas: junit write failed (${err instanceof Error ? err.message : String(err)}) — runs reported above`);
    process.exit(2);
  }
}

process.exitCode = await main();
