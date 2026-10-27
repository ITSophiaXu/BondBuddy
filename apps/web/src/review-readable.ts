import { ReviewReadableReportSchema, type ReviewReadableReport } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import type { ApiClient } from './api';
import { businessReport, type BusinessReport } from './review-business-report';
import { businessControls, businessContent, businessFooter, type ReadableDownload } from './review-business-view';
import { reportBlockText } from './review-report-document';
import type { ReviewFollowupSource } from './review-followup';
import './review-readable.css';

const followupText = (text: string) => text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
export type ReadableReviewOptions = { downloads?: { runId: string; artifacts: readonly ReadableDownload[] } };

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
  private doc?: BusinessReport;
  private downloads: readonly ReadableDownload[] = [];
  constructor(private api: ApiClient, private project: string, private signal: AbortSignal, private onFollowup?: (source: ReviewFollowupSource) => void) {}
  mount(host: HTMLElement, run: string, options: ReadableReviewOptions = {}) {
    this.currentHost = host;
    this.downloads = options.downloads?.runId === run ? options.downloads.artifacts.map(artifact => ({ ...artifact })) : [];
    if (this.currentRun !== run) { this.currentRun = run; this.cache = undefined; this.doc = undefined; this.query = ''; this.selected = ''; this.open.clear(); this.failed = undefined; this.generation++; }
    host.onclick = event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
      if (target.dataset.readableFollowup && this.doc && this.cache?.status === 'available' && this.currentRun === this.cache.run_id) {
        const item = [...this.doc.dimensions, this.doc.other].flatMap(s => s.items).find(i => i.id === target.dataset.readableFollowup);
        if (item) this.onFollowup?.({ runId: this.cache.run_id, version: this.cache.execution_version, title: followupText(item.title), details: item.blocks.map(block => followupText(reportBlockText(block))) });
      }
      if (target.dataset.readableFollowupSection && this.doc && this.cache?.status === 'available' && this.currentRun === this.cache.run_id) {
        const section = [...this.doc.dimensions, this.doc.other].find(s => s.id === target.dataset.readableFollowupSection);
        if (section) this.onFollowup?.({ runId: this.cache.run_id, version: this.cache.execution_version, title: section.title, details: section.blocks.map(block => followupText(reportBlockText(block))) });
      }
      if (target.dataset.readableSection !== undefined) this.selectSection(target.dataset.readableSection);
      if (target.dataset.readableNext !== undefined) this.selectSection(target.dataset.readableNext, true);
      if (target.dataset.readableDirectory !== undefined) {
        const directory = this.currentHost?.querySelector<HTMLElement>('.readable-dimensions');
        directory?.scrollIntoView({ block: 'start' });
        const control = this.query.trim() ? this.currentHost?.querySelector<HTMLElement>('[data-readable-search]')
          : this.currentHost?.querySelector<HTMLElement>(`[data-readable-section="${CSS.escape(this.selected)}"]`);
        control?.focus({ preventScroll: true });
      }
      if (target.dataset.readableExpand && this.doc) { [...this.doc.dimensions, this.doc.other].forEach(s => s.items.forEach(i => target.dataset.readableExpand === 'all' ? this.open.add(i.id) : this.open.delete(i.id))); this.draw(); }
      if (target.dataset.readableRetry !== undefined) { this.failed = undefined; this.cache = undefined; this.draw(); void this.load(run); }
    };
    host.oninput = event => { if ((event.target as HTMLElement).matches('[data-readable-search]')) { this.query = (event.target as HTMLInputElement).value; this.content(); } };
    host.addEventListener('toggle', event => { const d = event.target as HTMLDetailsElement; if (d.dataset.readableItem) d.open ? this.open.add(d.dataset.readableItem) : this.open.delete(d.dataset.readableItem); }, true);
    this.draw(); if (!this.cache && this.loading !== run && this.failed !== run) void this.load(run);
  }
  private selectSection(section: string, scroll = false) {
    this.selected = section; this.query = ''; this.draw();
    const body = this.currentHost?.querySelector<HTMLElement>('.readable-body');
    if (scroll) body?.scrollIntoView({ block: 'start' });
    body?.focus({ preventScroll: true });
  }
  private async load(run: string) {
    this.loading = run; const generation = this.generation;
    try {
      const data = await this.api.request<ReviewReadableReport>('GET', `/projects/${encodeURIComponent(this.project)}/review-executions/${encodeURIComponent(run)}/readable-report`, undefined, {}, this.signal);
      if (this.signal.aborted || generation !== this.generation) return;
      if (!Value.Check(ReviewReadableReportSchema, data) || data.project_id !== this.project || data.run_id !== run || data.status === 'available' && (!data.markdown.trim() || !data.content_sha256)) throw Error('report identity');
      this.cache = data; this.doc = data.status === 'available' ? businessReport(data.markdown) : undefined;
      this.selected ||= 'financial';
    } catch { if (!this.signal.aborted && generation === this.generation) this.failed = run; }
    finally { if (generation === this.generation) { this.loading = undefined; if (!this.signal.aborted) this.draw(); } }
  }
  private draw() {
    const host = this.currentHost; if (!host?.isConnected) return;
    if (this.cache?.status === 'invalid_content') {
      const result = host.closest('.review-readable-result');
      const heading = result?.querySelector('h2'); if (heading) heading.textContent = '历史复核成果异常';
      result?.querySelectorAll<HTMLButtonElement>('[data-review-action="download"]').forEach(button => { button.textContent = '下载原文件（异常成果）'; });
      host.innerHTML = '<div class="readable-notice" role="alert">此报告只有内部进度信息或空正文，不能作为有效复核成果。历史任务曾登记为完成；原文件与原结算记录保留，费用需另行核对。</div>';
      return;
    }
    if (!this.doc) {
      const unavailable = this.failed === this.currentRun || this.cache?.status === 'unavailable';
      host.innerHTML = `<div class="readable-notice" role="status">${unavailable ? '页面正文暂时无法读取，已生成的 Word 仍可下载。' : '正在读取复核报告…'}${unavailable ? '<button class="text-btn" data-readable-retry>重新读取</button>' : ''}</div>`; return;
    }
    host.innerHTML = businessControls(this.doc, this.selected, this.query) + '<div class="readable-body" tabindex="-1"></div>';
    this.content();
  }
  private content() {
    const body = this.currentHost?.querySelector('.readable-body'); if (!body || !this.doc) return;
    body.innerHTML = businessContent(this.doc, this.selected, this.query, this.open, Boolean(this.onFollowup))
      + businessFooter(this.doc, this.selected, this.query, this.downloads);
  }
}
