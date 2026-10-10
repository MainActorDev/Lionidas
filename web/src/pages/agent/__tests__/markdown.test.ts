import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.ts';

describe('agent chat markdown renderer', () => {
  it('renders paragraphs, bold, inline code', () => {
    const html = renderMarkdown('Plain text with **bold** and `code`.');
    expect(html).toContain('<p>Plain text with <strong>bold</strong> and <code>code</code>.</p>');
  });

  it('renders bullet + numbered lists (the "…" truncation bug)', () => {
    const html = renderMarkdown('Plan:\n- first step\n- second step\n\nThen:\n1. check A\n2. check B');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>first step</li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>check B</li>');
  });

  it('renders fenced code blocks and headings, escapes HTML', () => {
    const html = renderMarkdown('## Heading\n\n```\ntap(<script>)\n```\n');
    expect(html).toContain('<h4>Heading</h4>');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('tap(&lt;script&gt;)');
    expect(html).not.toContain('<script>');
  });

  it('links only http(s) URLs', () => {
    const html = renderMarkdown('see [docs](https://example.com/a)');
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener">docs</a>');
  });
});

describe('agent chat markdown tables', () => {
  it('renders a GFM table with header, divider and body', () => {
    const md = '| case | status | notes |\n| --- | --- | --- |\n| login-empty | pass | fast path |\n| login-bad-pw | fail | **timeout** |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table><thead><tr>');
    expect(html).toContain('<th>case</th>');
    expect(html).toContain('<th>notes</th>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>login-empty</td>');
    expect(html).toContain('<td>pass</td>');
    expect(html).toContain('<td><strong>timeout</strong></td>');
    expect(html).toContain('</tbody></table>');
  });

  it('honors column alignment from the divider', () => {
    const md = '| a | b |\n| :--- | ---: |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:right">b</th>');
  });

  it('handles escaped pipes in cells', () => {
    const md = '| cmd | meaning |\n| --- | --- |\n| a\\|b | pipe |';
    const html = renderMarkdown(md);
    expect(html).toContain('<td>a|b</td>');
  });

  it('plain pipe-lines without a divider stay paragraphs', () => {
    const html = renderMarkdown('one | two\nthree | four');
    expect(html).toContain('one | two');
    expect(html).not.toContain('<table>');
  });

  it('closes the table when a non-pipe line follows', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\nDone.';
    const html = renderMarkdown(md);
    expect(html).toContain('</tbody></table>');
    expect(html).toContain('<p>Done.</p>');
  });
});

describe('evidence embeds', () => {
  it('renders image evidence inline', () => {
    const html = renderMarkdown('here: ![shot](evidence://ev_abc123/screenshot)');
    expect(html).toContain('<img alt="shot" src="/api/evidence/ev_abc123/file"');
  });
  it('renders video evidence inline', () => {
    const html = renderMarkdown('![run video](evidence://ev_v1/video)');
    expect(html).toContain('<video controls');
    expect(html).toContain('src="/api/evidence/ev_v1/file"');
  });
});
