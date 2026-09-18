/**
 * CodeMirror 6 wrapper — lazy: the editor bundle only loads when a YAML
 * panel actually opens. Axiom theme (black, ember keys, sand strings).
 * Exposed API stays tiny: value sync both ways, error-line highlighting,
 * ⌘↵ save. Types come from the real CM modules (no `any`).
 */
import { ref, type Ref, onBeforeUnmount } from 'vue';
import type { EditorView } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { DecorationSet } from '@codemirror/view';

export type EditorVocabulary = import('@crucible/shared/yaml-completions').EditorVocabulary;

export interface YamlEditorHandle {
  ready: Ref<boolean>;
  mount(el: HTMLElement, initial: string, onSave: () => void, vocab?: EditorVocabulary): Promise<void>;
  getValue(): string;
  setValue(v: string): void;
  setErrors(lines: number[]): void;
  /** CM-level read-only (EditorView.editable via Compartment). CSS
   *  pointer-events does NOT stop an already-focused editor — this does. */
  setEditable(editable: boolean): void;
  destroy(): void;
}

export function useYamlEditor(): YamlEditorHandle {
  const ready = ref(false);
  let view: EditorView | null = null;
  let setDeco: ((lines: number[]) => void) | null = null;
  let saveCb: (() => void) | null = null;
  // hoisted from mount(): the CM view module (needed by setEditable post-mount)
  let viewModRef: typeof import('@codemirror/view') | null = null;
  let editCompartment: import('@codemirror/state').Compartment | null = null;

  async function mount(el: HTMLElement, initial: string, onSave: () => void, vocab?: EditorVocabulary): Promise<void> {
    // no vocabulary (endpoint down / old caller) → grammar-only completions
    const theVocab: EditorVocabulary = vocab ?? { selectors: [], caseNames: [], apps: [], tags: [] };
    saveCb = onSave;
    const [cmView, { yaml }, stateMod, languageMod, highlightMod, commandsMod, autocompMod, slotsMod, complMod] = await Promise.all([
      import('@codemirror/view'),
      import('@codemirror/lang-yaml'),
      import('@codemirror/state'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
      import('@codemirror/commands'),
      import('@codemirror/autocomplete'),
      import('@crucible/shared/yaml-slots'),
      import('@crucible/shared/yaml-completions'),
    ]);
    const { StateField } = stateMod;
    const { Decoration } = cmView;
    const { tags } = highlightMod;
    const { HighlightStyle } = languageMod;

    const hl = HighlightStyle.define([
      { tag: tags.keyword, color: '#ff5c1a' },
      { tag: tags.string, color: '#d9a05b' },
      { tag: tags.number, color: '#7eb8da' },
      { tag: tags.bool, color: '#7eb8da' },
      { tag: tags.null, color: '#787878' },
      { tag: tags.comment, color: '#5a5a5a', fontStyle: 'italic' },
      { tag: tags.punctuation, color: '#787878' },
    ]);

    const theme = cmView.EditorView.theme({
      '&': { backgroundColor: '#0a0a0a', color: '#f0f0f0', fontSize: '12.5px' },
      '.cm-content': { fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace", caretColor: '#ff5c1a', lineHeight: '1.65' },
      '.cm-gutters': { backgroundColor: '#0a0a0a', color: '#4a4a4a', border: 'none' },
      '.cm-activeLine': { backgroundColor: '#141414' },
      '.cm-activeLineGutter': { backgroundColor: '#141414', color: '#b4b4b4' },
      '.cm-selectionBackground': { backgroundColor: '#3a2213' },
      '&.cm-focused': { outline: 'none' },
      '.cm-error-line': { backgroundColor: 'rgba(229,72,77,0.10)' },
      // completion dropdown: default CM styling is near-white and the editor
      // theme's white text renders the options INVISIBLE — theme it to Axiom
      // ⚠ CM6 theme rule: a scoped block accepts NESTED '& …' selectors only —
      // bare nested class selectors throw "should be a primitive value" and
      // kill mount() (learned live: the editor host stayed empty).
      '.cm-tooltip.cm-tooltip-autocomplete': {
        backgroundColor: '#141414',
        border: '1px solid #3a3a3a',
        borderRadius: '2px',
        color: '#f0f0f0',
        '& > ul': { fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace", fontSize: '12.5px', maxHeight: '220px' },
        '& > ul li': { color: '#f0f0f0', padding: '3px 8px' },
        '& > ul li[aria-selected]': { backgroundColor: '#3a2213', color: '#ff5c1a' },
        '& .cm-completionDetail': { color: '#787878', fontStyle: 'normal', marginLeft: '6px' },
        '& .cm-completionIcon': { display: 'none' },
      },
    });

    // error-line decoration: an effect drives a StateField → decorations.
    const setErrLines = stateMod.StateEffect.define<number[]>();
    const errorMark = Decoration.line({ class: 'cm-error-line' });
    const errorField = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update: (value, tr) => {
        for (const e of tr.effects) {
          if (e.is(setErrLines)) {
            const builder: number[] = [];
            for (const l of e.value) {
              const ln = Math.min(Math.max(l, 1), tr.state.doc.lines);
              builder.push(tr.state.doc.line(ln).from);
            }
            return builder.length
              ? Decoration.set(builder.map((from) => errorMark.range(from)))
              : Decoration.none;
          }
        }
        return value;
      },
      provide: (f) => cmView.EditorView.decorations.from(f),
    });
    setDeco = (lines: number[]) => { view?.dispatch({ effects: [setErrLines.of(lines)] }); };

    // slot-aware autocompletion: classify the cursor's slot, offer that
    // slot's options. `from` = start of the typed fragment; when the char
    // before it is an open quote, values apply RAW (already inside quotes —
    // applying the quoted form would double-quote).
    const completionSource = (ctx: CompletionContext): CompletionResult | null => {
      const doc = ctx.state.doc.toString();
      const slot = slotsMod.slotAt(doc, ctx.pos);
      if (slot === 'none') return null;
      const lineStart = doc.lastIndexOf('\n', ctx.pos - 1) + 1;
      const before = doc.slice(lineStart, ctx.pos);
      const fragMatch = /[A-Za-z0-9_'-]+$/.exec(before);
      const fragStart = fragMatch ? ctx.pos - fragMatch[0].length : ctx.pos;
      const charBefore = fragStart > lineStart ? doc[fragStart - 1] : '';
      const insideQuote = charBefore === `'`;
      // body-key needs the CURRENT action to scope legal keys
      let action: string | undefined;
      if (slot === 'body-key' || slot === 'on-value') {
        const line = doc.slice(lineStart, ctx.pos);
        action = /^\s*-\s+(\w+)\s*:/.exec(line)?.[1];
      }
      const typed = doc.slice(fragStart, ctx.pos);
      const options = complMod.buildCompletions(slot, theVocab, typed, action).map((c) => {
        const o: Completion = { label: c.label, apply: insideQuote && (slot === 'on-value' || slot === 'runflow-name') ? c.label : c.apply };
        if (c.detail !== undefined) o.detail = c.detail;
        if (c.type !== undefined) o.type = c.type;
        if (c.boost !== undefined) o.boost = c.boost;
        return o;
      });
      if (options.length === 0) return null;
      return { from: fragStart, options, validFor: /^[A-Za-z0-9_'-]*$/ };
    };

    editCompartment = new stateMod.Compartment();
    view = new cmView.EditorView({
      doc: initial,
      parent: el,
      extensions: [
        editCompartment.of(cmView.EditorView.editable.of(true)),
        cmView.lineNumbers(),
        commandsMod.history(),
        cmView.highlightActiveLine(),
        yaml(),
        languageMod.syntaxHighlighting(hl),
        theme,
        errorField,
        autocompMod.autocompletion({ override: [completionSource], activateOnTyping: true }),
        cmView.keymap.of([
          { key: 'Mod-Enter', run: () => { saveCb?.(); return true; } },
          ...autocompMod.completionKeymap,
          ...commandsMod.defaultKeymap,
          ...commandsMod.historyKeymap,
        ]),
      ],
    });
    viewModRef = cmView;
    ready.value = true;
  }


  function getValue(): string { return view ? view.state.doc.toString() : ''; }
  function setValue(v: string): void {
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
  function setErrors(lines: number[]): void { setDeco?.(lines); }
  function setEditable(editable: boolean): void {
    if (!view || !editCompartment || !viewModRef) return;
    view.dispatch({
      effects: editCompartment.reconfigure(viewModRef.EditorView.editable.of(editable)),
    });
  }
  function destroy(): void { view?.destroy(); view = null; ready.value = false; }

  onBeforeUnmount(destroy);
  return { ready, mount, getValue, setValue, setErrors, setEditable, destroy };
}
