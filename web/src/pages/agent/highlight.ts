/** Dependency-free syntax highlighting for agent chat code blocks.
 *  House philosophy (markdown.ts): zero deps, escape-first, model output is
 *  never trusted markup. A compact tokenizer covering the languages the
 *  agents actually emit: Swift, TS/JS, YAML, JSON, bash/sh, diff, plus a
 *  sane default. ~250 lines instead of a 300KB highlighter dependency.
 *
 *  Output: HTML with <span class="hl-*"> tokens; colors come from
 *  agent-theme.css (one palette, no inline styles). */

export type HlLang = 'swift' | 'ts' | 'js' | 'yaml' | 'json' | 'bash' | 'sh' | 'diff' | 'text';

export function normalizeLang(raw: string): HlLang {
  const l = raw.toLowerCase().trim();
  if (l === 'swift' || l === 'swiftui') return 'swift';
  if (['ts', 'typescript', 'tsx', 'mts', 'cts'].includes(l)) return 'ts';
  if (['js', 'javascript', 'jsx', 'mjs', 'cjs'].includes(l)) return 'js';
  if (l === 'yaml' || l === 'yml') return 'yaml';
  if (l === 'json') return 'json';
  if (l === 'bash' || l === 'zsh' || l === 'shell') return 'bash';
  if (l === 'sh') return 'sh';
  if (l === 'diff' || l === 'patch') return 'diff';
  return 'text';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const span = (cls: string, s: string): string => `<span class="hl-${cls}">${esc(s)}</span>`;

interface Rule { re: RegExp; cls: string | ((m: RegExpExecArray) => string) }

/** Run ordered rules over a line; first match wins at each position; plain
 *  text between matches stays escaped. Rules use sticky regexes. */
function tokenizeLine(line: string, rules: Rule[]): string {
  let out = '';
  let i = 0;
  outer: while (i < line.length) {
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(line);
      if (m && m.index === i) {
        const cls = typeof r.cls === 'function' ? r.cls(m) : r.cls;
        out += span(cls, m[0]);
        i += m[0].length || 1;
        continue outer;
      }
    }
    out += esc(line[i]!);
    i += 1;
  }
  return out;
}

const sticky = (src: string): RegExp => new RegExp(src, 'y');

// ── JSON ──
const JSON_RULES: Rule[] = [
  { re: sticky('"(?:[^"\\\\]|\\\\.)*"\\s*:'), cls: 'key' },
  { re: sticky('"(?:[^"\\\\]|\\\\.)*"'), cls: 'str' },
  { re: sticky('\\b(?:true|false|null)\\b'), cls: 'kw' },
  { re: sticky('-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'), cls: 'num' },
];

// ── YAML ──
function yamlLine(line: string): string {
  const m = /^(\s*)(-[ ])?(.*)$/.exec(line);
  if (!m) return esc(line);
  const indent = m[1] ?? '';
  const dash = m[2] ?? '';
  const rest = m[3] ?? '';
  if (rest.trim().startsWith('#')) return esc(line); // whole-line comment
  // key: value
  const kv = /^([A-Za-z0-9_.-]+|"[^"]*")(:\s*)(.*)$/.exec(rest);
  if (kv) {
    const key = kv[1] ?? '';
    const sep = kv[2] ?? '';
    const val = kv[3] ?? '';
    const valHtml = val.trim().startsWith('#') ? span('cmt', val) : tokenizeInlineValue(val);
    return esc(indent) + (dash ? span('punc', dash) : '') + span('key', key) + span('punc', sep) + valHtml;
  }
  if (dash) return esc(indent) + span('punc', dash) + tokenizeInlineValue(rest);
  return esc(line);
}
function tokenizeInlineValue(v: string): string {
  if (!v) return '';
  const vm = /^\s*(\||>)(.*)$/.exec(v);
  if (vm) return span('kw', vm[1] ?? '') + esc(vm[2] ?? ''); // block scalar indicator
  const sm = /^(\s*)(["'])(.*)$/.exec(v);
  if (sm?.[2] === '"' || sm?.[2] === "'") {
    const q = sm[2] ?? '';
    const body = v.slice(v.indexOf(q) + 1);
    const end = body.lastIndexOf(q);
    if (end >= 0) return esc(sm?.[1] ?? '') + span('str', q + body.slice(0, end) + q) + esc(body.slice(end + 1));
  }
  const num = /^(\s*)(-?\d+(?:\.\d+)?)(\s*(?:#.*)?)$/.exec(v);
  if (num) return esc(num[1] ?? '') + span('num', num[2] ?? '') + tokenizeComments(num[3] ?? '');
  const bool = /^(\s*)(true|false|null|~)(\s*(?:#.*)?)$/.exec(v);
  if (bool) return esc(bool[1] ?? '') + span('kw', bool[2] ?? '') + tokenizeComments(bool[3] ?? '');
  const anchor = /^(\s*)(&|\*[A-Za-z0-9_-]+)(.*)$/.exec(v);
  if (anchor) return esc(anchor[1] ?? '') + span('num', anchor[2] ?? '') + esc(anchor[3] ?? '');
  return tokenizeComments(v);
}
function tokenizeComments(v: string): string {
  const ci = v.indexOf(' #');
  if (ci >= 0) return esc(v.slice(0, ci)) + span('cmt', v.slice(ci));
  return esc(v);
}

// ── C-family (Swift/TS/JS share shape; Swift keywords added) ──
const C_KW = new Set(('const let var function return if else for while do switch case break continue class struct enum interface type extends implements import export from as new this super null undefined true false void static public private fileprivate internal open override final required init deinit func guard defer where in is as try catch throw throws async await rethrows some any actor protocol extension subscript operator associatedtype typealias mutates nonmutating weak lazy willSet didSet get set repeat then yield of instance sizeof Self self nil if guard else for in while repeat switch case default break continue return where catch throw defer func class struct enum protocol extension init deinit import export from as is in not and or'.split(/\s+/)));
const SWIFT_KW = new Set([...C_KW, 'let', 'var', 'func', 'guard', 'defer', 'where', 'subscript', 'associatedtype', 'typealias', 'deinit', 'fileprivate', 'open', 'internal', 'public', 'private', 'final', 'override', 'required', 'convenience', 'dynamic', 'lazy', 'weak', 'unowned', 'mutating', 'nonmutating', 'willSet', 'didSet', 'some', 'any', 'actor', 'async', 'await', 'throws', 'rethrows', 'inout', 'indirect', 'optional', 'required']);
const TS_KW = new Set([...C_KW, 'const', 'readonly', 'declare', 'namespace', 'abstract', 'implements', 'interface', 'type', 'enum', 'satisfies', 'keyof', 'infer', 'is', 'asserts', 'readonly', 'unique', 'unknown', 'never']);

function cRules(kws: Set<string>, types: Set<string>): Rule[] {
  return [
    { re: sticky('//.*'), cls: 'cmt' },
    { re: sticky('"(?:[^"\\\\]|\\\\.)*"'), cls: 'str' },
    { re: sticky("'(?:[^'\\\\]|\\\\.)*'"), cls: 'str' },
    { re: sticky('`(?:[^`\\\\]|\\\\.)*`'), cls: 'str' },
    { re: sticky('@[A-Za-z_][A-Za-z0-9_]*(?:\\([^)]*\\))?'), cls: 'attr' },   // Swift attributes / TS decorators
    { re: sticky('\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'), cls: 'num' },
    { re: sticky('\\b[A-Za-z_$][A-Za-z0-9_$]*\\b'), cls: (m) =>
      kws.has(m[0]) ? 'kw' : types.has(m[0]) ? 'type' : /^[A-Z]/.test(m[0]) ? 'type' : 'id' },
    { re: sticky('[{}()\\[\\].,;:]'), cls: 'punc' },
    { re: sticky('[=+\\-*/<>!&|^~?]+'), cls: 'op' },
  ];
}
const SWIFT_TYPES = new Set(['String', 'Int', 'Double', 'Float', 'Bool', 'Void', 'Any', 'AnyObject', 'Never', 'Result', 'Array', 'Dictionary', 'Set', 'Optional', 'URL', 'Date', 'Data', 'Error', 'Codable', 'Identifiable', 'View', 'Sendable', 'Task']);
const TS_TYPES = new Set(['string', 'number', 'boolean', 'object', 'unknown', 'never', 'any', 'void', 'Promise', 'Record', 'Array', 'Map', 'Set']);

const SWIFT_RULES = cRules(SWIFT_KW, SWIFT_TYPES);
const TS_RULES = cRules(TS_KW, TS_TYPES);
const JS_RULES = cRules(C_KW, TS_TYPES);

// ── bash/sh ──
const bashDoubleQuoted = (m: RegExpExecArray): string => {
  // highlight $vars INSIDE the quotes; the span wrapper escapes the whole match,
  // so rebuild manually: quote + interpolated body + quote
  const raw = m[0];
  const inner = raw.slice(1, -1);
  const body = inner.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, (v) => `\u0001${v}\u0002`);
  const html = body.split('\u0001').map((part, i) =>
    i === 0 ? esc(part) : (() => { const [v, ...rest] = part.split('\u0002'); return span('var', v ?? '') + esc(rest.join('\u0002')); })()
  ).join('');
  return `"${html}"`;
};
const BASH_RULES: Rule[] = [
  { re: sticky('#.*'), cls: 'cmt' },
  { re: sticky('"(?:[^"\\\\]|\\\\.)*"'), cls: bashDoubleQuoted },
  { re: sticky("'[^']*'"), cls: 'str' },
  { re: sticky('\\$\\{[^}]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$[0-9@*#?!]'), cls: 'var' },
  { re: sticky('^\\s*(?:export|declare|local|readonly)\\b'), cls: 'kw' },
  { re: sticky('\\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|exit|set|source|cd|echo|printf|export|local)\\b'), cls: 'kw' },
  { re: sticky('\\s(-{1,2}[A-Za-z][A-Za-z0-9-]*)'), cls: 'attr' },
  { re: sticky('\\b\\d+\\b'), cls: 'num' },
];

// ── diff ──
function diffLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return span('meta', line);
  if (line.startsWith('@@')) return span('meta', line);
  if (line.startsWith('+')) return span('add', line);
  if (line.startsWith('-')) return span('del', line);
  if (line.startsWith('diff ') || line.startsWith('index ')) return span('meta', line);
  return span('ctx', line);
}

/** Highlight one code line for a language. */
export function highlightLine(line: string, lang: HlLang): string {
  switch (lang) {
    case 'json': return tokenizeLine(line, JSON_RULES);
    case 'yaml': return yamlLine(line);
    case 'swift': return tokenizeLine(line, SWIFT_RULES);
    case 'ts': return tokenizeLine(line, TS_RULES);
    case 'js': return tokenizeLine(line, JS_RULES);
    case 'bash': case 'sh': return tokenizeLine(line, BASH_RULES);
    case 'diff': return diffLine(line);
    default: return esc(line);
  }
}

/** Highlight a whole code block (already fence-stripped, raw source). */
export function highlightBlock(src: string, langRaw: string): string {
  const lang = normalizeLang(langRaw);
  return src.replace(/\n$/, '').split('\n').map((l) => highlightLine(l, lang)).join('\n');
}
