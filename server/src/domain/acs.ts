/** Flow-set scanning: AC metadata comes from fragment front-matter (PLAN §9).
 *  Reads, never guesses; unmapped flows run but cannot roll up. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export type AcCategory = 'visual' | 'interaction' | 'data-dependent' | 'temporal' | 'network-failure';

export interface FlowMeta {
  file: string;        // absolute path
  name: string;        // stem
  ticket: string | null;
  acId: string | null;
  acText: string | null;
  category: AcCategory | null;
  mapped: boolean;
}

export interface FlowSet {
  dir: string;
  flows: FlowMeta[];
  unmapped: FlowMeta[];
  duplicateAcError: string | null;
}

/** Parse TOP-LEVEL simple key: value lines (comment-aware). The engine's flow
 *  parser ignores unknown top-level keys, so /record fragments carry AC
 *  metadata as plain top-level fields — no --- front-matter (the engine's YAML
 *  loader rejects multi-document files). Only depth-0 keys count; nested maps
 *  (steps:) are skipped by indentation. */
function parseTopLevelMeta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) continue; // nested
    const line = rawLine;
    if (line.trimStart().startsWith('#')) continue;
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (m) {
      const v = m[2]!.trim();
      if (v.length > 0 && v !== '|' && v !== '>') out[m[1]!] = v.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

export function scanFlowSet(dir: string): FlowSet {
  if (!existsSync(dir)) throw new Error(`flows dir not found: ${dir}`);
  const flows: FlowMeta[] = [];
  const acOwner = new Map<string, string>(); // (ticket|acId) -> flow name
  let duplicateAcError: string | null = null;

  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml') || x.endsWith('.yml')).sort()) {
    const file = join(dir, f);
    const fm = parseTopLevelMeta(readFileSync(file, 'utf8'));
    const ticket = fm['ticket'] ?? null;
    const acId = fm['ac_id'] ?? null;
    const meta: FlowMeta = {
      file,
      name: basename(f).replace(/\.ya?ml$/, ''),
      ticket,
      acId,
      acText: fm['ac_text'] ?? null,
      category: (fm['category'] as AcCategory | undefined) ?? null,
      mapped: Boolean(ticket && acId && fm['ac_text']),
    };
    if (meta.mapped) {
      const key = `${ticket}|${acId}`;
      const owner = acOwner.get(key);
      if (owner !== undefined && owner !== meta.name) {
        duplicateAcError = `flows "${owner}" and "${meta.name}" both claim ${key}`;
      } else {
        acOwner.set(key, meta.name);
      }
    }
    flows.push(meta);
  }
  return { dir, flows, unmapped: flows.filter((x) => !x.mapped), duplicateAcError };
}
