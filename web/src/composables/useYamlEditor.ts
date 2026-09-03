/**
 * CodeMirror 6 wrapper — lazy: the editor bundle only loads when a YAML
 * panel actually opens. Axiom theme (black, ember keys, sand strings).
 * Exposed API stays tiny: value sync both ways, error-line highlighting,
 * ⌘↵ save. Types come from the real CM modules (no `any`).
 */
import { ref, type Ref, onBeforeUnmount } from 'vue';
import type { EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

export interface YamlEditorHandle {
  ready: Ref<boolean>;
  mount(el: HTMLElement, initial: string, onSave: () => void): Promise<void>;
  getValue(): string;
  setValue(v: string): void;
  setErrors(lines: number[]): void;
  destroy(): void;
}

export function useYamlEditor(): YamlEditorHandle {
  const ready = ref(false);
  let view: EditorView | null = null;
  let CM: typeof import('@codemirror/view') | null = null;
  let setDeco: ((lines: number[]) => void) | null = null;
  let saveCb: (() => void) | null = null;

  async function mount(el: HTMLElement, initial: string, onSave: () => void): Promise<void> {
    saveCb = onSave;
    const [viewMod, { yaml }, stateMod, languageMod, highlightMod, commandsMod] = await Promise.all([
      import('@codemirror/view'),
      import('@codemirror/lang-yaml'),
      import('@codemirror/state'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
      import('@codemirror/commands'),
    ]);
    const { StateField, StateEffect } = stateMod;
    const { Decoration } = viewMod;
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

    const theme = viewMod.EditorView.theme({
      '&': { backgroundColor: '#0a0a0a', color: '#f0f0f0', fontSize: '12.5px' },
      '.cm-content': { fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace", caretColor: '#ff5c1a', lineHeight: '1.65' },
      '.cm-gutters': { backgroundColor: '#0a0a0a', color: '#4a4a4a', border: 'none' },
      '.cm-activeLine': { backgroundColor: '#141414' },
      '.cm-activeLineGutter': { backgroundColor: '#141414', color: '#b4b4b4' },
      '.cm-selectionBackground': { backgroundColor: '#3a2213' },
      '&.cm-focused': { outline: 'none' },
      '.cm-error-line': { backgroundColor: 'rgba(229,72,77,0.10)' },
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
      provide: (f) => viewMod.EditorView.decorations.from(f),
    });
    setDeco = (lines: number[]) => { view?.dispatch({ effects: [setErrLines.of(lines)] }); };

    view = new viewMod.EditorView({
      doc: initial,
      parent: el,
      extensions: [
        viewMod.lineNumbers(),
        commandsMod.history(),
        viewMod.highlightActiveLine(),
        yaml(),
        languageMod.syntaxHighlighting(hl),
        theme,
        errorField,
        viewMod.keymap.of([
          { key: 'Mod-Enter', run: () => { saveCb?.(); return true; } },
          ...commandsMod.defaultKeymap,
          ...commandsMod.historyKeymap,
        ]),
      ],
    });
    CM = viewMod;
    ready.value = true;
  }

  function getValue(): string { return view ? view.state.doc.toString() : ''; }
  function setValue(v: string): void {
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
  function setErrors(lines: number[]): void { setDeco?.(lines); }
  function destroy(): void { view?.destroy(); view = null; CM = null; ready.value = false; }

  onBeforeUnmount(destroy);
  return { ready, mount, getValue, setValue, setErrors, destroy };
}
