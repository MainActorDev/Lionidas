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
  | 'on-value'       // after "on: " or "- expect: " — label/identifier vocab
  | 'runflow-name'   // after "runFlow: { name: " or "- runFlow: "
  | 'app-value'      // after "app: "
  | 'tag-value'      // inside tags: [ … ]
  | 'none';

export function slotAt(doc: string, cursor: number): YamlSlot {
  if (cursor < 0 || cursor > doc.length) return 'none';
  // current line start: the newline AT cursor-1 means cursor is already at a
  // line start (lastIndexOf would grab the PREVIOUS line's newline — off-by-one)
  const lineStart = cursor > 0 && doc[cursor - 1] === '\n' ? cursor : doc.lastIndexOf('\n', cursor - 1) + 1;
  const before = doc.slice(lineStart, cursor);   // this line's text before the cursor

  // inside a top-level tags list? (runs first: step lines never contain "tags:")
  if (/\btags:\s*\[[^\]]*$/.test(before)) return 'tag-value';

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
    // typing a VALUE for on:? (name: inside tap/type is not a valid key → ignore)
    const onVal = /\bon:\s*'?[^,}'"]*$/.test(inside);
    if (onVal) return 'on-value';
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
