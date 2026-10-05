import { ReviewReadableReportSchema, type ReviewReadableReport } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import type { ApiClient } from './api';
import { esc } from './ui';
import { reportDocument, reportBlockHtml, reportBlockText, reportInline, type ReportDocument } from './review-report-document';
import './review-readable.css';

/** Independent reader: a failed read must never hide the download or change the run. */
export class ReadableReview {
  private cache?: ReviewReadableReport;
  private loading?: string;
  private failed?: string;
  private currentRun?: string;
  private currentHost?: HTMLElement;
  private query = '';
  private selected = '';
  private open = new Set<string>();
  private generation = 0;
  private doc?: ReportDocument;
  constructor(private api: ApiClient, private project: string, private signal: AbortSignal) {}
  mount(host: HTMLElement, run: string) {
    this.currentHost = host;
    if (this.currentRun !== run) { this.currentRun = run; this.cache = undefined; this.doc = undefined; this.query = ''; this.selected = ''; this.open.clear(); this.failed = undefined; this.generation++; }
    host.onclick = event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
      if (target.dataset.readableSection !== undefined) { this.selected = target.dataset.readableSection; this.query = ''; this.draw(); this.currentHost?.querySelector<HTMLElement>('.readable-body')?.focus({ preventScroll: true }); }
      if (target.dataset.readableExpand) { this.doc?.sections.forEach(s => s.items.forEach(i => target.dataset.readableExpand === 'all' ? this.open.add(i.id) : this.open.delete(i.id))); this.draw(); }
      if (target.dataset.readableRetry !== undefined) { this.failed = undefined; this.cache = undefined; this.draw(); void this.load(run); }
    };
    host.oninput = event => { if ((event.target as HTMLElement).matches('[data-readable-search]')) { this.query = (event.target as HTMLInputElement).value; this.content(); } };
    host.addEventListener('toggle', event => { const d = event.target as HTMLDetailsElement; if (d.dataset.readableItem) d.open ? this.open.add(d.dataset.readableItem) : this.open.delete(d.dataset.readableItem); }, true);
    this.draw(); if (!this.cache && this.loading !== run && this.failed !== run) void this.load(run);
  }
  private async load(run: string) {
    this.loading = run; const generation = this.generation;
    try {
      const data = await this.api.request<ReviewReadableReport>('GET', `/projects/${encodeURIComponent(this.project)}/review-executions/${encodeURIComponent(run)}/readable-report`, undefined, {}, this.signal);
      if (this.signal.aborted || generation !== this.generation) return;
      if (!Value.Check(ReviewReadableReportSchema, data) || data.project_id !== this.project || data.run_id !== run || data.status === 'available' && (!data.markdown.trim() || !data.content_sha256)) throw Error('report identity');
      this.cache = data; this.doc = data.status === 'available' ? reportDocument(data.markdown) : undefined;
      this.selected ||= this.doc?.sections[0]?.id ?? '';
    } catch { if (!this.signal.aborted && generation === this.generation) this.failed = run; }
    finally { if (generation === this.generation) { this.loading = undefined; if (!this.signal.aborted) this.draw(); } }
  }
  private draw() {
    const host = this.currentHost; if (!host?.isConnected) return;
    if (!this.doc) {
      const unavailable = this.failed === this.currentRun || this.cache?.status === 'unavailable';
      host.innerHTML = `<div class="readable-notice" role="status">${unavailable ? '页面正文暂时无法读取，已生成的 Word 仍可下载。' : '正在读取复核报告…'}${unavailable ? '<button class="text-btn" data-readable-retry>重新读取</button>' : ''}</div>`; return;
    }
    host.innerHTML = `<div class="readable-toolbar"><label>搜索报告<input type="search" data-readable-search placeholder="搜索问题、章节、金额或建议" value="${esc(this.query)}"></label><div><button class="text-btn" data-readable-expand="all">展开全部事项</button><button class="text-btn" data-readable-expand="none">收起事项</button></div></div><div class="readable-layout"><nav class="readable-nav" aria-label="报告目录"><p>报告目录</p>${this.doc.sections.map((s, index) => `<button data-readable-section="${s.id}" aria-current="${this.selected === s.id ? 'true' : 'false'}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${esc(s.title)}</strong>${s.items.length ? `<small>${s.items.length}</small>` : ''}</button>`).join('')}<button data-readable-section="all" aria-current="${this.selected === 'all' ? 'true' : 'false'}"><span>↳</span><strong>阅读完整报告</strong></button></nav><div class="readable-body" tabindex="-1"></div></div>`;
    this.content();
  }
  private content() {
    const body = this.currentHost?.querySelector('.readable-body'); if (!body || !this.doc) return;
    const needle = this.query.trim().toLocaleLowerCase(), matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
    const sections = this.doc.sections.filter(s => needle ? matches([s.title, ...s.blocks.map(reportBlockText), ...s.items.map(i => i.title + '\n' + i.blocks.map(reportBlockText).join('\n'))].join('\n')) : this.selected === 'all' || s.id === this.selected);
    body.innerHTML = `${needle ? `<p class="readable-search-status" role="status">“${esc(this.query)}” · ${sections.length} 个章节有匹配</p>` : ''}${sections.map(s => {
      const items = s.items.filter(i => !needle || matches(s.title) || matches(i.title + '\n' + i.blocks.map(reportBlockText).join('\n')));
      return `<section class="readable-section"><header><p class="review-kicker">复核报告 · 正文</p><h3>${reportInline(s.title)}</h3>${s.items.length ? `<p class="readable-meta">${s.items.length} 条编号事项 · 点击查看位置、依据及建议</p>` : ''}</header><div class="readable-prose">${s.blocks.map(reportBlockHtml).join('')}</div>${items.map(i => `<details class="readable-item" data-readable-item="${i.id}" ${needle || this.open.has(i.id) ? 'open' : ''}><summary><span class="readable-item-icon" aria-hidden="true">＋</span><strong>${reportInline(i.title)}</strong><span class="readable-item-hint">查看详情</span></summary><div class="readable-prose">${i.blocks.map(reportBlockHtml).join('')}</div></details>`).join('')}</section>`;
    }).join('')}${!sections.length ? '<div class="readable-notice">没有找到匹配内容，请尝试其他关键词。</div>' : ''}`;
  }
}
