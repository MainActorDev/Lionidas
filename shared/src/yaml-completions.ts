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
  tap: ['point', 'on', 'optional'],
  type: ['point', 'text', 'on', 'optional'],
  expect: ['on', 'optional'],
  runFlow: ['name', 'optional'],
};

export function buildCompletions(slot: YamlSlot, vocab: EditorVocabulary, _typed: string, action?: string): VocabCompletion[] {
  switch (slot) {
    case 'top-key':
      return [
        { label: 'name', detail: 'case name (top of the file)', apply: 'name: ', type: 'keyword' },
        { label: 'tags', detail: 'list of tags for filtering', apply: 'tags: []', type: 'keyword' },
        { label: 'app', detail: 'bundle id this case runs against', apply: 'app: ', type: 'keyword' },
        { label: 'steps', detail: 'the recorded steps', apply: 'steps:\n  - ', type: 'keyword' },
      ];
    case 'step-action':
      return [
        { label: 'tap', detail: 'tap a point (with an element ref)', apply: 'tap: { point: [0, 0], on: \'\' }', type: 'keyword' },
        { label: 'scroll', detail: 'scroll the screen', apply: 'scroll: down', type: 'keyword' },
        { label: 'type', detail: 'type text into a field', apply: 'type: { text: \'\', on: \'\' }', type: 'keyword' },
        { label: 'runFlow', detail: 'run another case by name', apply: 'runFlow: { name: \'\' }', type: 'keyword' },
        { label: 'expect', detail: 'assert an element is on screen', apply: 'expect: \'\'', type: 'keyword' },
      ];
    case 'direction':
      return (['up', 'down', 'left', 'right'] as const).map((d) => ({ label: d, apply: d, type: 'keyword' as const }));
    case 'body-key': {
      const keys = BODY_KEYS[action ?? 'tap'] ?? BODY_KEYS['tap']!;
      const hints: Record<string, string> = {
        point: '[x, y] logical coordinates', on: 'element label or asset id', optional: 'true — a miss skips instead of failing',
        text: 'text to type', name: 'case name to run',
      };
      return keys.map((k): VocabCompletion => ({ label: k, detail: hints[k]!, apply: `${k}: `, type: 'keyword' }));
    }
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
