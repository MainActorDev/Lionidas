import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

/**
 * Overview slice T3 — GET /api/overview aggregate read model.
 * One query surface answering "is the build safe / what needs attention".
 * Metric definitions are pinned in docs/plans/2026-09-22-overview-vertical-slice.md:
 *
 *  - CURRENT SET  = runs of the latest non-NULL batch_id in scope. Solo plays
 *    (NULL batch) are NOT execution sets — they appear in latestRuns only.
 *  - COMPARABILITY: previous comparable set = next-earlier batch, same suite
 *    scope AND same app_version. Unknown build → labeled bucket, never merged;
 *    mixed-version batch → "mixed builds" label, no fabricated version.
 *  - HEALTH ORDER: running/queued member ⇒ running (FIRST — a mid-flight
 *    re-run must not display yesterday's failures as current truth);
 *    failed>0 ⇒ failed; blocked>0 ⇒ degraded; else healthy; no set ⇒ no_data.
 *  - LANES COLLAPSE: variant runs of one template in one batch = ONE
 *    observation at its worst lane (mirrors suiteVerdicts). Otherwise one
 *    failed lane would read as "1 failed + 3 passed ⇒ flaky" and poison both
 *    passRate and the classifier.
 *  - passRate = passed/(passed+failed); blocked is SEPARATE, never a failure.
 *  - ATTENTION RANK: new_failure > infra_blocked > repeated_failure >
 *    stale_case. new = failed now + passed in previous comparable set,
 *    checked against case_version_id so a definition change is labeled, not
 *    miscounted. stale = active template not executed in `days` (default 7).
 *  - CLOCK: `now` is injected ({ now: () => ms }) so wall-time semantics are
 *    testable (freshness/stale windows) — same seam as freshness elsewhere.
 */

export interface OverviewDeps {
  now?: () => number;
}

type RunRow = {
  id: string; template_id: string; status: string; blocked: number;
  app_version: string | null; variant_id: string | null; batch_id: string | null;
  started_at: number; finished_at: number | null; suite_id: string | null;
  case_version_id: string | null;
};

const WORST: Record<string, number> = { running: 3, queued: 3, failed: 2, aborted: 1, blocked: 1, passed: 0 };

/** collapse a batch's runs to ONE observation per template (worst lane wins) */
function collapseLanes(rows: RunRow[]): Map<string, RunRow> {
  const byTpl = new Map<string, RunRow>();
  for (const r of rows) {
    const cur = byTpl.get(r.template_id);
    if (!cur || (WORST[r.status] ?? 0) > (WORST[cur.status] ?? 0)) byTpl.set(r.template_id, r);
  }
  return byTpl;
}

function verdictOf(r: RunRow): 'passed' | 'failed' | 'blocked' | 'running' {
  if (r.status === 'running' || r.status === 'queued') return 'running';
  if (r.status === 'failed') return 'failed';
  if (r.blocked === 1 || r.status === 'aborted') return 'blocked';
  return 'passed';
}

export function registerOverviewRoutes(app: FastifyInstance, db: Database.Database, deps: OverviewDeps = {}): void {
  const nowFn = deps.now ?? (() => Date.now());

  app.get('/api/overview', async (req) => {
    const q = req.query as { suite?: string; app_version?: string; days?: string };
    const days = Math.max(1, Number(q.days ?? 7) || 7);
    const now = nowFn();
    const staleCutoff = now - days * 86400_000;

    // scope: suite filter narrows to runs carrying that suite_id; NULL-suite
    // runs count under every scope (a batch play-all writes suite_id only for
    // suite-invoked plays; play-all runs carry NULL suite and belong to the
    // unscoped view). app_version filter (explicit) narrows further.
    const scopeWhere: string[] = [`started_at >= ?`];
    const scopeArgs: unknown[] = [staleCutoff];
    if (q.suite) { scopeWhere.push(`(suite_id = ? OR suite_id IS NULL)`); scopeArgs.push(q.suite); }
    if (q.app_version) { scopeWhere.push(`app_version = ?`); scopeArgs.push(q.app_version); }

    const runs = db.prepare(`SELECT id, template_id, status, blocked, app_version, variant_id, batch_id, started_at, finished_at, suite_id, case_version_id
                             FROM runs WHERE batch_id IS NOT NULL AND ${scopeWhere.join(' AND ')}
                             ORDER BY started_at DESC`).all(...scopeArgs) as RunRow[];

    // group by batch, newest-first
    const batches: Array<{ id: string; rows: RunRow[]; startedAt: number }> = [];
    for (const r of runs) {
      let b = batches.find((x) => x.id === r.batch_id);
      if (!b) { b = { id: r.batch_id!, rows: [], startedAt: r.started_at }; batches.push(b); }
      b.rows.push(r);
    }

    // latest set + previous comparable (same scope's app_version family)
    const current = batches[0];
    let buildLabel: string | null = null;
    let previous: (typeof batches)[number] | undefined;
    if (current) {
      const versions = new Set(current.rows.map((r) => r.app_version));
      const mixed = versions.size > 1 || (versions.size === 1 && [...versions][0] === null);
      const want = mixed ? null : ([...versions][0] ?? null);
      for (const cand of batches.slice(1)) {
        if (want === null) break; // mixed/unknown: no honest single previous build — skip delta
        const candVersions = new Set(cand.rows.map((r) => r.app_version));
        if (candVersions.size === 1 && candVersions.has(want)) { previous = cand; break; }
      }
      buildLabel = want === null ? (mixed ? 'mixed builds' : 'unknown build') : want;
    }

    // health over collapsed observations
    let running = 0, failed = 0, blocked = 0, passed = 0;
    const currentByTpl = current ? collapseLanes(current.rows) : new Map<string, RunRow>();
    for (const r of currentByTpl.values()) {
      const v = verdictOf(r);
      if (v === 'running') running++;
      else if (v === 'failed') failed++;
      else if (v === 'blocked') blocked++;
      else passed++;
    }
    const lastFinished = current ? Math.max(...current.rows.map((r) => r.finished_at ?? r.started_at)) : null;

    const status: string = !current ? 'no_data' : running > 0 ? 'running' : failed > 0 ? 'failed' : blocked > 0 ? 'degraded' : 'healthy';
    const prevByTpl = previous ? collapseLanes(previous.rows) : new Map<string, RunRow>();
    const prevPassed = [...prevByTpl.values()].filter((r) => verdictOf(r) === 'passed').length;
    const delta = current && previous && prevPassed + passed > 0 ? (passed - prevPassed) / (prevPassed + passed) : null;

    // ── attention list ──
    const attention: Array<Record<string, unknown>> = [];
    if (current) {
      const newFailures: Array<Record<string, unknown>> = [];
      const infraBlocked: Array<Record<string, unknown>> = [];
      const repeated: Array<Record<string, unknown>> = [];
      for (const [tplId, r] of currentByTpl) {
        const v = verdictOf(r);
        const prev = prevByTpl.get(tplId);
        const prevV = prev ? verdictOf(prev) : 'none';
        const sameDefinition = prev ? prev.case_version_id === r.case_version_id : false;
        const base = { templateId: tplId, runId: r.id, variantId: r.variant_id, status: v, appVersion: r.app_version, batchId: current.id };
        if (v === 'failed') {
          if (prevV === 'passed' && sameDefinition) newFailures.push({ ...base, kind: 'new_failure', previously: 'passed' });
          else repeated.push({ ...base, kind: 'repeated_failure', tag: 'recurring' });
        } else if (v === 'blocked') {
          infraBlocked.push({ ...base, kind: 'infra_blocked' });
        }
      }
      // stale: active template with NO run in the stale window (any batch, incl. legacy)
      const staleTpls = db.prepare(`SELECT id FROM templates WHERE status = 'active' AND id NOT IN (SELECT DISTINCT template_id FROM runs WHERE started_at >= ?)`).all(staleCutoff) as Array<{ id: string }>;
      const stale = staleTpls.map((t) => ({ kind: 'stale_case', templateId: t.id, runId: null, tag: `not run in ${days}d` }));
      attention.push(...newFailures, ...infraBlocked, ...repeated, ...stale);
    }

    // ── coverage snapshot ──
    const tpls = db.prepare(`SELECT id, status, variants_json FROM templates`).all() as Array<{ id: string; status: string | null; variants_json: string | null }>;
    const variantCount = (j: string | null): number => { if (!j) return 0; try { return JSON.parse(j).length; } catch { return 0; } };
    const executed = new Set(db.prepare(`SELECT DISTINCT template_id FROM runs WHERE started_at >= ?`).all(staleCutoff).map((r: any) => r.template_id));
    const coverage = {
      active: tpls.filter((t) => (t.status ?? 'active') === 'active').length,
      draft: tpls.filter((t) => t.status === 'draft').length,
      deprecated: tpls.filter((t) => t.status === 'deprecated').length,
      variants: tpls.reduce((n, t) => n + variantCount(t.variants_json), 0),
      executedInRange: [...executed].filter((id) => tpls.some((t) => t.id === id)).length,
      notRunRecently: tpls.filter((t) => (t.status ?? 'active') === 'active' && !executed.has(t.id)).length,
    };

    // ── latest runs (solo included — nothing disappears) ──
    const latestRuns = db.prepare(`SELECT id, template_id, status, blocked, app_version, variant_id, batch_id, started_at, finished_at
                                   FROM runs WHERE ${scopeWhere.join(' AND ')}
                                   ORDER BY started_at DESC LIMIT 20`).all(...scopeArgs) as RunRow[];

    return {
      generatedAt: now,
      scope: { suite: q.suite ?? null, appVersion: q.app_version ?? null, days },
      health: {
        status, passed, failed, blocked, running,
        passRate: passed + failed > 0 ? passed / (passed + failed) : null,
        delta,
        previousBatch: previous?.id ?? null,
        buildLabel: current ? (typeof buildLabel !== 'undefined' ? buildLabel : null) : null,
        lastRunAt: current ? Math.min(...current.rows.map((r) => r.started_at)) : null,
        lastSuccessfulAt: status === 'healthy' ? lastFinished : null,
      },
      attention,
      coverage,
      latestRuns: latestRuns.map((r) => ({
        runId: r.id, templateId: r.template_id, status: r.status, blocked: r.blocked,
        appVersion: r.app_version, variantId: r.variant_id, batchId: r.batch_id,
        startedAt: r.started_at, finishedAt: r.finished_at,
      })),
    };
  });
}
