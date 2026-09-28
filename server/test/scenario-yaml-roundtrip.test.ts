import { describe, it, expect } from 'vitest';
import { parseScenarioYaml, scenarioToYaml } from '../../shared/src/scenario-yaml.ts';

/** Plan 20260928T092527Z rev 2 Stage 2 — scenario document round-trip.
 *  Review F9: no stored folder field; unknown keys rejected (explicit
 *  grammar); read-only render hints never parse back. */

const DOC = [
  'scenario: countries-sg',
  'id: s_c1265727',
  'presets:',
  '  - preset: p_1b58882e',
  '    enabled: true',
  '  - preset: p_deadbeef',
  '    enabled: false',
  "launch_arg: 'LP_COUNTRY=SG'",
].join('\n') + '\n';

describe('scenario-yaml round-trip', () => {
  it('parses the canonical form', () => {
    const r = parseScenarioYaml(DOC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toEqual({
      scenario: 'countries-sg',
      id: 's_c1265727',
      presets: [
        { preset: 'p_1b58882e', enabled: true },
        { preset: 'p_deadbeef', enabled: false },
      ],
      launchArg: 'LP_COUNTRY=SG',
    });
  });

  it('emit → parse is the identity (no folder field ever emitted — F9)', () => {
    const parsed = parseScenarioYaml(DOC);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = scenarioToYaml(parsed.doc);
    expect(out).not.toContain('folder:');
    const back = parseScenarioYaml(out);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.doc).toEqual(parsed.doc);
  });

  it('empty presets round-trip', () => {
    const out = scenarioToYaml({ scenario: 'x', id: 's_x', presets: [], launchArg: null });
    const back = parseScenarioYaml(out);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.doc.presets).toEqual([]);
    expect(back.doc.launchArg).toBeNull();
  });

  it('rejects unknown top-level keys (explicit grammar)', () => {
    const r = parseScenarioYaml(['scenario: x', 'id: s_x', 'presets:', '  []', 'launch_arg: ', 'wat: nope'].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('unknown key: wat'))).toBe(true);
  });

  it('rejects a stored folder: key (F9 — derived at read)', () => {
    const r = parseScenarioYaml(['scenario: x', 'id: s_x', 'folder: a/b', 'presets:', '  []', "launch_arg: ''"].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('folder: is derived'))).toBe(true);
  });

  it('rejects read-only render keys inside preset entries (storage stays minimal)', () => {
    const r = parseScenarioYaml(['scenario: x', 'id: s_x', 'presets:', '  - preset: p_1', '    method: GET'].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('unknown key in preset entry: method'))).toBe(true);
  });

  it('requires scenario + id', () => {
    const r = parseScenarioYaml('presets:\n  []\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('scenario: name is required'))).toBe(true);
    expect(r.errors.some((e) => e.message.includes('id: is required'))).toBe(true);
  });

  it('comments after values are stripped (id pin note survives parse)', () => {
    const r = parseScenarioYaml(['scenario: x', 'id: s_x  # stable pin', 'presets:', '  []', "launch_arg: ''"].join('\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.id).toBe('s_x');
  });

  it('emit includes read-only render hints that the parser rejects (display-only)', () => {
    const out = scenarioToYaml(
      { scenario: 'x', id: 's_x', presets: [{ preset: 'p_1', enabled: true }], launchArg: null },
      { p_1: { method: 'GET', path: '/v1/tariff', status: 200 } },
    );
    expect(out).toContain('# GET /v1/tariff → 200');
    const back = parseScenarioYaml(out);
    expect(back.ok).toBe(true); // the comment line is stripped, not parsed
  });
});
