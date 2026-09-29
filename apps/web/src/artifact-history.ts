import { Value } from '@sinclair/typebox/value';
import { schemas } from '@bondbuddy/contracts';
import { ApiClient, ApiError, type Dto } from './api';
import { ArtifactDownloads, artifactError } from './artifact-download';
import { date, esc } from './ui';
import './artifact-history.css';

type History = Dto<'ArtifactHistoryResponse'>;
type Entry = History['items'][number];
type File = { artifact_id: string; version: number; label: string; variant?: 'revision' | 'clean' | 'baseline' };

function filesFor(entry: Entry): File[] {
  const delivery = entry.word_delivery;
  return delivery
    ? [{ ...delivery.revision, label: '修订版', variant: 'revision' },
      { ...delivery.clean, label: '清洁版', variant: 'clean' },
      { ...delivery.baseline, label: '有效基线', variant: 'baseline' }]
    : [{ ...entry.primary_artifact, label: 'Word 成果' }];
}

function validEntry(entry: Entry) {
  if (!((entry.state === 'succeeded' && entry.channel === 'production') ||
    (entry.state === 'test_completed' && entry.channel === 'non_production_test'))) return false;
  if (entry.word_delivery && (entry.word_delivery.revision.artifact_id !== entry.primary_artifact.artifact_id ||
    entry.word_delivery.revision.version !== entry.primary_artifact.version)) return false;
  const ids = filesFor(entry).map(file => file.artifact_id);
  return new Set(ids).size === ids.length;
}

export class ArtifactHistory {
  private controller = new AbortController();
  private generation = 0;
  private downloads = new ArtifactDownloads();
  private entries: Entry[] = [];
  private cursor: string | null = null;
  private seenCursors = new Set<string>();
  private pendingRows = new Set<string>();
  private statuses = new Map<string, string>();
  private loading = false;
  private error = '';

  constructor(private api: ApiClient, private projectId: string, private projectName: () => string, private host: HTMLElement) {}

  mount() {
    this.render();
    void this.refresh();
  }

  dispose() {
    this.generation++;
    this.controller.abort();
    this.downloads.dispose();
  }

  async refresh() {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.entries = [];
    this.cursor = null;
    this.seenCursors.clear();
    this.pendingRows.clear();
    this.statuses.clear();
    this.error = '';
    this.loading = false;
    await this.load();
  }

  private async load() {
    if (this.loading || this.controller.signal.aborted) return;
    this.loading = true;
    this.error = '';
    this.render();
    const generation = this.generation;
    const signal = this.controller.signal;
    const cursor = this.cursor;
    try {
      const page = await this.api.artifactHistory(this.projectId, cursor ?? undefined, signal);
      if (generation !== this.generation || signal.aborted) return;
      if (!Value.Check(schemas.ArtifactHistoryResponse, page) ||
        page.items.some(item => !validEntry(item) || this.entries.some(existing => existing.run_id === item.run_id)) ||
        new Set(page.items.map(item => item.run_id)).size !== page.items.length ||
        page.page.has_more !== (page.page.next_cursor !== null) ||
        (page.page.next_cursor !== null && (page.page.next_cursor === cursor || this.seenCursors.has(page.page.next_cursor)))) {
        throw new ApiError(0, 'DATA_UNAVAILABLE');
      }
      this.entries.push(...page.items);
      this.cursor = page.page.next_cursor;
      if (cursor) this.seenCursors.add(cursor);
    } catch (error) {
      if (generation === this.generation && !signal.aborted) this.error = error instanceof ApiError && error.status === 422
        ? '版本目录的分页位置已失效，请重新读取历史成果。' : artifactError(error);
    } finally {
      if (generation === this.generation && !signal.aborted) { this.loading = false; this.render(); }
    }
  }

  private render() {
    if (this.controller.signal.aborted) return;
    this.host.innerHTML = `<section class="panel word-history" aria-labelledby="word-history-title">
      <div class="word-history-heading"><div><h2 id="word-history-title">历史成果</h2><p class="muted">本项目已通过交付检查、当前可获取的 Word 版本。再次下载不会启动新任务。</p></div>
        <button class="text-button" type="button" data-history-refresh ${this.loading ? 'disabled' : ''}>重新读取历史成果</button></div>
      ${this.error ? `<p class="word-history-error" role="alert">${esc(this.error)}${this.entries.length ? ' 已加载的版本可逐份重新核验；目录可能不完整。' : ''}</p>` : ''}
      ${this.entries.length ? `<ol class="word-history-list">${this.entries.map((entry, index) => `<li class="word-history-item ${entry.channel === 'non_production_test' ? 'word-history-test' : ''}">
        <div class="word-history-row"><div><h3>募集说明书 · ${entry.word_delivery ? '更新稿' : 'Word 成果'}</h3>
        <p class="muted">输入版本 ${entry.input_revision} · 文件版本 ${entry.primary_artifact.version} · ${esc(date(entry.completed_at))}</p>
        <p class="muted">任务编号 ${esc(entry.run_id)} · ${entry.channel === 'production' ? '正式通道 · 已通过交付检查' : '内部测试工作稿 · 未经专业审核 · 不得对外使用'}</p></div>
        <div class="word-history-actions">${filesFor(entry).map((file, fileIndex) => `<button class="button ${fileIndex === 0 ? 'primary' : 'secondary'}" type="button" data-history-file="${index}:${fileIndex}" ${this.pendingRows.has(entry.run_id) ? 'disabled' : ''}>下载${file.label}</button>`).join('')}</div></div>
        ${!entry.word_delivery ? '<p class="muted">此历史成果未提供修订、清洁版和有效基线的分类信息。</p>' : ''}
        <p class="word-history-download-status" data-history-status="${index}" role="status">${esc(this.statuses.get(entry.run_id) ?? '')}</p></li>`).join('')}</ol>` :
        !this.loading && !this.error ? `<p class="muted word-history-empty">${this.cursor
          ? '这一页没有当前可获取的成果，可加载更多版本。'
          : '此前暂无可下载的 Word 成果；更新失败不会删除已交付的旧版本。'}</p>` : ''}
      ${this.loading ? '<p role="status">正在读取历史成果…</p>' : ''}
      ${this.cursor ? `<button class="button secondary" type="button" data-history-more ${this.loading ? 'disabled' : ''}>加载更多版本</button>` : ''}
    </section>`;
    this.host.querySelector<HTMLButtonElement>('[data-history-refresh]')!.addEventListener('click', () => { void this.refresh(); });
    this.host.querySelector('[data-history-more]')?.addEventListener('click', () => { void this.load(); });
    this.host.querySelectorAll<HTMLButtonElement>('[data-history-file]').forEach(button => {
      const [index, fileIndex] = button.dataset.historyFile!.split(':').map(Number);
      button.addEventListener('click', () => { void this.download(this.entries[index], filesFor(this.entries[index])[fileIndex]); });
    });
  }

  private async download(entry: Entry, file: File) {
    if (this.pendingRows.has(entry.run_id) || this.controller.signal.aborted) return;
    const signal = this.controller.signal;
    const generation = this.generation;
    this.pendingRows.add(entry.run_id);
    this.statuses.set(entry.run_id, '正在读取并核验文件…');
    this.render();
    try {
      const run = await this.api.run(entry.run_id, signal);
      if (generation !== this.generation || signal.aborted) return;
      if (run.run_id !== entry.run_id || run.project_id !== this.projectId || run.input_revision !== entry.input_revision ||
        run.state !== entry.state || run.channel !== entry.channel || run.artifact_id !== entry.primary_artifact.artifact_id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const artifact = await this.api.artifact(file.artifact_id, signal);
      if (generation !== this.generation || signal.aborted) return;
      const delivery = entry.word_delivery;
      if (artifact.artifact_id !== file.artifact_id || artifact.version !== file.version || artifact.run_id !== entry.run_id ||
        artifact.quality_status !== 'passed' || artifact.delivery_status !== (entry.channel === 'production' ? 'available' : 'test_only') ||
        (delivery ? !artifact.word_delivery || artifact.word_delivery.variant !== file.variant ||
          artifact.word_delivery.revision_artifact_id !== delivery.revision.artifact_id ||
          artifact.word_delivery.clean_artifact_id !== delivery.clean.artifact_id ||
          artifact.word_delivery.baseline_artifact_id !== delivery.baseline.artifact_id : artifact.word_delivery !== undefined)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const bytes = await this.api.artifactBytes(artifact, signal);
      if (generation !== this.generation || signal.aborted) return;
      this.downloads.save(bytes, `${this.projectName().slice(0, 16)}-输入${entry.input_revision}-${file.artifact_id}-${file.label}.docx`);
      this.statuses.set(entry.run_id, '文件已交给浏览器下载，请在浏览器下载列表中查看。');
    } catch (error) {
      if (generation === this.generation && !signal.aborted) this.statuses.set(entry.run_id, artifactError(error));
    } finally {
      if (generation === this.generation && !signal.aborted) { this.pendingRows.delete(entry.run_id); this.render(); }
    }
  }
}
