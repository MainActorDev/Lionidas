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
