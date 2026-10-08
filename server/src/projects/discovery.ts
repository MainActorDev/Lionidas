/** Build-input discovery v2 (plan 20261007T164500Z T3/T7).
 *
 *  Type-aware, not name-based: candidates are shared schemes whose target
 *  productType is com.apple.product-type.application (parsed from the
 *  generated pbxproj). Bitrise's trust boundary — only what the repo
 *  declares is visible; xcodebuild -list on a clone returns shared schemes
 *  only. Multiple app schemes = ambiguity the CALLER must resolve
 *  (SCHEME_AMBIGUOUS); we never guess between apps.
 *
 *  Also carries the repo-shape probe (T7): what the workspace looks like
 *  drives the generic engine (xcodegen step, -workspace vs -project). */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface DiscoveredInputs {
  appSchemes: string[];
  configurations: string[];
}

export type RepoShape = 'xcodegen' | 'xcodeproj' | 'workspace' | 'unknown';

/** pbxproj native-target section → names of application-type targets.
 *  Line-based parse (stable xcodegen/xcodeplst output); returns [] on any
 *  unreadable input — callers fall back, never crash (plan risk note). */
function applicationTargets(pbxprojPath: string): string[] {
  let s: string;
  try {
    s = readFileSync(pbxprojPath, 'utf8');
  } catch {
    return [];
  }
  const i0 = s.indexOf('Begin PBXNativeTarget section');
  const i1 = s.indexOf('End PBXNativeTarget section');
  if (i0 < 0 || i1 < 0) return [];
  const out: string[] = [];
  let name: string | null = null;
  let ptype: string | null = null;
  for (const line of s.slice(i0, i1).split('\n')) {
    const t = line.trim();
    const m = /\/\* (.+?) \*\/ = \{$/.exec(t);
    if (m) { name = m[1] ?? null; ptype = null; continue; }
    const pt = /productType = "?([^";]+)"?;/.exec(t);
    if (pt) ptype = pt[1] ?? null;
    if (t === '};' && name) {
      if (ptype === 'com.apple.product-type.application') out.push(name);
      name = null; ptype = null;
    }
  }
  return out;
}

/** Locate the xcodeproj/workspace at the repo root (workspace wins —
 *  Jenkins precedence). Returns null when neither exists. */
function containerAt(ws: string): { kind: 'project' | 'workspace'; path: string } | null {
  let entries: string[] = [];
  try { entries = readdirSync(ws); } catch { return null; }
  const workspace = entries.find((f) => f.endsWith('.xcworkspace'));
  if (workspace) return { kind: 'workspace', path: join(ws, workspace) };
  const proj = entries.find((f) => f.endsWith('.xcodeproj'));
  if (proj) return { kind: 'project', path: join(ws, proj) };
  return null;
}

/** Repo-shape probe: how the generic engine must treat this workspace. */
export function probeRepoShape(ws: string): RepoShape {
  if (existsSync(join(ws, 'project.yml'))) return 'xcodegen';
  if (containerAt(ws)?.kind === 'workspace') return 'workspace';
  if (containerAt(ws)?.kind === 'project') return 'xcodeproj';
  return 'unknown';
}

/** App schemes + configurations for a workspace clone. Requires the
 *  .xcodeproj to exist (xcodegen repos: generate first). */
export function discoverAppInputs(ws: string): DiscoveredInputs {
  const container = containerAt(ws);
  const projDir = container?.kind === 'workspace'
    ? join(ws, container.path.replace(/\.xcworkspace$/, '').split('/').pop() ?? '')
    : container?.path ?? '';
  let schemes: string[] = [];
  let configurations: string[] = [];
  try {
    const out = JSON.parse(execFileSync('xcodebuild', ['-list', '-json'], {
      cwd: ws, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    }).toString()) as { project?: { schemes?: string[]; configurations?: string[] } };
    schemes = out.project?.schemes ?? [];
    configurations = out.project?.configurations ?? [];
  } catch { /* no xcodebuild / not generated yet */ }
  const appTargets = projDir ? applicationTargets(join(projDir, 'project.pbxproj')) : [];
  // app schemes = shared schemes that name an application target (exact name
  // match; xcodegen emits schemes named after targets). When the pbxproj is
  // unreadable, fall back to all non-Tests schemes with a semantic kept
  // honest by the caller's ambiguity check.
  const appSchemes = appTargets.length > 0
    ? schemes.filter((s) => appTargets.includes(s.replace(/-(Staging|Production|Release|Debug)$/i, '')) || appTargets.includes(s))
    : schemes.filter((s) => !/Tests?$/i.test(s));
  return { appSchemes, configurations };
}
