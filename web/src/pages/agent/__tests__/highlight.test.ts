/** highlight.ts — dependency-free syntax highlighting for agent chat.
 *  Token rules per language; escape-first (spans wrap ESCAPED text). */

import { describe, expect, it } from 'vitest';
import { highlightLine, normalizeLang } from '../highlight.ts';
import { renderMarkdown } from '../markdown.ts';

describe('normalizeLang', () => {
  it('maps families and defaults honestly', () => {
    expect(normalizeLang('SwiftUI')).toBe('swift');
    expect(normalizeLang('tsx')).toBe('ts');
    expect(normalizeLang('yml')).toBe('yaml');
    expect(normalizeLang('shell')).toBe('bash');
    expect(normalizeLang('patch')).toBe('diff');
    expect(normalizeLang('kotlin')).toBe('text');
  });
});

describe('highlightLine', () => {
  it('swift: keywords, strings, attributes, capitals-as-types', () => {
    const out = highlightLine('@State private var title: String = "hello"', 'swift');
    expect(out).toContain('hl-attr');
    expect(out).toContain('hl-kw');
    expect(out).toContain('hl-str');
    expect(out).toContain('hl-type');
  });

  it('yaml: keys, strings, booleans, comments, list dashes', () => {
    const k = highlightLine('steps:', 'yaml');
    expect(k).toContain('hl-key');
    const kv = highlightLine('  name: "login flow"', 'yaml');
    expect(kv).toContain('hl-key');
    expect(kv).toContain('hl-str');
    const b = highlightLine('  retry: true  # maybe', 'yaml');
    expect(b).toContain('hl-kw');
    expect(b).toContain('hl-cmt');
    const dash = highlightLine('- id: case_1', 'yaml');
    expect(dash).toContain('hl-punc');
    expect(dash).toContain('hl-key');
  });

  it('json: keys vs strings, numbers, literals', () => {
    const out = highlightLine('{"a": 1, "b": null, "c": "x"}', 'json');
    expect(out).toContain('hl-key');
    expect(out).toContain('hl-num');
    expect(out).toContain('hl-kw');
    expect((out.match(/hl-str/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('bash: vars, flags, comments', () => {
    const out = highlightLine('export PATH="$HOME/bin:$PATH" --verbose # note', 'bash');
    expect(out).toContain('hl-var');
    expect(out).toContain('hl-cmt');
  });

  it('diff: +/-/@@ coloring', () => {
    expect(highlightLine('+added', 'diff')).toContain('hl-add');
    expect(highlightLine('-gone', 'diff')).toContain('hl-del');
    expect(highlightLine('@@ -1,2 +1,3 @@', 'diff')).toContain('hl-meta');
  });

  it('ts: keywords + camel ids plain + capital types', () => {
    const out = highlightLine('const user = await repo.read<Case>(id);', 'ts');
    expect(out).toContain('hl-kw');
    expect(out).toContain('hl-type');
  });

  it('escapes HTML everywhere — model output is never trusted markup', () => {
    const evil = '<script>alert(1)</script> `x` "y"';
    for (const lang of ['swift', 'ts', 'yaml', 'json', 'bash', 'text'] as const) {
      const out = highlightLine(evil, lang);
      expect(out).not.toMatch(/<script/);  // no RAW markup ever survives
      expect(out).toContain('&lt;');
    }
  });
});

describe('markdown integration', () => {
  it('fenced swift block → highlighted pre with data-lang', () => {
    const md = '```swift\nlet x = 1 // hi\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('code-hl');
    expect(html).toContain('data-lang="swift"');
    expect(html).toContain('hl-kw');
    expect(html).toContain('hl-cmt');
  });

  it('unterminated fence (streaming) still renders highlighted-so-far', () => {
    const html = renderMarkdown('```yaml\nname: flow\n  retry: true');
    expect(html).toContain('code-hl');
    expect(html).toContain('hl-key');
  });

  it('yaml test-case blocks (the Lionidas staple) look right end-to-end', () => {
    const md = '```yaml\nsuite: smoke\ncases:\n  - id: login_ok\n    name: "Login succeeds"\n    steps:\n      - tap: {id: field_email}\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('data-lang="yaml"');
    expect(html).toContain('hl-key');
    expect(html).toContain('hl-str');
  });

  it('unknown language → plain escaped, no highlight spans, still chip', () => {
    const html = renderMarkdown('```kotlin\nval x = 1\n```');
    expect(html).toContain('data-lang="kotlin"');
    expect(html).not.toContain('hl-kw');
    expect(html).toContain('val x = 1');
  });
});
