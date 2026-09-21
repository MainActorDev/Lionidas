/** Completion options per YAML slot — pure slot × vocabulary → options.
 *  Structural Completion shape (label/detail/apply/type) so this module has
 *  NO CodeMirror dependency; the editor glue maps it 1:1.
 *
 *  Quoting contract: value slots' `apply` is the FINAL doc text =
 *  yamlQuote(value) (dropdown `label` shows the RAW value). The CM source
 *  passes insideOpenQuote for cursor-in-quote contexts and callers then use
 *  the RAW value — that decision lives in the editor glue, not here. */
import type { YamlSlot } from './yaml-slots.ts';
import { yamlQuote } from './yaml-quote.ts';

export interface VocabSelector { value: string; kind: 'label' | 'identifier'; uses: number; cases: string[] }
export interface EditorVocabulary {
  selectors: VocabSelector[];
  caseNames: string[];
  apps: string[];
  tags: string[];
  /** phase B — variant completions; optional so old callers degrade to
   *  grammar-only exactly like a missing vocabulary does. */
  scenarios?: string[];
  variantIds?: string[];
}

export interface VocabCompletion {
  label: string;          // dropdown text (raw value / key / action name)
  detail?: string;        // right-aligned: kind · uses · source cases
  apply: string;          // FINAL inserted text (quoted for value slots)
  type?: 'keyword' | 'text' | 'function';
  boost?: number;
}

/** Body keys legal per action (mirrors the parser whitelist). */
const BODY_KEYS: Record<string, string[]> = {
  tap: ['point', 'on', 'contains', 'ignoreCase', 'optional', 'when'],
  type: ['point', 'text', 'on', 'contains', 'ignoreCase', 'optional', 'when'],
  expect: ['on', 'contains', 'ignoreCase', 'optional', 'when', 'count', 'atLeast'],
  runFlow: ['name', 'optional'],
  location: ['latitude', 'longitude'],
};

export function buildCompletions(slot: YamlSlot, vocab: EditorVocabulary, _typed: string, action?: string): VocabCompletion[] {
  switch (slot) {
    case 'top-key':
      return [
        { label: 'name', detail: 'case name (top of the file)', apply: 'name: ', type: 'keyword' },
        { label: 'tags', detail: 'list of tags for filtering', apply: 'tags: []', type: 'keyword' },
        { label: 'app', detail: 'bundle id this case runs against', apply: 'app: ', type: 'keyword' },
        { label: 'steps', detail: 'the recorded steps', apply: 'steps:\n  - ', type: 'keyword' },
        { label: 'setup', detail: 'declared preconditions — guarded steps that no-op when already satisfied', apply: 'setup:\n  - tap: { point: [0, 0], on: \'\', when: \'\' }\nsteps:\n  - ', type: 'keyword' },
        { label: 'alerts', detail: 'how system dialogs are answered run-wide: accept, dismiss, or fail (default)', apply: 'alerts: dismiss', type: 'keyword' },
        { label: 'variants', detail: 'state coverage — one flow, N deterministic worlds (scenario + env per variant)', apply: 'variants:\n  - id: \n    networkScenario: \n    env:\n      key: value', type: 'keyword' },
      ];
    case 'step-action':
      return [
        { label: 'tap', detail: 'tap a point (with an element ref)', apply: 'tap: { point: [0, 0], on: \'\' }', type: 'keyword' },
        { label: 'scroll', detail: 'scroll the screen', apply: 'scroll: down', type: 'keyword' },
        { label: 'type', detail: 'type text into a field', apply: 'type: { text: \'\', on: \'\' }', type: 'keyword' },
        { label: 'runFlow', detail: 'run another case by name', apply: 'runFlow: { name: \'\' }', type: 'keyword' },
        { label: 'expect', detail: 'assert an element is on screen', apply: 'expect: \'\'', type: 'keyword' },
        { label: 'alert', detail: 'accept or dismiss a system alert (no-op when none is up)', apply: 'alert: dismiss', type: 'keyword' },
        { label: 'location', detail: 'set the simulated GPS position (lat/lon)', apply: 'location: { latitude: -6.1754, longitude: 106.8272 }', type: 'keyword' },
      ];
    case 'variant-key':
      return [
        { label: 'id', detail: 'variant identifier ([a-z][a-z0-9_-]*)', apply: 'id: ', type: 'keyword' },
        { label: 'networkScenario', detail: 'network scenario name (deterministic responses for this variant)', apply: 'networkScenario: ', type: 'keyword' },
        { label: 'env', detail: 'env values for ${…} refs in steps', apply: 'env:\n      key: value', type: 'keyword' },
      ];
    case 'scenario-name':
      return (vocab.scenarios ?? []).map((sc) => ({ label: sc, detail: 'network scenario', apply: sc, type: 'text' as const }));
    case 'variant-id':
      return (vocab.variantIds ?? []).map((id) => ({ label: id, detail: 'variant id (used in another case)', apply: id, type: 'text' as const }));
    case 'direction':
      return (['up', 'down', 'left', 'right'] as const).map((d) => ({ label: d, apply: d, type: 'keyword' as const }));
    case 'alert-value':
      return (['accept', 'dismiss'] as const).map((v) => ({ label: v, detail: v === 'accept' ? 'tap the accept/default button' : 'tap the cancel/dismiss button', apply: v, type: 'keyword' as const }));
    case 'body-key': {
      const keys = BODY_KEYS[action ?? 'tap'] ?? BODY_KEYS['tap']!;
      const hints: Record<string, string> = {
        point: '[x, y] logical coordinates', on: 'element label or asset id', optional: 'true — a miss skips instead of failing',
        text: 'text to type', name: 'case name to run',
        contains: 'label CONTAINS this text (contains-mode matching)', ignoreCase: 'true — capitalization stops mattering for label matches',
        when: 'setup-only guard — skip this step unless this label fragment is visible',
        count: 'expect exactly N matches (default 1)', atLeast: 'expect N or more matches (existence without uniqueness)',
        latitude: 'decimal degrees, -90..90 (Jakarta ≈ -6.17)', longitude: 'decimal degrees, -180..180 (Jakarta ≈ 106.83)',
      };
      return keys.map((k): VocabCompletion => ({ label: k, detail: hints[k]!, apply: `${k}: `, type: 'keyword' }));
    }
    case 'contains-value':
      // label fragments ONLY — contains never applies to identifiers
      return vocab.selectors
        .filter((s) => s.kind === 'label')
        .map((s) => ({
          label: s.value,
          detail: `contains fragment · ${s.uses}× · ${s.cases.join(', ')}`,
          apply: yamlQuote(s.value),
          type: 'text' as const,
          boost: -s.uses,
        }));
    case 'on-value':
      return vocab.selectors.map((s) => ({
        label: s.value,
        detail: `${s.kind} · ${s.uses}× · ${s.cases.join(', ')}`,
        apply: yamlQuote(s.value),
        type: 'text' as const,
        boost: -s.uses,   // higher usage → rank boost (CM sorts ascending)
      }));
    case 'runflow-name':
      return vocab.caseNames.map((n) => ({
        label: n, detail: 'case', apply: yamlQuote(n), type: 'text' as const,
      }));
    case 'app-value':
      return vocab.apps.map((a) => ({ label: a, detail: 'recorded app', apply: a, type: 'text' as const }));
    case 'tag-value':
      return vocab.tags.map((t) => ({ label: t, detail: 'tag in use', apply: t, type: 'text' as const }));
    case 'none':
    default:
      return [];
  }
}
