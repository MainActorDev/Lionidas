/** Jira evidence comment — opt-in (env: JIRA_BASE, JIRA_EMAIL, JIRA_TOKEN).
 *  Comment-only by decision 5; disabled → 404 upstream. */
import type Database from 'better-sqlite3';

export interface JiraConfig {
  base: string;
  email: string;
  token: string;
  crucibleUrl: string;
}

export function jiraConfig(): JiraConfig | null {
  const base = process.env['JIRA_BASE'];
  const email = process.env['JIRA_EMAIL'];
  const token = process.env['JIRA_TOKEN'];
  if (!base || !email || !token) return null;
  return { base, email, token, crucibleUrl: process.env['CRUCIBLE_URL'] ?? 'http://127.0.0.1:8787' };
}

function adfParagraph(text: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function adfLink(text: string, href: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text: `${text}: ` }, { type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }] };
}

export function buildCommentBody(db: Database.Database, runId: string, cfg: JiraConfig): { ticket: string; body: unknown } | null {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
    | { id: string; ticket_key: string; status: string; artifact_hash: string | null; freshness: string }
    | undefined;
  if (!run) return null;
  const acs = db.prepare('SELECT ac_id, status FROM ac_results WHERE run_id = ? ORDER BY ac_id').all(runId) as Array<{ ac_id: string; status: string }>;
  const evidence = db
    .prepare(`SELECT id, type FROM evidence WHERE bundle_id = ? AND type IN ('video','diff') ORDER BY type`)
    .all(runId) as Array<{ id: string; type: string }>;
  const video = evidence.find((e) => e.type === 'video');
  const diff = evidence.find((e) => e.type === 'diff');
  const content: unknown[] = [
    adfParagraph(`Crucible run ${run.id}: ${run.status.toUpperCase()} — ${new Date().toISOString()}`),
    adfParagraph(`ACs: ${acs.length === 0 ? '—' : acs.map((a) => `${a.ac_id} ${a.status === 'pass' ? '●' : '▲'} ${a.status}`).join(' · ')}`),
    adfParagraph(`Artifact: ${run.artifact_hash?.slice(0, 12) ?? '—'}${run.freshness === 'stale_ignored' ? ' (⚠ older than source)' : ''}`),
  ];
  content.push(adfLink('Run detail', `${cfg.crucibleUrl}/runs/${run.id}`));
  if (video) content.push(adfLink('Video evidence', `${cfg.crucibleUrl}/api/evidence/${video.id}/file`));
  if (diff) content.push(adfLink('Worst diff', `${cfg.crucibleUrl}/api/evidence/${diff.id}/file`));
  return { ticket: run.ticket_key, body: { type: 'doc', version: 1, content } };
}

export async function postComment(cfg: JiraConfig, ticket: string, body: unknown): Promise<string> {
  const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
  const res = await fetch(`${cfg.base}/rest/api/3/issue/${encodeURIComponent(ticket)}/comment`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { id: string };
  return json.id;
}
