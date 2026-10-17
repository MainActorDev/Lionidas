import type Database from 'better-sqlite3';
/** ensure state grammar (phase A S1, plan 20261017T112229Z): parse, errors,
 *  round-trip, completions vocabulary, slot classification, substitution
 *  carry-through, and the fail-loud engine stub (S3 replaces the stub with
 *  the convergence executor). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCaseYaml, caseToYaml } from '../../shared/src/case-yaml.ts';
import { buildCompletions } from '../../shared/src/yaml-completions.ts';
import { slotAt } from '../../shared/src/yaml-slots.ts';
import { substituteStep } from '../src/manual/template-env.ts';

const P = (steps: string) => `name: t\nsteps:\n${steps}`;

describe('ensure state — parse', () => {
  it('parses the scalar state id in setup AND mid-steps (decision Q2)', () => {
    const setup = parseCaseYaml(`name: t\napp: com.example.app\nsetup:\n  - ensure state: fresh_install\nsteps:\n  - expect: home_indicator`);
    expect(setup.errors).toHaveLength(0);
    expect(setup.case?.setup?.[0]).toMatchObject({ action: 'ensureState', ensureState: 'fresh_install' });

    const mid = parseCaseYaml(P('  - ensure state: on_home\n'));
    expect(mid.errors).toHaveLength(0);
    expect(mid.case?.steps[0]).toMatchObject({ action: 'ensureState', ensureState: 'on_home' });
  });

  it.each([
    ['uppercase', '  - ensure state: FreshInstall\n'],
    ['spaces', '  - ensure state: "two words"\n'],
    ['empty body', '  - ensure state:\n'],
    ['mapping body', '  - ensure state: { state: fresh_install }\n'],
    ['leading digit', '  - ensure state: 1st_state\n'],
  ])('rejects %s with the state-id shape error', (_n, y) => {
    const r = parseCaseYaml(P(y));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.message).toMatch(/ensure state takes a state id/);
  });

  it('error names the app states page (authoring surface)', () => {
    const r = parseCaseYaml(P('  - ensure state: NOPE\n'));
    expect(r.errors[0]?.message).toMatch(/registered on the app states page/);
  });
});

describe('ensure state — round-trip', () => {
  it('parse → emit → parse preserves the state id and narrate', () => {
    const src = P('  - ensure state: fresh_install\n') + '    narrate: Given a fresh install\n';
    const r = parseCaseYaml(src);
    expect(r.errors).toHaveLength(0);
    const out = caseToYaml(r.case!);
    expect(out).toContain('- ensure state: fresh_install');
    expect(out).toContain('narrate: Given a fresh install');
    const back = parseCaseYaml(out);
    expect(back.errors).toHaveLength(0);
    expect(back.case?.steps[0]).toMatchObject({ action: 'ensureState', ensureState: 'fresh_install', narrate: 'Given a fresh install' });
  });

  it('emits the scalar spelling for stored steps (no yaml form regression)', () => {
    const out = caseToYaml({ name: 't', tags: [], steps: [{ action: 'ensureState', ensureState: 'logged_in', idx: 0 }] });
    expect(out).toContain('- ensure state: logged_in');
  });
});

describe('ensure state — completions + slots', () => {
  it('step-action skeleton offers ensure state', () => {
    const cs = buildCompletions('step-action', { selectors: [], caseNames: [], apps: [], tags: [] }, '');
    const hit = cs.find((c) => c.label === 'ensure state');
    expect(hit).toMatchObject({ apply: 'ensure state: ', type: 'keyword' });
  });

  it('state-id slot completes from the appStates vocabulary, degrades to [] when absent', () => {
    const vocab = { selectors: [], caseNames: [], apps: [], tags: [], appStates: [{ state: 'fresh_install', bundle: 'com.x' }] };
    expect(buildCompletions('state-id', vocab, '')).toEqual([
      { label: 'fresh_install', detail: 'app state · com.x', apply: 'fresh_install', type: 'text' },
    ]);
    expect(buildCompletions('state-id', { selectors: [], caseNames: [], apps: [], tags: [] }, '')).toEqual([]);
  });

  it('slotAt classifies the value position after "ensure state: " and the partial two-word action', () => {
    const doc = 'name: t\nsteps:\n  - ensure state: fre';
    expect(slotAt(doc, doc.length)).toBe('state-id');
    expect(slotAt('name: t\nsteps:\n  - ensure sta', 25)).toBe('step-action');
  });
});

describe('ensure state — substitution carry-through (lesson c)', () => {
  it('substituteStep carries the field verbatim (no env refs in state ids)', () => {
    const out = substituteStep({ idx: 0, action: 'ensureState', ensureState: 'fresh_install' }, {});
    expect(out).toMatchObject({ action: 'ensureState', ensureState: 'fresh_install' });
    expect(out.error).toBeUndefined();
  });
});
