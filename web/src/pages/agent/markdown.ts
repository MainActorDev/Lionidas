/** Minimal, dependency-free markdown → HTML for agent chat bubbles.
 *  Covers what the agents emit: headings, bold/italic/code, inline code,
 *  fenced code blocks, lists, links, paragraphs, GFM tables. Escapes HTML
 *  first — model output is never trusted markup. */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(md: string): string {
  let out = escapeHtml(md);
  // evidence embeds BEFORE other rules: ![](evidence://id) → real media tags
  out = out.replace(/!\[([^\]]*)\]\(evidence:\/\/([a-z0-9_]+)(?:\/(video|screenshot|diff|logs))?\)/g,
    (_m, alt: string, id: string, kind?: string) =>
      kind === 'video' || /video/i.test(alt)
        ? `<video controls preload="metadata" src="/api/evidence/${id}/file" class="ev-embed ev-video"></video>`
        : `<img alt="${alt}" src="/api/evidence/${id}/file" class="ev-embed" loading="lazy">`);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

/** Split a table row on unescaped pipes; drops leading/trailing edge pipes. */
function splitRow(line: string): string[] {
  let cells: string[] = [];
  // handle escaped pipes (\|) before splitting
  const marker = '\u0000';
  const masked = line.replace(/\\\|/g, marker);
  cells = masked.split('|').map((c) => c.trim().replace(new RegExp(marker, 'g'), '|'));
  if (cells.length > 1 && cells[0] === '') cells = cells.slice(1);
  if (cells.length > 1 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
  return cells;
}

const isDivider = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

const alignOf = (c: string): string => {
  const m = /^:?(-{2,}):?$/.exec(c);
  if (!m) return '';
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return ' style="text-align:center"';
  if (right) return ' style="text-align:right"';
  if (left) return ' style="text-align:left"';
  return '';
};

export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let inCode = false;
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  // table state: [] = none; [cells] = candidate header held; [-1] = inside a
  // table (header consumed); tableAligns carries the divider's alignments.
  let tableRows: string[][] = [];
  let tableAligns: string[] = [];

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
    if (!line.trim()) {
      flushPara(); closeList();
      if (tableRows[0]?.[0] === '__INTABLE__') out.push('</tbody></table>');
      tableRows = [];
      continue;
    }

    // GFM table: header row, then a divider row (|---|---|), then body rows
    if (line.includes('|')) {
      const cells = splitRow(line);
      if (tableRows.length === 1 && isDivider(cells)) {
        // we were sitting on the header — start the table
        flushPara(); closeList();
        const header = tableRows[0]!;
        const aligns = cells.map(alignOf);
        out.push('<table><thead><tr>');
        header.forEach((h, i) => { out.push(`<th${aligns[i] ?? ''}>${inline(h)}</th>`); });
        out.push('</tr></thead><tbody>');
        tableRows = [['__INTABLE__']]; // sentinel: in-table, header consumed
        continue;
      }
      if (tableRows.length > 0 && tableRows[0]?.[0] === '__INTABLE__') {
        // body row
        const row = cells;
        const aligns = tableAligns;
        out.push('<tr>');
        row.forEach((c, i) => { out.push(`<td${aligns[i] ?? ''}>${inline(c)}</td>`); });
        out.push('</tr>');
        continue;
      }
      if (tableRows.length === 0 && cells.length >= 2) {
        // candidate header — hold until divider confirms
        flushPara(); closeList();
        tableRows = [cells];
        continue;
      }
      if (tableRows.length >= 1 && tableRows[0]?.[0] !== '__INTABLE__') {
        // second pipe-line but not a divider — not a table; flush as paragraphs
        flushPara();
        closeList();
        out.push(`<p>${inline(tableRows[0]!.join(' | '))}</p>`);
        tableRows = [];
        para.push(line.trim());
        continue;
      }
    } else if (tableRows.length > 0 && tableRows[0]?.[0] !== '__INTABLE__') {
      // non-table line while holding a candidate header — release it
      flushPara(); closeList();
      out.push(`<p>${inline(tableRows[0]!.join(' | '))}</p>`);
      tableRows = [];
    }
    if (tableRows.length > 0 && tableRows[0]?.[0] === '__INTABLE__' && !line.includes('|')) {
      out.push('</tbody></table>');
      tableRows = [];
    }

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
  if (tableRows[0]?.[0] === '__INTABLE__') out.push('</tbody></table>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
