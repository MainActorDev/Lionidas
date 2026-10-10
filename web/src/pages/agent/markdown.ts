/** Minimal, dependency-free markdown → HTML for agent chat bubbles.
 *  Covers what the agents emit: headings, bold/italic/code, inline code,
 *  fenced code blocks, lists, links, paragraphs. Escapes HTML first —
 *  model output is never trusted markup. */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(md: string): string {
  let out = escapeHtml(md);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let inCode = false;
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = (): void => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('```')) {
      flushPara(); closeList();
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(`${escapeHtml(raw)}\n`); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h && h[1] !== undefined) {
      flushPara(); closeList();
      const lvl = h[1].length + 2;
      out.push(`<h${lvl}>${inline(h[2] ?? '')}</h${lvl}>`);
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      const item = (ul ?? ol)![1] ?? '';
      out.push(`<li>${inline(item)}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara(); closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
