import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Device boundary tripwire (Android prep, 2026-09-23).
 *
 *  Every server module that shells to xcrun/simctl is iOS-only by
 *  construction. The DeviceAdapter extraction (backlog #1, see
 *  brainstorm/20260923T133742Z-code-quality-assessment.md) moves these
 *  behind an interface before Android work starts — until then, this test
 *  pins the CURRENT set (17 files, incl. comment/help-string matches — see
 *  allowlist): new device operations must NOT add raw simctl call sites
 *  elsewhere. If this test fails on your change, either put the operation
 *  behind the (future) adapter, or — if the extraction already shipped and
 *  shrank this list — update the allowlist to match. */
const ALLOWED: ReadonlySet<string> = new Set([
  // TRUE set (measured by this test on 2026-09-23 — 17 files, not the 11 the
  // assessment's first grep found: matches in comments/help-strings count,
  // because a reader can't tell intent from a comment). Extraction shrinks
  // this list; prune entries as modules move behind the adapter.
  'diagnostics/extract.ts',
  'diagnostics/ingest.ts',
  'forge/routes.ts',
  'forge/sim-routing.ts',
  'manual/app-install.ts',
  'manual/apps.ts',
  'manual/packages.ts',
  // smoke gate (brainstorm 20261008T004500Z): post-build install/launch/alive
  // probe — the one legitimate new simctl consumer, reviewed here
  'projects/smoke.ts',
  'manual/keyboard-quiet.ts',
  'manual/location-tcc.ts',
  'manual/location.ts',
  'manual/playback.ts',
  'manual/viewtree.ts',
  'poll/devices.ts',
  'routes/devices.ts',
  'routes/manual.ts',
  'routes/monitoring.ts',
  'simdeck/holds.ts',
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('device boundary — raw simctl stays inside the known modules', () => {
  it('no new xcrun/simctl call sites outside the allowlist', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const p of walk(root)) {
      const rel = p.slice(root.length + 1);
      const text = readFileSync(p, 'utf8');
      if (/\bxcrun\b|\bsimctl\b/.test(text)) {
        seen.push(rel);
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
    }
    // allowlist entries that vanished (extraction happened) must be pruned —
    // keeps the set truthful instead of rotting
    const stale = [...ALLOWED].filter((a) => !seen.includes(a));
    expect(
      { offenders, staleAllowlistEntries: stale },
      'new device operations must go behind the DeviceAdapter (see test header) — do not add raw xcrun/simctl call sites',
    ).toEqual({ offenders: [], staleAllowlistEntries: [] });
  });
});
