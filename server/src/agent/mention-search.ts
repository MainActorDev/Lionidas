/** Mention-palette Stage A: unified LOCAL-tier ref search.
 *  One endpoint merging cases (SQL), repos (local git log), files (attachment
 *  rows) — fuzzy-scored, capped. Jira stays on its existing route: it is a
 *  REMOTE call and rides the async tier (review MR3). Zero new deps.
 *
 *  MR4: 'case' extends lionidas-local RefKind (knowledge.ts) — butler untouched. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireRoleAtLeast } from '../auth/roles.ts';
import type { AgentContext } from './context.ts';
import { listRepos } from './repo-refs.ts';

const exec = promisify(execFile);

export interface PaletteRow {
  id: string;
  kind: 'case' | 'repo' | 'file';
  title: string;
  meta: string;
  /** wire shape: exactly what a picked chip becomes */
  ref: { kind: string; locator: string };
}

/** cheap subsequence fuzzy — match char positions, score by compactness; '' matches all */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    score += at === prev + 1 ? 3 : 1; // consecutive runs score higher
    prev = at;
    ti = at + 1;
  }
  return score / q.length;
}

export async function searchLocalRefs(ctx: AgentContext, q: string, _sessionId?: string): Promise<PaletteRow[]> {
  const rows: PaletteRow[] = [];
  const query = q.trim();

  // cases — SQL, instant
  try {
    const caseRows = ctx.db.prepare("SELECT id, name, status, app_bundle_id FROM templates ORDER BY name LIMIT 300").all() as Array<{ id: string; name: string; status: string | null; app_bundle_id: string | null }>;
    for (const c of caseRows) {
      const s = fuzzyScore(query, `${c.name} ${c.id}`) ?? (query ? null : 1);
      if (s !== null) rows.push({ id: `case:${c.id}`, kind: 'case', title: c.name ?? c.id, meta: `${c.status ?? 'active'}${c.app_bundle_id ? ` · ${c.app_bundle_id.split('.').pop()}` : ''}`, ref: { kind: 'case', locator: c.id } });
    }
  } catch { /* templates table absent in some test DBs */ }

  // repos — local git log per registered repo (recent window, sha + subject)
  try {
    const repos = await listRepos(join(process.cwd(), 'repos'));
    for (const repo of repos.slice(0, 6)) {
      try {
        const { stdout } = await exec('git', ['log', '--pretty=%h%x09%s', '-n', '60'], { cwd: join(process.cwd(), 'repos', repo), timeout: 4_000, maxBuffer: 2 * 1024 * 1024 });
        for (const line of stdout.split('\n').filter(Boolean)) {
          const [sha, subject] = line.split('\t');
          if (!sha || !subject) continue;
          const s = query ? fuzzyScore(query, `${sha} ${subject}`) : 0.5;
          if (s !== null) rows.push({ id: `repo:${repo}:${sha}`, kind: 'repo', title: `${sha} ${subject.slice(0, 64)}`, meta: repo, ref: { kind: 'github-commit', locator: `${repo}/${sha}` } });
        }
      } catch { /* repo without git or unreadable — skip honestly */ }
    }
  } catch { /* no repos dir */ }

  // files — recent attachment manifest rows (store has no session column; recency suffices)
  try {
    const attRows = ctx.db.prepare('SELECT id, file_name, bytes FROM agent_attachments ORDER BY rowid DESC LIMIT 50').all() as Array<{ id: string; file_name: string; bytes: number }>;
    for (const a of attRows) {
      const s = fuzzyScore(query, a.file_name);
      if (s !== null) rows.push({ id: `att:${a.id}`, kind: 'file', title: a.file_name, meta: `${(a.bytes / 1024).toFixed(1)} KB`, ref: { kind: 'attachment', locator: a.id } });
    }
  } catch { /* attachments table absent — skip */ }

  // sort by score desc, cap 16 total, 6 per kind
  const capped: PaletteRow[] = [];
  const perKind = new Map<string, number>();
  const scored = rows
    .map((r) => ({ r, s: fuzzyScore(query, `${r.title} ${r.meta}`) ?? (query ? -1 : 1) }))
    .sort((a, b) => b.s - a.s);
  for (const { r } of scored) {
    const n = perKind.get(r.kind) ?? 0;
    if (n >= 6) continue;
    perKind.set(r.kind, n + 1);
    capped.push(r);
    if (capped.length >= 16) break;
  }
  return capped;
}

export function registerMentionRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // local tier — fast, synchronous budget (review MR3)
  app.get('/api/agent/refs/search', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const q = String((req.query as { q?: string }).q ?? '');
    const sessionId = String((req.query as { sessionId?: string }).sessionId ?? '') || undefined;
    const t0 = Date.now();
    const rows = await searchLocalRefs(ctx, q, sessionId);
    return { rows, tookMs: Date.now() - t0, tier: 'local' };
  });
}
