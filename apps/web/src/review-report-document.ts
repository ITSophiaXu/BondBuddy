/** Tolerant presentation only. Unknown Markdown stays readable text, never executable HTML. */
export type ReportBlock = { kind: 'heading'; level: number; text: string } | { kind: 'paragraph' | 'quote' | 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] } | { kind: 'table'; headers: string[]; rows: string[][] } | { kind: 'rule' };
export type ReportItem = { id: string; title: string; blocks: ReportBlock[] };
export type ReportSection = { id: string; title: string; blocks: ReportBlock[]; items: ReportItem[] };
export type ReportDocument = { title: string; sections: ReportSection[]; itemCount: number };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tableCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
const heading = (line: string) => /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
const listLine = (line: string) => /^\s*(?:([-+*])|\d+[.)、])\s+(.+)$/.exec(line);
const plain = (text: string) => text.replace(/\*\*|__|`/g, '');

export function reportBlocks(markdown: string): ReportBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n'), blocks: ReportBlock[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]; if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) { const content: string[] = []; i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) content.push(lines[i++]);
      if (i < lines.length) i++; blocks.push({ kind: 'code', text: content.join('\n') }); continue;
    }
    const h = heading(line); if (h) { blocks.push({ kind: 'heading', level: h[1].length, text: plain(h[2]) }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && tableCells(lines[i + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      const headers = tableCells(line), rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
      blocks.push({ kind: 'table', headers, rows }); continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ kind: 'rule' }); i++; continue; }
    const list = listLine(line); if (list) { const ordered = !list[1], items: string[] = [];
      while (i < lines.length) { const m = listLine(lines[i]); if (!m || !m[1] !== ordered) break; items.push(m[2]); i++; }
      blocks.push({ kind: 'list', ordered, items }); continue;
    }
    if (/^>\s?/.test(line)) { const content: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i])) content.push(lines[i++].replace(/^>\s?/, '')); blocks.push({ kind: 'quote', text: content.join('\n') }); continue; }
    const content = [line]; i++;
    while (i < lines.length && lines[i].trim() && !heading(lines[i]) && !listLine(lines[i]) && !/^(?:>|```|~~~|---)/.test(lines[i])
      && !(lines[i].includes('|') && lines[i + 1] && tableCells(lines[i + 1]).every(s => /^:?-{3,}:?$/.test(s)))) content.push(lines[i++]);
    blocks.push({ kind: 'paragraph', text: content.join('\n') });
  }
  return blocks;
}

export function reportDocument(markdown: string): ReportDocument {
  const blocks = reportBlocks(markdown), sections: ReportSection[] = [];
  let title = '复核报告', current: ReportSection = { id: 'section-0', title: '报告概览', blocks: [], items: [] }, item: ReportItem | undefined;
  sections.push(current);
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === 1 && sections.length === 1 && !current.blocks.length && title === '复核报告') { title = block.text; continue; }
    if (block.kind === 'heading' && block.level <= 2) {
      current = { id: `section-${sections.length}`, title: block.text, blocks: [], items: [] }; sections.push(current); item = undefined; continue;
    }
    if (block.kind === 'heading' && block.level === 3 && /^(?:\d+[.．、)）]|[A-Z]{1,4}[-_]?\d+\b|问题\s*\d+)/i.test(block.text)) {
      item = { id: `${current.id}-item-${current.items.length + 1}`, title: block.text, blocks: [] }; current.items.push(item); continue;
    }
    (item?.blocks ?? current.blocks).push(block);
  }
  return { title, sections: sections.filter(s => s.blocks.length || s.items.length), itemCount: sections.reduce((n, s) => n + s.items.length, 0) };
}

/** Escaping precedes formatting; links are explicit HTTP(S), no remote images or raw HTML. */
export function reportInline(value: string): string {
  const tokens = /(`[^`\n]+`|!?\[[^\]\n]{1,1000}\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__)/g;
  let html = '', from = 0;
  for (const match of value.matchAll(tokens)) {
    html += escape(value.slice(from, match.index)); const token = match[0];
    const link = /^(!?)\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (link) {
      let safe = false; try { const url = new URL(link[3]); safe = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { /* Render as text. */ }
      html += !link[1] && safe ? `<a href="${escape(link[3])}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(link[2])}<span class="sr-only">（打开来源链接）</span></a>` : escape(token);
    } else if (token.startsWith('`')) html += `<code>${escape(token.slice(1, -1))}</code>`;
    else html += `<strong>${escape(token.slice(2, -2))}</strong>`;
    from = match.index! + token.length;
  }
  return html + escape(value.slice(from));
}
export const reportBlockText = (block: ReportBlock): string => 'text' in block ? block.text : block.kind === 'list' ? block.items.join('\n') : block.kind === 'table' ? [block.headers, ...block.rows].map(r => r.join(' ')).join('\n') : '';
export function reportBlockHtml(block: ReportBlock): string {
  switch (block.kind) {
    case 'heading': return `<h${Math.min(block.level + 1, 6)}>${reportInline(block.text)}</h${Math.min(block.level + 1, 6)}>`;
    case 'paragraph': return `<p>${reportInline(block.text).replace(/\n/g, '<br>')}</p>`;
    case 'quote': return `<blockquote>${reportInline(block.text).replace(/\n/g, '<br>')}</blockquote>`;
    case 'code': return `<pre><code>${escape(block.text)}</code></pre>`;
    case 'rule': return '<hr>';
    case 'list': { const tag = block.ordered ? 'ol' : 'ul'; return `<${tag}>${block.items.map(i => `<li>${reportInline(i)}</li>`).join('')}</${tag}>`; }
    case 'table': return `<div class="readable-table" tabindex="0" role="region" aria-label="报告表格，可横向滚动"><table><thead><tr>${block.headers.map(h => `<th scope="col">${reportInline(h)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map((cell, i) => `<td data-label="${escape(block.headers[i] ?? '')}">${reportInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
}
