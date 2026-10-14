/** Recipe detection (plan 20261015T021000Z S1, review R3/R6): classify a cloned
 *  workspace's build recipe into an HONEST three-state report — never a silent
 *  discovery fallback. Pure pattern detection + at most one xcodebuild -list;
 *  no reasoning (that's the AI seat's job, slice 5).
 *
 *  States:
 *    found     — a recipe already exists: repo-committed lionidas.yml (root —
 *                wins by resolution law), .lionidas/lionidas.yml (legacy),
 *                or a repo lane (scripts/build-sim.sh / fastlane build_sim)
 *    derivable — no recipe, but the detector can produce a COMPLETE one
 *                (exactly one app scheme, configurations readable); the
 *                registration flow offers it as `generated: true — review me`
 *    blocked   — recipe impossible without more input; blockers carry the
 *                exact evidence (file/command refs). Includes NEEDS_SECRETS:
 *                secrets are a human gate, never AI-synthesized.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBuildManifest, type BuildManifest } from './manifest.ts';
import { discoverAppInputs } from './discovery.ts';

export type BlockerCode =
  | 'NOT_CLONED'
  | 'NO_APP_SCHEME'
  | 'SCHEME_AMBIGUOUS'
  | 'NEEDS_GENERATION'
  | 'PODS_UNINSTALLED'
  | 'MISSING_XCCONFIG'
  | 'NEEDS_SECRETS';

export interface Blocker {
  code: BlockerCode;
  detail: string;
  /** file:line, file path, or command whose output is the evidence */
  evidence: string;
}

export interface DetectedRecipe {
  transport: 'repo-lane' | 'generic';
  scheme: string | null;
  configuration: string | null;
  prepare: Array<{ run: string }>;
}

export type DetectionReport =
  | { state: 'found'; source: 'root-manifest' | 'dot-lionidas-manifest' | 'repo-lane'; recipe: DetectedRecipe; legacy?: boolean }
  | { state: 'derivable'; recipe: DetectedRecipe; generated: true; notes: string[] }
  | { state: 'blocked'; blockers: Blocker[] };

/** pattern files at root — the archetype matrix (review R6: possessed shapes only) */
export interface Archetypes {
  xcodeproj: boolean;      // committed .xcodeproj
  workspace: boolean;      // .xcworkspace
  podfile: boolean;
  xcodegen: boolean;       // project.yml
  tuist: boolean;          // Project.swift — blocked-with-evidence case
  spmApp: boolean;         // Package.swift at root — blocked-with-evidence case
  fastlaneLane: boolean;   // fastlane build_sim lane
  buildSimScript: boolean; // scripts/build-sim.sh
}

export function probeArchetypes(ws: string): Archetypes {
  const ex = (p: string): boolean => { try { return statSync(join(ws, p)).isFile(); } catch { return false; } };
  let entries: string[] = [];
  try { entries = readdirSync(ws); } catch { /* not cloned / unreadable */ }
  const a: Archetypes = {
    xcodeproj: entries.some((f) => f.endsWith('.xcodeproj') && statSync(join(ws, f)).isDirectory()),
    workspace: entries.some((f) => f.endsWith('.xcworkspace')),
    podfile: ex('Podfile'),
    xcodegen: ex('project.yml'),
    tuist: ex('Project.swift'),
    spmApp: ex('Package.swift'),
    fastlaneLane: false,
    buildSimScript: ex(join('scripts', 'build-sim.sh')),
  };
  try {
    const ff = join(ws, 'fastlane', 'Fastfile');
    if (existsSync(ff)) a.fastlaneLane = /lane\s+:build_sim\b/.test(readFileSync(ff, 'utf8'));
  } catch { /* unreadable Fastfile */ }
  return a;
}

function manifestToRecipe(m: BuildManifest): DetectedRecipe {
  return { transport: 'generic', scheme: m.scheme ?? null, configuration: m.configuration ?? null, prepare: m.prepare ?? [] };
}

/** gitignored-looking xcconfig referenced by project.yml but absent on disk.
 *  Evidence-based: only fires when project.yml NAMES a config path that isn't there. */
function missingXcconfigs(ws: string): Array<{ detail: string; evidence: string }> {
  try {
    const spec = readFileSync(join(ws, 'project.yml'), 'utf8');
    const missing: Array<{ detail: string; evidence: string }> = [];
    const re = /([A-Za-z0-9_/.-]+\.xcconfig)/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(spec)) !== null) {
      const rel = m[1]!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!existsSync(join(ws, rel))) missing.push({ detail: `project.yml references ${rel} which is absent (likely repo-ignored env config)`, evidence: `project.yml: ${rel}` });
    }
    return missing;
  } catch { return []; }
}

export function detectRecipe(ws: string): DetectionReport {
  if (!existsSync(join(ws, '.git')) && !existsSync(join(ws, 'project.yml')) && !readdirSafe(ws)) {
    return { state: 'blocked', blockers: [{ code: 'NOT_CLONED', detail: `no workspace at ${ws}`, evidence: ws }] };
  }
  const a = probeArchetypes(ws);

  // 1 ── repo-committed root manifest WINS (the repo speaking for itself)
  if (existsSync(join(ws, 'lionidas.yml'))) {
    try {
      const m = readBuildManifest(ws); // reads root first
      if (m) return { state: 'found', source: 'root-manifest', recipe: manifestToRecipe(m) };
    } catch (e) {
      return { state: 'blocked', blockers: [{ code: 'MISSING_XCCONFIG', detail: `root lionidas.yml is malformed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, evidence: 'lionidas.yml' }] };
    }
  }

  // 2 ── legacy .lionidas/ manifest: found, flagged for import nag
  if (existsSync(join(ws, '.lionidas', 'lionidas.yml'))) {
    try {
      const m = readBuildManifest(ws);
      if (m) return { state: 'found', source: 'dot-lionidas-manifest', recipe: manifestToRecipe(m), legacy: true };
    } catch { /* fall through to blocked with evidence below */ }
  }

  // 3 ── repo lane: the repo brings its own build story
  if (a.buildSimScript || a.fastlaneLane) {
    return { state: 'found', source: 'repo-lane', recipe: { transport: 'repo-lane', scheme: null, configuration: null, prepare: [] } };
  }

  // 4 ── derivable / blocked — needs a generated-or-committed project to list schemes
  const blockers: Blocker[] = [];
  if (a.tuist && !a.xcodeproj && !a.workspace) {
    blockers.push({ code: 'NEEDS_GENERATION', detail: 'Tuist repo (Project.swift) with no generated project — run tuist generate, or propose a recipe via /recipe-propose', evidence: 'Project.swift' });
  }
  if (a.spmApp && !a.xcodeproj && !a.workspace) {
    blockers.push({ code: 'NEEDS_GENERATION', detail: 'SPM package at root with no Xcode project — needs an app project or an SPM-aware recipe', evidence: 'Package.swift' });
  }
  if (a.xcodegen && !a.xcodeproj) {
    blockers.push({ code: 'NEEDS_GENERATION', detail: 'xcodegen repo without a generated .xcodeproj — a prepare step must run xcodegen generate', evidence: 'project.yml' });
    // xcconfig gaps are exactly what the intl drill caught — report them WITH the generation blocker
    for (const x of missingXcconfigs(ws)) blockers.push({ code: 'MISSING_XCCONFIG', detail: x.detail, evidence: x.evidence });
  }
  if (a.podfile && !existsSync(join(ws, 'Pods'))) {
    blockers.push({ code: 'PODS_UNINSTALLED', detail: 'CocoaPods repo with no Pods/ directory — prepare step must run pod install', evidence: 'Podfile' });
  }
  if (blockers.length) return { state: 'blocked', blockers };

  // project exists (committed or generated): list schemes — the ONLY xcodebuild call
  let schemes: string[] = [];
  let configurations: string[] = [];
  let listOk = true;
  try {
    const out = JSON.parse(execFileSync('xcodebuild', ['-list', '-json'], { cwd: ws, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).toString()) as { project?: { schemes?: string[]; configurations?: string[] } };
    schemes = out.project?.schemes ?? [];
    configurations = out.project?.configurations ?? [];
  } catch { listOk = false; }

  if (!listOk || schemes.length === 0) {
    return { state: 'blocked', blockers: [{ code: 'NO_APP_SCHEME', detail: listOk ? 'xcodebuild -list returned no schemes' : 'xcodebuild -list failed (no project to list, or generation needed)', evidence: 'xcodebuild -list -json' }] };
  }
  if (schemes.length > 1) {
    return { state: 'blocked', blockers: [{ code: 'SCHEME_AMBIGUOUS', detail: `${schemes.length} schemes found (${schemes.join(', ')}) — pin one via a recipe`, evidence: `xcodebuild -list: ${schemes.join(', ')}` }] };
  }
  const scheme = schemes[0]!;
  const configuration = configurations.includes('Debug') ? 'Debug' : (configurations[0] ?? null);
  return {
    state: 'derivable',
    recipe: { transport: 'generic', scheme, configuration, prepare: a.podfile ? [{ run: 'pod install' }] : [] },
    generated: true,
    notes: [
      `single app scheme '${scheme}' discovered via xcodebuild -list`,
      ...(a.podfile ? ['prepare derives from Podfile presence: pod install'] : []),
      'generated recipe — review before trusting (verify-build proves it)',
    ],
  };
}

function readdirSafe(ws: string): boolean {
  try { readdirSync(ws); return true; } catch { return false; }
}
