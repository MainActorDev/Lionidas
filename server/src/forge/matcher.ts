/** Forge matcher: method + path pattern (exact/glob/regex) + guards,
 *  longest-path-wins, sequence cursors per preset+run. Pure — no I/O. */

export type MatchKind = 'exact' | 'glob' | 'regex';

export interface Preset {
  id: string;
  method: string; // uppercase or '*'
  pathPattern: string;
  match: MatchKind;
  guards?: { query?: Record<string, string>; headers?: Record<string, string> };
  status: number;
  headers?: Record<string, string>;
  bodyPath?: string;
  delayMs?: number;
  seq?: Array<{ status: number; bodyPath?: string; delayMs?: number }>;
  failure?: 'timeout' | 'reset' | 'malformed' | 'throttle';
  throttleKbps?: number;
}

export interface MatchRequest {
  method: string;
  path: string; // path only (no query)
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface MatchResult {
  preset: Preset;
  reason: string;
}

function pathMatches(pattern: string, kind: MatchKind, path: string): boolean {
  if (kind === 'exact') return pattern === path;
  if (kind === 'glob') {
    const re = new RegExp(
      `^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('.*')}$`,
    );
    return re.test(path);
  }
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}

function guardsPass(preset: Preset, req: MatchRequest): boolean {
  const g = preset.guards;
  if (!g) return true;
  if (g.query) {
    for (const [k, v] of Object.entries(g.query)) {
      if (req.query[k] !== v) return false;
    }
  }
  if (g.headers) {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) lower[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(g.headers)) {
      if (lower[k.toLowerCase()] !== v) return false;
    }
  }
  return true;
}

/** Longest pathPattern wins among method-matching, guard-passing presets. */
export function matchPreset(presets: Preset[], req: MatchRequest): MatchResult | null {
  const candidates = presets.filter(
    (p) => (p.method === '*' || p.method === req.method.toUpperCase()) && pathMatches(p.pathPattern, p.match, req.path) && guardsPass(p, req),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.pathPattern.length - a.pathPattern.length);
  const winner = candidates[0]!;
  return { preset: winner, reason: `match=${winner.match} pattern-len=${winner.pathPattern.length} beats ${candidates.length - 1} other(s)` };
}

/** Sequence cursor: advances per hit per (preset,run); last repeats. */
const cursors = new Map<string, number>();

export function seqIndex(presetId: string, runId: string | null): number {
  const key = `${presetId}|${runId ?? 'adhoc'}`;
  return cursors.get(key) ?? 0;
}

export function advanceSeq(presetId: string, runId: string | null): void {
  const key = `${presetId}|${runId ?? 'adhoc'}`;
  cursors.set(key, (cursors.get(key) ?? 0) + 1);
}

export function resetSeqForTests(): void {
  cursors.clear();
}
