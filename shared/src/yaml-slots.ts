/** Slot classification for the case-YAML editor's autocomplete: given the
 *  doc and a cursor offset, decide WHICH slot the user is typing in. Pure
 *  regex line-context (the format is line-shaped by construction —
 *  caseToYaml emits one line per step); NO yaml re-parse, NO CodeMirror
 *  dependency. Returns 'none' when unsure — the completion source then
 *  offers nothing (fails safe, never wrong). */
export type YamlSlot =
  | 'top-key'        // typing a top-level key (name/tags/app/steps)
  | 'step-action'    // right after "- " — offer action skeletons
  | 'body-key'       // typing a key inside an action's { … }
  | 'direction'      // after "scroll: "
  | 'alert-value'    // after "alert: "
  | 'on-value'       // after "on: " or "- expect: " — label/identifier vocab
  | 'contains-value' // after "contains: " — label-fragment vocab (labels ONLY)
  | 'runflow-name'   // after "runFlow: { name: " or "- runFlow: "
  | 'app-value'      // after "app: "
  | 'tag-value'      // inside tags: [ … ]
  | 'variant-id'     // right after "- " inside the variants: block
  | 'variant-key'    // a sibling key line inside a variant entry (4-space indent)
  | 'scenario-name'  // after "networkScenario: "
  | 'none';

export function slotAt(doc: string, cursor: number): YamlSlot {
  if (cursor < 0 || cursor > doc.length) return 'none';
  // current line start: the newline AT cursor-1 means cursor is already at a
  // line start (lastIndexOf would grab the PREVIOUS line's newline — off-by-one)
  const lineStart = cursor > 0 && doc[cursor - 1] === '\n' ? cursor : doc.lastIndexOf('\n', cursor - 1) + 1;
  const before = doc.slice(lineStart, cursor);   // this line's text before the cursor

  // inside a top-level tags list? (runs first: step lines never contain "tags:")
  if (/\btags:\s*\[[^\]]*$/.test(before)) return 'tag-value';

  // variants block scope: the nearest preceding top-level key above us is
  // "variants:" (scan backwards for a column-0 key line; stop at any other
  // top-level key — the variants block ends there).
  {
    let ls = lineStart;
    let inVariants = false;
    while (ls > 0) {
      const prevStart = doc.lastIndexOf('\n', ls - 2) + 1;
      const prevLine = doc.slice(prevStart, ls - 1);
      const m = /^([a-z][a-zA-Z]*):/.exec(prevLine);
      if (m) { inVariants = m[1] === 'variants'; break; }
      ls = prevStart;
    }
    if (inVariants) {
      // value side of networkScenario (cursor anywhere after the key on
      // this line — including mid-typed scenario names)
      if (/networkScenario:/.test(before)) return 'scenario-name';
      if (/^\s*-\s*$/.test(before) || /^\s*-\s*[a-z0-9_-]*$/.test(before)) return 'variant-id';
      if (/^\s{4}[a-zA-Z]*$/.test(before) && !before.includes(':')) return 'variant-key';
      return 'none';
    }
  }

  // step context
  const stepMatch = /^(\s*)-\s?/.exec(before);
  if (stepMatch) {
    const afterDash = before.slice(stepMatch[0].length);
    if (afterDash === '') return 'step-action';
    if (/^[a-z]+$/i.test(afterDash) && !/^[a-z]+\s*:/i.test(afterDash)) return 'step-action'; // action word not yet keyed
    const action = /^(\w+)\s*:/.exec(afterDash)?.[1];
    if (!action) return 'none';
    if (action === 'scroll') return 'direction';
    if (action === 'expect' && !afterDash.slice(action.length).includes('{')) return 'on-value'; // scalar expect
    if (action === 'runFlow') {
      return /\bname:\s*'?[^']*$/.test(afterDash) ? 'runflow-name' : 'none';
    }
    // tap / type / expect mapping: value position vs key position.
    // A brace was never opened or was already closed → nothing to type.
    const open = afterDash.lastIndexOf('{');
    const close = afterDash.lastIndexOf('}');
    if (open === -1 || (close !== -1 && close > open)) return 'none';
    const inside = afterDash.slice(open + 1);
    // typing a VALUE for on:/contains? (name: inside tap/type is not a valid key → ignore)
    const onVal = /\bon:\s*'?[^,}'"]*$/.test(inside);
    if (onVal) return 'on-value';
    const containsVal = /\bcontains:\s*'?[^,}'"]*$/.test(inside);
    if (containsVal) return 'contains-value';
    // typing a KEY (fragment after ", " or "{ " must look like a key fragment)
    const frag = inside.split(/,/).pop() ?? '';
    if (/^\s*[a-z]*$/i.test(frag)) return 'body-key';
    return 'none';
  }

  // top-level lines
  if (/^[a-z]*$/i.test(before.trim()) && before.trim() !== '') return 'top-key';
  if (before.trim() === '') return 'top-key';   // empty line at top level (new key)
  if (/^app:\s*/.test(before)) return 'app-value';
  return 'none';
}
