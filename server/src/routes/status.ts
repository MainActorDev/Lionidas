/** System status (plan 20261014T062902Z, variant C): one aggregator route,
 *  per-subsystem cards {id, name, state, summary, detail}, ALL reads from
 *  SQLite tables — no live engine probes (user decision 1), no folds (PR2:
 *  SQL over recent events only). 10s in-process cache, labeled when cached.
 *
 *  State rules (user decision 3 "yes"):
 *    agent-core  degraded when zombie candidate (live turn idle > 15min)
 *                or outbox backlog > 0
 *    provider-mcp degraded when MCP_PENDING retries > 0 in the last hour
 *    llm-backend degraded when context-burn failures > 0 in 24h
 *    engine/data-freshness per-age thresholds (7d run/ingest, 14d diag)
 *  Secrets NEVER serialized (PR: key-present booleans only). */
import type { FastifyInstance } from 'fastify';
import { projectWorkspace } from '../manual/packages.ts';
import { detectBuildConfig } from '../projects/build-config-detect.ts';
import { activeBuildConfig } from '../projects/build-configs.ts';
import type Database from 'better-sqlite3';
import { requireRole } from '../auth/roles.ts';
import { VERSION } from './health.ts';

export interface StatusCard {
  id: string;
  name: string;
  state: 'ok' | 'degraded' | 'down' | 'unknown';
  summary: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface StatusPayload {
  checkedAt: number;
  cached: boolean;
  systems: StatusCard[];
}

const ZOMBIE_MS = 15 * 60_000;
const MCP_RETRY_WINDOW_MS = 60 * 60_000;
const BURN_WINDOW_MS = 24 * 60 * 60_000;
const FRESH_RUN_DAYS = 7;
const FRESH_INGEST_DAYS = 7;
const FRESH_DIAG_DAYS = 14;
const CACHE_TTL_MS = 10_000;

let cache: { at: number; payload: Omit<StatusPayload, 'cached'> } | null = null;

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function computeStatus(db: Database.Database, agentDb: Database.Database, now: number, startedAt: number, env: Record<string, string | undefined>): Omit<StatusPayload, 'cached'> {
  const systems: StatusCard[] = [];

  // 1 ── server: uptime, version, both DBs reachable + WAL + size
  {
    let dbOk = true; let dbDetail: Record<string, string | number | boolean | null> = {};
    for (const [label, d] of [['crucible.db', db], ['agent.db', agentDb]] as const) {
      try {
        const mode = d.pragma('journal_mode', { simple: true }) as string;
        const size = (d.prepare('SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()').get() as { b: number }).b;
        dbDetail[`${label} journal`] = mode;
        dbDetail[`${label} size`] = `${(size / 1_048_576).toFixed(1)}MB`;
      } catch (e) {
        dbOk = false;
        dbDetail[`${label} error`] = e instanceof Error ? e.message : String(e);
      }
    }
    systems.push({
      id: 'server', name: 'server',
      state: dbOk ? 'ok' : 'down',
      summary: `up ${fmtAge(now - startedAt)} · v${VERSION}`,
      detail: { uptime: fmtAge(now - startedAt), version: VERSION, ...dbDetail },
    });
  }

  // 2 ── agent core: live turns, zombies, outbox backlog, 24h outcomes — SQL only (PR2)
  {
    let state: StatusCard['state'] = 'ok';
    const detail: Record<string, string | number | boolean | null> = {};
    try {
      const live = agentDb.prepare(`
        SELECT e.turn_id, MAX(e.at) AS last_at FROM butler_turn_events e
        WHERE e.kind = 'turn.started' AND e.at > ?
          AND NOT EXISTS (
            SELECT 1 FROM butler_turn_events t
            WHERE t.turn_id = e.turn_id AND t.kind IN ('turn.completed','turn.failed','turn.aborted'))
        GROUP BY e.turn_id`).all(now - BURN_WINDOW_MS) as Array<{ turn_id: string; last_at: number }>;
      const zombies = live.filter((t) => now - t.last_at > ZOMBIE_MS);
      const backlog = agentDb.prepare('SELECT COUNT(*) AS n, COALESCE(MIN(id),0) AS oldest FROM butler_outbox WHERE retired_at IS NULL').get() as { n: number; oldest: number };
      const outcomes = agentDb.prepare(`
        SELECT kind, COUNT(*) AS n FROM butler_turn_events
        WHERE kind IN ('turn.completed','turn.failed','turn.aborted') AND at > ? GROUP BY kind`).all(now - BURN_WINDOW_MS) as Array<{ kind: string; n: number }>;
      const byKind = Object.fromEntries(outcomes.map((o) => [o.kind.replace('turn.', ''), o.n]));
      if (zombies.length > 0) { state = 'degraded'; detail['zombie candidates'] = zombies.map((z) => `${z.turn_id} (idle ${fmtAge(now - z.last_at)})`).join(', '); }
      if (backlog.n > 0) { state = 'degraded'; detail['outbox backlog'] = `${backlog.n} effects`; }
      detail['live turns'] = live.length;
      detail['24h completed'] = byKind['completed'] ?? 0;
      detail['24h failed'] = byKind['failed'] ?? 0;
      detail['24h aborted'] = byKind['aborted'] ?? 0;
      systems.push({
        id: 'agent-core', name: 'agent core',
        state,
        summary: `${live.length} live turn${live.length === 1 ? '' : 's'} · 24h: ${byKind['completed'] ?? 0} ✓ / ${byKind['failed'] ?? 0} ✕`,
        detail,
      });
    } catch (e) {
      systems.push({ id: 'agent-core', name: 'agent core', state: 'down', summary: 'event log unreadable', detail: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // 3 ── provider · mcp: kind/model/CLI (config facts), MCP retries 1h, last ok turn
  {
    let state: StatusCard['state'] = 'ok';
    const detail: Record<string, string | number | boolean | null> = {};
    try {
      const retries = (agentDb.prepare(`
        SELECT COUNT(*) AS n FROM butler_turn_events
        WHERE kind = 'turn.failed' AND at > ? AND detail_json LIKE '%MCP_PENDING%'`).get(now - MCP_RETRY_WINDOW_MS) as { n: number }).n;
      // NOTE: MCP_PENDING throws before the transport records turn.failed; retry
      // wins are invisible in the log. Surface last provider error + last ok turn.
      const lastOk = (agentDb.prepare(`SELECT MAX(at) AS m FROM butler_turn_events WHERE kind = 'turn.completed'`).get() as { m: number | null }).m;
      const lastFail = (agentDb.prepare(`SELECT detail_json, at FROM butler_turn_events WHERE kind = 'turn.failed' ORDER BY at DESC LIMIT 1`).get() as { detail_json: string; at: number } | undefined);
      if (retries > 0) { state = 'degraded'; detail['mcp retries 1h'] = retries; }
      detail['provider'] = env['BUTLER_PROVIDER'] ?? 'openai-compat';
      detail['model'] = env['BUTLER_MODEL'] ?? null;
      detail['api key present'] = Boolean(env['BUTLER_API_KEY']);
      if (lastOk) detail['last ok turn'] = `${fmtAge(now - lastOk)} ago`;
      if (lastFail) {
        try { detail['last error'] = `${(JSON.parse(lastFail.detail_json) as { error?: string }).error ?? 'unknown'} (${fmtAge(now - lastFail.at)} ago)`; } catch { /* unparseable detail */ }
      }
      // v0.6.0: per-model routing health lives at /api/agent/models/health
      // (router in-memory rollup); this card stays table-driven per plan.
      systems.push({ id: 'provider-mcp', name: 'provider · mcp', state, summary: `${detail['provider']} · ${detail['model'] ?? 'default model'}`, detail });
    } catch (e) {
      systems.push({ id: 'provider-mcp', name: 'provider · mcp', state: 'down', summary: 'unreadable', detail: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // 4 ── llm backend: endpoint host (never the key), last latency, spend today, burn 24h
  {
    let state: StatusCard['state'] = 'ok';
    const detail: Record<string, string | number | boolean | null> = {};
    try {
      const burn = (agentDb.prepare(`
        SELECT COUNT(*) AS n FROM butler_turn_events
        WHERE kind = 'turn.failed' AND at > ? AND detail_json LIKE '%empty answer%'`).get(now - BURN_WINDOW_MS) as { n: number }).n;
      const spendRow = agentDb.prepare(`
        SELECT SUM(CAST(json_extract(detail_json, '$.cost') AS INTEGER)) AS tok FROM butler_turn_events
        WHERE kind = 'usage' AND at > ?`).get(now - BURN_WINDOW_MS) as { tok: number | null };
      const lastLatency = agentDb.prepare(`
        SELECT c.at AS done, s.at AS started FROM butler_turn_events c
        JOIN butler_turn_events s ON s.turn_id = c.turn_id AND s.kind = 'turn.started'
        WHERE c.kind IN ('turn.completed','turn.failed') ORDER BY c.at DESC LIMIT 1`).get() as { done: number; started: number } | undefined;
      if (burn > 0) { state = 'degraded'; detail['context burn 24h'] = burn; }
      const base = env['BUTLER_PROVIDER_BASE_URL'] ?? null;
      detail['endpoint'] = base ? new URL(base).host : null;
      detail['key present'] = Boolean(env['BUTLER_API_KEY']);
      detail['spend 24h'] = `${((spendRow?.tok ?? 0) / 1000).toFixed(0)}k tok`;
      if (lastLatency) detail['last turn'] = `${((lastLatency.done - lastLatency.started) / 1000).toFixed(1)}s`;
      systems.push({ id: 'llm-backend', name: 'llm backend', state, summary: `${detail['endpoint'] ?? 'not configured'}${lastLatency ? ` · ${detail['last turn']}` : ''}`, detail });
    } catch (e) {
      systems.push({ id: 'llm-backend', name: 'llm backend', state: 'down', summary: 'unreadable', detail: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // 5 ── engine (read-from-tables, user decision 1): sims last seen, runs queued/running,
  //        alloy orphaned manual sessions
  {
    let state: StatusCard['state'] = 'ok';
    const detail: Record<string, string | number | boolean | null> = {};
    try {
      const sims = (db.prepare(`SELECT COUNT(*) AS n, MAX(last_seen) AS last FROM devices`).get() as { n: number; last: number | null });
      const runStates = db.prepare(`SELECT status, COUNT(*) AS n FROM runs WHERE status IN ('queued','running') GROUP BY status`).all() as Array<{ status: string; n: number }>;
      let orphans = 0;
      try { orphans = (db.prepare(`SELECT COUNT(*) AS n FROM manual_sessions WHERE finished_at IS NULL AND started_at < ?`).get(now - ZOMBIE_MS) as { n: number }).n; }
      catch { /* manual_sessions absent on fresh installs — 0 is the truth */ }
      const queued = runStates.find((r) => r.status === 'queued')?.n ?? 0;
      const running = runStates.find((r) => r.status === 'running')?.n ?? 0;
      if (orphans > 0) { state = 'degraded'; detail['orphan sessions'] = orphans; }
      detail['devices seen'] = sims.n;
      if (sims.last) detail['devices last seen'] = `${fmtAge(now - sims.last)} ago`;
      detail['runs queued'] = queued;
      detail['runs running'] = running;
      detail['alloy orphans'] = orphans;
      detail['source'] = 'tables (no live probes)';
      systems.push({ id: 'engine', name: 'engine', state, summary: `${sims.n} device${sims.n === 1 ? '' : 's'} seen · ${running} running · ${queued} queued`, detail });
    } catch (e) {
      systems.push({ id: 'engine', name: 'engine', state: 'down', summary: 'unreadable', detail: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // 6 ── data freshness: last run executed, last case edit, last diag payload, repo ingest
  {
    let state: StatusCard['state'] = 'ok';
    const detail: Record<string, string | number | boolean | null> = {};
    try {
      const lastRun = (db.prepare(`SELECT MAX(started_at) AS m FROM runs`).get() as { m: number | null }).m;
      const lastCase = (db.prepare(`SELECT MAX(updated_at) AS m FROM templates`).get() as { m: number | null }).m;
      const lastDiag = (db.prepare(`SELECT MAX(received_at) AS m FROM mx_payloads`).get() as { m: number | null }).m;
      let lastIngest: number | null = null;
      try { lastIngest = (agentDb.prepare(`SELECT MAX(fetched_at) AS m FROM butler_documents`).get() as { m: number | null }).m; } catch { /* table may not exist on fresh installs */ }
      const checks: Array<[string, number | null, number]> = [
        ['last run', lastRun, FRESH_RUN_DAYS * 86_400_000],
        ['last case edit', lastCase, 0],
        ['last diag payload', lastDiag, FRESH_DIAG_DAYS * 86_400_000],
        ['last repo ingest', lastIngest, FRESH_INGEST_DAYS * 86_400_000],
      ];
      const stale: string[] = [];
      for (const [label, at, threshold] of checks) {
        detail[label] = at ? `${fmtAge(now - at)} ago` : 'never';
        if (threshold > 0 && (at === null || now - at > threshold)) stale.push(label);
      }
      if (stale.length > 0) { state = 'degraded'; detail['stale beyond threshold'] = stale.join(', '); }
      detail['thresholds'] = `run ${FRESH_RUN_DAYS}d · ingest ${FRESH_INGEST_DAYS}d · diag ${FRESH_DIAG_DAYS}d`;
      systems.push({ id: 'data-freshness', name: 'data freshness', state, summary: `run ${detail['last run']} · ingest ${detail['last repo ingest']}`, detail });
    } catch (e) {
      systems.push({ id: 'data-freshness', name: 'data freshness', state: 'down', summary: 'unreadable', detail: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // build-recipe canary (S3 upgrade): consumes detectBuildConfig + the recipes store —
  // same law the engine obeys. Per project: detection state, active recipe (source,
  // generated flag), verify verdict, and whether the LAST BUILD actually used its
  // recipe (FALLBACK_LIED semantics, now recipe-aware per R4).
  try {
    const projects = db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>;
    const cfgRows: Record<string, string | number | boolean | null> = {};
    let degraded = false;
    for (const proj of projects) {
      try {
        const ws = projectWorkspace(proj.name);
        const detection = detectBuildConfig(ws);
        const row = activeBuildConfig(db, proj.id);
        const lastBuild = db.prepare('SELECT status, resolution FROM builds WHERE project_id = ? ORDER BY number DESC LIMIT 1').get(proj.id) as { status: string; resolution: string | null } | undefined;
        let usedRecipe: boolean | null = null;
        let fallbackLied = false;
        if (lastBuild) {
          try {
            const res = JSON.parse(lastBuild.resolution ?? '{}') as { scheme?: string; recipeId?: string };
            usedRecipe = res.scheme === 'recipes' || res.scheme === 'manifest' || res.scheme === 'manifest-legacy' || res.recipeId != null;
            // a PASSING build with a findable recipe that did NOT use it = the lie
            if (lastBuild.status === 'passed' && !usedRecipe && (detection.state === 'found' || row != null)) fallbackLied = true;
          } catch { /* resolution unparseable */ }
        }
        const unverifiedGenerated = row != null && row.generated && row.verifyState !== 'green';
        const blocked = detection.state === 'blocked';
        if (fallbackLied || unverifiedGenerated || (blocked && lastBuild != null)) degraded = true;
        cfgRows[`${proj.name} detection`] = detection.state === 'found' ? `found:${detection.source}` : detection.state;
        cfgRows[`${proj.name} recipe`] = row ? `${row.transport}${row.scheme ? `:${row.scheme}` : ''} rev${row.revision}` : 'none';
        if (row) cfgRows[`${proj.name} generated`] = row.generated;
        if (row) cfgRows[`${proj.name} verified`] = row.verifyState ?? 'unverified';
        if (lastBuild) cfgRows[`${proj.name} lastBuildUsedRecipe`] = usedRecipe;
        if (fallbackLied) cfgRows[`${proj.name} FALLBACK_LIED`] = true;
      } catch (e) {
        cfgRows[`${proj.name} error`] = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
      }
    }
    systems.push({
      id: 'build-recipe', name: 'build configs',
      state: degraded ? 'degraded' : 'ok',
      summary: degraded ? 'build-config gap: fallback-lie, unverified generated, or blocked-with-builds' : `${projects.length} project(s) · build configs honest`,
      detail: cfgRows,
    });
  } catch { /* projects table absent on minimal installs */ }

  return { checkedAt: now, systems };
}

/** route registration. `gated` (default true) applies the operator gate; tests
 *  register ungated (the gate itself is requireRole's tested behavior). */
export function registerStatusRoutes(app: FastifyInstance, db: Database.Database, agentDbPath: string, env: Record<string, string | undefined>, gated = true): void {
  const startedAt = Date.now();
  const opts = gated ? { preHandler: requireRole('operator') } : {};
  app.get('/api/status', opts, async () => {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return { ...cache.payload, cached: true };
    }
    // agent db: open read-only handle per check (cheap; avoids holding a second
    // connection for the process lifetime; WAL readers don't block the writer)
    const AgentDb = (await import('better-sqlite3')).default;
    const agentDb = new AgentDb(agentDbPath, { readonly: true, fileMustExist: false });
    try {
      const payload = computeStatus(db, agentDb, now, startedAt, env);
      cache = { at: now, payload };
      return { ...payload, cached: false };
    } finally {
      agentDb.close();
    }
  });
}
