/** Recipe detection (plan 20261015T021000Z S1) — the honest three-state gate.
 *  Fixtures are derived from REAL repo shapes (D2): committed-project ≈ ios-consumer,
 *  xcodegen ≈ ios-consumer-intl. Tuist/SPM are blocked-with-evidence cases (review R6).
 *  Live-repo checks run when the real clones exist (skipped otherwise — never invented). */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { detectRecipe, probeArchetypes } from '../src/projects/recipe-detect.ts';

import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url)); // the FILE's dir — vitest-neutral
const FX = join(HERE, 'fixtures', 'archetypes');

describe('detectRecipe — found', () => {
  it('root lionidas.yml WINS (the repo speaking for itself)', () => {
    const r = detectRecipe(join(FX, 'root-manifest'));
    expect(r).toMatchObject({ state: 'found', source: 'root-manifest' });
    if (r.state === 'found') {
      expect(r.recipe.scheme).toBe('App');
      expect(r.recipe.configuration).toBe('Debug');
      expect(r.legacy).toBeUndefined();
    }
  });

  it('.lionidas/lionidas.yml → found(legacy) with import nag flag', () => {
    const r = detectRecipe(join(FX, 'xcodegen'));
    expect(r).toMatchObject({ state: 'found', source: 'dot-lionidas-manifest', legacy: true });
    if (r.state === 'found') {
      expect(r.recipe.prepare).toEqual([{ run: '.lionidas/scripts/prepare-sim.sh' }]);
    }
  });

  it('repo lane (build-sim.sh or fastlane build_sim) → found, transport repo-lane', () => {
    const r = detectRecipe(join(FX, 'fastlane-lane'));
    expect(r).toMatchObject({ state: 'found', source: 'repo-lane' });
    if (r.state === 'found') expect(r.recipe.transport).toBe('repo-lane');
  });
});

describe('detectRecipe — blocked (with evidence)', () => {
  it('Podfile without Pods/ → PODS_UNINSTALLED, evidence Podfile', () => {
    const r = detectRecipe(join(FX, 'committed-project-nopods'));
    expect(r.state).toBe('blocked');
    if (r.state === 'blocked') {
      expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'PODS_UNINSTALLED', evidence: 'Podfile' }));
    }
  });

  it('xcodegen repo without project → NEEDS_GENERATION; referenced-but-absent xcconfig → MISSING_XCCONFIG', () => {
    const r = detectRecipe(join(FX, 'xcodegen-bare'));
    expect(r.state).toBe('blocked');
    if (r.state === 'blocked') {
      expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NEEDS_GENERATION', evidence: 'project.yml' }));
      expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'MISSING_XCCONFIG', evidence: expect.stringContaining('DevelopmentConfig.xcconfig') }));
    }
  });

  it('Tuist (Project.swift, no project) → NEEDS_GENERATION — blocked-with-evidence, NOT a green fixture (review R6)', () => {
    const r = detectRecipe(join(FX, 'tuist'));
    expect(r.state).toBe('blocked');
    if (r.state === 'blocked') {
      expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NEEDS_GENERATION', evidence: 'Project.swift' }));
    }
  });

  it('SPM package at root without a project → NEEDS_GENERATION', () => {
    const r = detectRecipe(join(FX, 'spm-app'));
    expect(r.state).toBe('blocked');
    if (r.state === 'blocked') {
      expect(r.blockers.some((b: { code: string }) => b.code === 'NEEDS_GENERATION')).toBe(true);
    }
  });

  it('uncloned path → NOT_CLONED (create-without-clone is honest)', () => {
    const r = detectRecipe(join(FX, 'does-not-exist'));
    expect(r.state).toBe('blocked');
    if (r.state === 'blocked') {
      expect(r.blockers[0]?.code).toBe('NOT_CLONED');
    }
  });
});

describe('detectRecipe — derivable', () => {
  it('committed project + Pods installed → derivable with pod-install prepare (needs xcodebuild on PATH; honest skip otherwise)', () => {
    const r = detectRecipe(join(FX, 'committed-project'));
    // machines without xcodebuild: the single -list call fails → blocked NO_APP_SCHEME —
    // assert the CONTRACT: either derivable-with-prepare or blocked-with-evidence, never a guess
    if (r.state === 'derivable') {
      expect(r.generated).toBe(true);
      expect(r.recipe.prepare).toEqual([{ run: 'pod install' }]);
      expect(r.notes.some((n: string) => n.includes('review'))).toBe(true);
    } else {
      expect(r.state).toBe('blocked');
      if (r.state === 'blocked') expect(['NO_APP_SCHEME', 'SCHEME_AMBIGUOUS', 'PODS_UNINSTALLED']).toContain(r.blockers[0]?.code);
    }
  });
});

describe('probeArchetypes — the matrix', () => {
  it('reads the pattern files', () => {
    expect(probeArchetypes(join(FX, 'xcodegen'))).toMatchObject({ xcodegen: true, tuist: false, podfile: false });
    expect(probeArchetypes(join(FX, 'tuist'))).toMatchObject({ tuist: true, xcodegen: false });
    expect(probeArchetypes(join(FX, 'fastlane-lane'))).toMatchObject({ fastlaneLane: true });
  });
});

describe('live repos (D2: detector also runs against reality — skipped when clones absent)', () => {
  const intl = join(HERE, '..', 'repos', 'ios-consumer-intl');
  const consumer = join(HERE, '..', 'repos', 'ios-consumer');
  it.skipIf(!existsSync(intl))('ios-consumer-intl → found (legacy .lionidas, import nag)', () => {
    const r = detectRecipe(intl);
    expect(r.state).toBe('found');
    if (r.state === 'found') {
      expect(r.source).toBe('dot-lionidas-manifest');
      expect(r.legacy).toBe(true);
      expect(r.recipe.scheme).toBe('LionParcelLogisticsINTL');
    }
  });
  it.skipIf(!existsSync(consumer))('ios-consumer → honest state (blocked-with-evidence or derivable; NEVER silent)', () => {
    const r = detectRecipe(consumer);
    expect(['found', 'derivable', 'blocked']).toContain(r.state);
    if (r.state === 'blocked') expect(r.blockers.length).toBeGreaterThan(0);
    if (r.state === 'derivable') expect(r.generated).toBe(true);
  });
});
