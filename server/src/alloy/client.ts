/**
 * Alloy in-process client. The ONLY module that imports Alloy; everything else
 * goes through crucibleAlloy() (lint boundary + single choke point preserved).
 * Loads via Alloy's own engine resolution (gitignored config) — Crucible adds
 * zero engine knowledge of its own.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

export interface AlloyExports {
  dispatch: (tool: string, input: unknown, deps: unknown) => Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: unknown; engine?: string | null } }>;
  createServerState: () => { resolved: unknown; configError: string | null; health: unknown; leases: unknown };
  registerPhase0Tools: (deps: { state: unknown }) => void;
  LeaseManager: new () => unknown;
  routingTable: readonly { tool: string; engine: string; lease: string }[];
  [k: string]: unknown;
}

let cached: AlloyExports | null = null;
let testOverride: AlloyExports | null = null;

/** Test-only: swap the alloy implementation (fake dispatch) — prod code
 *  never calls this; without it, resolveAlloyPath + require run as before. */
export function __setAlloyForTest(fake: AlloyExports | null): void {
  testOverride = fake;
  cached = null;
}

function resolveAlloyPath(): string {
  const fromEnv = process.env['ALLOY_PATH'];
  if (fromEnv) {
    if (!existsSync(join(fromEnv, 'package.json'))) {
      throw new Error(`config: ALLOY_PATH invalid — no package.json at ${fromEnv}`);
    }
    return fromEnv;
  }
  const home = homedir();
  const cfgPath = join(home, '.alloy', 'crucible.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { alloyPath?: string };
    if (cfg.alloyPath && existsSync(join(cfg.alloyPath, 'package.json'))) return cfg.alloyPath;
    throw new Error(`config: ${cfgPath} alloyPath missing or invalid`);
  }
  // sibling-repo default (this workspace layout): <ai>/crucible/server/src/alloy → <ai>/alloy
  const sibling = new URL('../../../../alloy/', import.meta.url).pathname;
  if (existsSync(join(sibling, 'package.json'))) return sibling;
  throw new Error(
    'config: Alloy not found — set ALLOY_PATH or create ~/.alloy/crucible.json {"alloyPath": "..."} pointing at the alloy repo',
  );
}

export function crucibleAlloy(): AlloyExports {
  if (testOverride) return testOverride;
  if (cached) return cached;
  const alloyPath = resolveAlloyPath();
  const dist = join(alloyPath, 'dist', 'index.js');
  if (!existsSync(dist)) {
    throw new Error(`config: Alloy dist missing at ${dist} — run pnpm build in the alloy repo`);
  }
  // Engine-resolution prerequisite: Alloy reads ~/.alloy/engines.local.json itself.
  cached = require(dist) as AlloyExports;
  return cached;
}
