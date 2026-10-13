/** P2 — knowledge compilation (plan L4+L7, the LLM-wiki pattern): references
 *  (Jira subtask / GitHub PR / commit / attached doc / repo path) ingest via
 *  the existing connectors, then integrate INTO the app's persistent
 *  knowledge page — a versioned artifact that compounds across runs. Each
 *  run also saves an immutable snapshot for provenance. Contradictions with
 *  prior knowledge are FLAGGED (refined/refuted), never silently dropped. */
import type { ArtifactRow } from '@mainactordev/butler';
import { fileSource, repoSource } from './sources.ts';
import { ingest } from '@mainactordev/butler';
import type { SqliteStorage, StorageRetriever } from '@mainactordev/butler';

export type RefKind = 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo' | 'attachment' | 'case';

export interface PipelineRef {
  kind: RefKind;
  /** jira: issue key; github: PR/commit url or sha; doc/repo: filesystem path */
  locator: string;
  note?: string;
}

export interface CompiledKnowledge {
  appId: string;                 // knowledge page name: 'app:<bundle>'
  page: ArtifactRow;             // the new version of the living page
  snapshot: ArtifactRow;         // immutable per-run snapshot
  integrated: number;            // refs integrated this run
  contradictions: string[];      // flagged conflicts vs prior versions
}

/** headings carry per-ref provenance; the CONTRADICTIONS section is where
 *  integration flags conflicts instead of overwriting (D7/L7). */
function renderPage(appBundle: string, refs: Array<{ ref: PipelineRef; content: string }>, priorBody: string | null, contradictions: string[]): string {
  const lines: string[] = [`# Knowledge — ${appBundle}`, ''];
  if (priorBody) {
    lines.push('## Prior knowledge (carried forward)', '');
    // carry the prior page's sections forward verbatim; integration MERGES
    const priorSections = priorBody.split(/^## /m).filter((s) => s.trim() && !s.startsWith('Knowledge —'));
    for (const sec of priorSections) lines.push(`## ${sec.trim()}`, '');
  }
  lines.push('## Integrated this run', '');
  for (const { ref, content } of refs) {
    lines.push(`### [${ref.kind}] ${ref.locator}${ref.note ? ` — ${ref.note}` : ''}`, '', content.trim(), '');
  }
  if (contradictions.length) {
    lines.push('## Contradictions (flagged, not overwritten)', '');
    for (const c of contradictions) lines.push(`- ${c}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** naive-but-honest contradiction detection: a ref's content asserting the
 *  OPPOSITE of a prior line (pairs like has/has no, is/is not, before/after).
 *  Deliberately conservative — flags go to a human, false negatives are
 *  acceptable, false positives are noise. */
export function detectContradictions(priorBody: string | null, refContents: string[]): string[] {
  if (!priorBody) return [];
  const flags: string[] = [];
  const pairs: Array<[RegExp, RegExp]> = [
    [/\bhas no\b/i, /\bhas\b/i],
    [/\bis not\b/i, /\bis\b/i],
    [/\bcannot\b/i, /\bcan\b/i],
    [/\bnever\b/i, /\balways\b/i],
  ];
  for (const content of refContents) {
    for (const [neg, pos] of pairs) {
      const negMatch = priorBody.match(new RegExp(`[^.]*${neg.source}[^.]*\\.`, 'i'));
      const posMatch = content.match(new RegExp(`[^.]*${pos.source}(?!\\s*no\\b)[^.]*\\.`, 'i'));
      if (negMatch && posMatch) {
        const priorLine = negMatch[0].trim().slice(0, 120);
        const newLine = posMatch[0].trim().slice(0, 120);
        // same-ish subject? require a shared word ≥5 chars to cut noise
        const words = (l: string) => new Set(l.toLowerCase().match(/[a-z_]{5,}/g) ?? []);
        const shared = [...words(priorLine)].filter((w) => words(newLine).has(w));
        if (shared.length) flags.push(`prior: "${priorLine}" ⇄ new: "${newLine}" (shared: ${shared[0]})`);
      }
    }
  }
  return [...new Set(flags)].slice(0, 8);
}

export interface KnowledgeDeps {
  storage: SqliteStorage;
  retriever: StorageRetriever;
  artifactsDir: string;
  /** resolve a jira/github locator to text (fixture-safe: tests pass a fake) */
  fetchExternal?: (ref: PipelineRef) => Promise<string>;
  /** rev23 F5: attachment text by id (att_…) — text files merge, binaries emit their manifest line */
  readAttachment?: (id: string) => Promise<string | null>;
}

export async function compileKnowledge(
  appBundle: string,
  refs: PipelineRef[],
  deps: KnowledgeDeps,
  runId: string,
): Promise<CompiledKnowledge> {
  if (!refs.length) throw new Error('at least one reference is required');
  // 1) ingest: file/repo refs walk real trees; jira/github go through fetchExternal
  const integrated: Array<{ ref: PipelineRef; content: string }> = [];
  for (const ref of refs) {
    if (ref.kind === 'doc') {
      const r = await ingest(fileSource(ref.locator), deps.storage, { artifactsDir: deps.artifactsDir });
      const docs = r.documents.map((d) => d.title).join(', ');
      integrated.push({ ref, content: `file source ingested: ${docs || '(no documents)'} (${r.documents.length} docs, ${r.skipped} skipped)` });
    } else if (ref.kind === 'repo') {
      const r = await ingest(repoSource(ref.locator), deps.storage, { artifactsDir: deps.artifactsDir });
      integrated.push({ ref, content: `repo ingested with symbol chunks: ${r.documents.length} docs, ${r.skipped} skipped` });
    } else if (ref.kind === 'attachment') {
      const reader = deps.readAttachment ?? (() => Promise.resolve(null));
      const text = await reader(ref.locator);
      integrated.push({ ref, content: text ?? `[attachment ${ref.locator}] missing from store — skipped` });
    } else {
      const fetcher = deps.fetchExternal ?? (() => Promise.reject(new Error(`${ref.kind} fetch not configured (set AGENT_JIRA_* / AGENT_GITHUB_* or pass fetchExternal)`)));
      const content = await fetcher(ref);
      integrated.push({ ref, content });
    }
  }

  // 2) integrate into the LIVING page (versioned, compounding)
  const appId = `app:${appBundle}`;
  const prior = await deps.storage.latestArtifact('knowledge', appId);
  const contradictions = detectContradictions(prior?.body ?? null, integrated.map((i) => i.content));
  const body = renderPage(appBundle, integrated, prior?.body ?? null, contradictions);
  const provenance = JSON.stringify({ runId, refs: refs.map((r) => ({ kind: r.kind, locator: r.locator })), priorVersion: prior?.version ?? null });
  const page = await deps.storage.saveArtifact({ run_id: runId, session_id: null, kind: 'knowledge', name: appId, body, provenance_json: provenance });

  // 3) immutable snapshot of what THIS run saw
  const snapshotBody = renderPage(appBundle, integrated, null, contradictions);
  const snapshot = await deps.storage.saveArtifact({ run_id: runId, session_id: null, kind: 'knowledge-snapshot', name: `${appId}/run:${runId}`, body: snapshotBody, provenance_json: provenance });

  return { appId, page, snapshot, integrated: integrated.length, contradictions };
}
