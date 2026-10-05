import { ReviewReadableReportSchema, type ReviewReadableReport } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import type { ApiClient } from './api';
import { businessReport, type BusinessReport } from './review-business-report';
import { businessControls, businessContent } from './review-business-view';
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
  private doc?: BusinessReport;
  constructor(private api: ApiClient, private project: string, private signal: AbortSignal) {}
  mount(host: HTMLElement, run: string) {
    this.currentHost = host;
    if (this.currentRun !== run) { this.currentRun = run; this.cache = undefined; this.doc = undefined; this.query = ''; this.selected = ''; this.open.clear(); this.failed = undefined; this.generation++; }
    host.onclick = event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
      if (target.dataset.readableSection !== undefined) { this.selected = target.dataset.readableSection; this.query = ''; this.draw(); this.currentHost?.querySelector<HTMLElement>('.readable-body')?.focus({ preventScroll: true }); }
      if (target.dataset.readableExpand && this.doc) { [...this.doc.dimensions, this.doc.other].forEach(s => s.items.forEach(i => target.dataset.readableExpand === 'all' ? this.open.add(i.id) : this.open.delete(i.id))); this.draw(); }
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
      this.cache = data; this.doc = data.status === 'available' ? businessReport(data.markdown) : undefined;
      this.selected ||= 'financial';
    } catch { if (!this.signal.aborted && generation === this.generation) this.failed = run; }
    finally { if (generation === this.generation) { this.loading = undefined; if (!this.signal.aborted) this.draw(); } }
  }
  private draw() {
    const host = this.currentHost; if (!host?.isConnected) return;
    if (!this.doc) {
      const unavailable = this.failed === this.currentRun || this.cache?.status === 'unavailable';
      host.innerHTML = `<div class="readable-notice" role="status">${unavailable ? '页面正文暂时无法读取，已生成的 Word 仍可下载。' : '正在读取复核报告…'}${unavailable ? '<button class="text-btn" data-readable-retry>重新读取</button>' : ''}</div>`; return;
    }
    host.innerHTML = businessControls(this.doc, this.selected, this.query) + '<div class="readable-body" tabindex="-1"></div>';
    this.content();
  }
  private content() {
    const body = this.currentHost?.querySelector('.readable-body'); if (!body || !this.doc) return;
    body.innerHTML = businessContent(this.doc, this.selected, this.query, this.open);
  }
}
