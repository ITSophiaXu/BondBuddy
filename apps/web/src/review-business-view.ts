import { dimensionStatus, type BusinessReport, type BusinessSection } from './review-business-report.js';
import { reportBlockHtml, reportBlockText, reportInline } from './review-report-document.js';

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export function businessControls(doc: BusinessReport, selected: string, query: string): string {
  return `${doc.annotations.length ? `<details class="readable-next" data-annotation-summary><summary>原文批注与待确认定位</summary><div class="readable-prose">${doc.annotations.map(reportBlockHtml).join('')}</div></details>` : ''}<nav class="readable-dimensions" aria-label="三个复核维度">${doc.dimensions.map((s, i) => `<button data-readable-section="${s.id}" aria-current="${s.id === selected && !query ? 'true' : 'false'}"><span class="dimension-number">0${i + 1}</span><strong>${s.title}</strong><span class="dimension-status">${dimensionStatus(s)}</span><small>${s.description}</small></button>`).join('')}</nav><div class="readable-toolbar"><label>查找复核结果<input type="search" data-readable-search placeholder="搜索问题、金额或修改建议" value="${esc(query)}"></label><div><button class="text-btn" data-readable-expand="all">展开全部事项</button><button class="text-btn" data-readable-expand="none">收起事项</button></div></div>${doc.other.items.length || doc.other.blocks.length ? `<button class="text-btn readable-other" data-readable-section="other">其他需确认事项${doc.other.items.length ? `（${doc.other.items.length}）` : ''}</button>` : ''}`;
}
export function businessContent(doc: BusinessReport, selected: string, query: string, open: ReadonlySet<string>): string {
  const needle = query.trim().toLocaleLowerCase(), matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
  const all = [...doc.dimensions, doc.other];
  const sectionText = (s: BusinessSection) => [s.title, ...s.blocks.map(reportBlockText), ...s.items.map(i => i.title + '\n' + i.blocks.map(reportBlockText).join('\n'))].join('\n');
  const sections = all.filter(s => needle ? matches(sectionText(s)) : s.id === selected);
  return `${needle ? `<p class="readable-search-status" role="status">“${esc(query)}”的查找结果</p>` : ''}${sections.map(s => {
    const items = s.items.filter(i => !needle || matches(s.title) || matches(i.title + '\n' + i.blocks.map(reportBlockText).join('\n')));
    const explanation = s.blocks.map(reportBlockHtml).join('');
    const longExplanation = s.items.length && s.blocks.map(reportBlockText).join('').length > 600;
    const conclusion = !explanation ? !s.items.length ? '<div class="readable-notice">本次报告未提供这一维度的明确核验结论，暂不能判断是否存在问题。</div>' : ''
      : longExplanation ? `<details class="readable-next" ${needle ? 'open' : ''}><summary>核对说明与待确认事项</summary><div class="readable-prose">${explanation}</div></details>`
      : `<div class="readable-conclusion readable-prose">${explanation}</div>`;
    return `<section class="readable-section"><header><h3>${s.title}</h3><p class="readable-meta">${s.description}</p></header>${conclusion}${items.map(i => `<details class="readable-item" data-readable-item="${i.id}" ${needle || open.has(i.id) ? 'open' : ''}><summary><span class="readable-item-icon" aria-hidden="true">＋</span><strong>${reportInline(i.title)}</strong><span class="readable-item-hint">查看依据与建议</span></summary><div class="readable-prose">${i.blocks.map(reportBlockHtml).join('')}</div></details>`).join('')}</section>`;
  }).join('')}${!sections.length ? '<div class="readable-notice">没有找到匹配内容，请尝试其他关键词。</div>' : ''}${!needle && doc.actions.length ? `<details class="readable-next"><summary>建议处理顺序</summary><div class="readable-prose">${doc.actions.map(reportBlockHtml).join('')}</div></details>` : ''}`;
}
