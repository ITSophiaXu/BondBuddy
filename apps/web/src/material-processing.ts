import { type MaterialParseJob } from '@bondbuddy/contracts';
import { ApiError, type ApiClient, type Dto } from './api.js';
import { esc } from './ui.js';

type Material = Dto<'MaterialResponse'>;
type Reader = Pick<ApiClient, 'materialParseJob' | 'material'>;
type Entry = {
  material: Material; job?: MaterialParseJob; error?: string; loading: boolean; requested: boolean;
  controller?: AbortController; timer?: ReturnType<typeof setTimeout>; polls: number;
};
export const materialProcessingKey = (material: Material) => `${material.material_id}:${material.material_version}:${material.sha256}`;

function readError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 404) return '当前文件的处理状态不可访问，请刷新材料列表。';
    if (error.code === 'RATE_LIMITED') return '读取过于频繁，请稍后刷新。';
    if (error.code === 'CAPABILITY_NOT_READY' || error.status === 501) return '处理状态暂不可用，请稍后刷新。';
  }
  return '暂时无法读取处理状态。文件保存不受影响，请检查网络后刷新。';
}

function failureMessage(code: MaterialParseJob['error_code']) {
  switch (code) {
    case 'MATERIAL_ENCRYPTED': return '文件已加密，请上传未加密的副本。';
    case 'MATERIAL_UNREADABLE': return '暂时无法读取此文件，请重新导出并上传；仍失败时请联系支持。';
    case 'MATERIAL_CONTENT_MISMATCH': return '文件内容核验未通过，请检查文件并重新上传。';
    case 'MATERIAL_TOO_LARGE': return '文件内容过大，请拆分后重新上传。';
    case 'MATERIAL_FORMAT_UNSUPPORTED': return '暂不支持此文件格式，请转换后重新上传。';
    case 'MATERIAL_PARSE_TIMEOUT': return '文件处理超时，请稍后刷新状态；持续失败时请联系支持。';
    case 'CAPABILITY_NOT_READY': return '文件处理暂不可用，请稍后刷新状态或联系支持。';
    default: return '文件处理未完成，请稍后刷新状态；持续失败时请联系支持。';
  }
}

function jobSummary(job: MaterialParseJob): [string, string, string] {
  switch (job.state) {
    case 'queued': return ['pending', job.attempts ? '等待重新处理' : '等待处理', ''];
    case 'running': return ['pending', '处理中', '状态会自动更新，关闭页面不影响后台处理。'];
    case 'paused': return ['attention', '处理暂缓', '文件已上传，可稍后刷新状态或补充清晰的文字版文件。'];
    case 'failed': return ['error', '处理失败', failureMessage(job.error_code)];
    case 'cancelled': return ['attention', '处理已取消', '文件仍已保存，可重新上传或联系支持。'];
    // Completion describes the processing job, never verification of its evidence.
    // needs_confirmation remains in the backend; it is not an upload review task.
    case 'succeeded': return ['ready', '处理完成', ''];
  }
}

/** Read-only processing status for one authenticated project view. Source evidence stays in the backend. */
export class MaterialProcessing {
  private entries = new Map<string, Entry>();
  private disposed = false;
  private visible = true;
  private running = 0;
  constructor(private api: Reader, private projectId: string, private changed: () => void) {}

  sync(materials: Material[]) {
    if (this.disposed) return;
    const keys = new Set(materials.map(materialProcessingKey));
    for (const [key, entry] of this.entries) if (!keys.has(key)) {
      clearTimeout(entry.timer); entry.controller?.abort(); this.entries.delete(key);
    }
    for (const material of materials) {
      const key = materialProcessingKey(material);
      if (!this.entries.has(key)) this.entries.set(key, { material, loading: true, requested: true, polls: 0 });
    }
    this.pump();
  }

  refresh(key?: string) {
    if (this.disposed) return;
    for (const [id, entry] of this.entries) if (!key || key === id) {
      clearTimeout(entry.timer); entry.polls = 0;
      // A repeated click or reused upload joins the in-flight read.
      if (!entry.controller) { entry.requested = true; entry.loading = true; }
    }
    this.changed(); this.pump();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.refresh();
    else for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) { clearTimeout(entry.timer); entry.controller?.abort(); }
    this.entries.clear();
  }

  render(material: Material) {
    const key = materialProcessingKey(material), entry = this.entries.get(key);
    const summary = entry?.job ? jobSummary(entry.job) : ['pending', '正在读取处理状态…', ''];
    const [tone, title, hint] = entry?.error ? ['attention', '处理状态暂不可用', entry.error] : summary;
    const canRefresh = entry?.error || entry?.job && ['paused', 'failed', 'cancelled'].includes(entry.job.state);
    return `<div class="material-processing" data-material-processing="${esc(key)}" data-tone="${tone}">
      <p class="processing-title" role="status">${esc(title)}</p>${hint ? `<p class="processing-hint">${esc(hint)}</p>` : ''}
      ${canRefresh ? `<button type="button" class="text-button" data-processing-retry="${esc(key)}" ${entry.loading ? 'disabled' : ''}>${entry.loading ? '正在刷新…' : '刷新状态'}</button>` : ''}
    </div>`;
  }

  private pump() {
    if (this.disposed || !this.visible) return;
    for (const entry of this.entries.values()) {
      if (this.running >= 3) break;
      if (!entry.requested || entry.controller) continue;
      entry.requested = false; this.running++;
      void this.read(entry).finally(() => { this.running--; this.pump(); });
    }
  }

  private async read(entry: Entry) {
    const key = materialProcessingKey(entry.material), controller = new AbortController();
    entry.controller = controller;
    const current = () => !this.disposed && this.entries.get(key) === entry;
    const timeout = setTimeout(() => controller.abort(), 15000);
    const material = entry.material;
    try {
      const job = await this.api.materialParseJob(this.projectId, material.material_id, controller.signal);
      controller.signal.throwIfAborted();
      if (!current()) return;
      if (job.project_id !== this.projectId || job.material_id !== material.material_id || job.material_version !== material.material_version || job.material_sha256 !== material.sha256) {
        throw new Error('Material version mismatch');
      }
      entry.job = job; entry.error = undefined;
    } catch (error) {
      if (!current()) return;
      entry.job = undefined;
      entry.error = readError(error);
      if (error instanceof ApiError && error.status === 404) {
        try {
          const saved = await this.api.material(this.projectId, material.material_id, controller.signal);
          if (current() && !controller.signal.aborted && materialProcessingKey(saved) === key) entry.error = '文件已上传，暂未取得处理状态。请稍后刷新；持续未恢复时请联系支持。';
        } catch { /* Do not retain a previous status when access is no longer confirmed. */ }
      }
    } finally {
      clearTimeout(timeout);
      if (current()) {
        entry.controller = undefined; entry.loading = false; this.changed();
        // Paused, terminal and read-error states require explicit refresh. No fake percentages or unbounded error retries.
        if (this.visible && !entry.error && (entry.job?.state === 'queued' || entry.job?.state === 'running')) {
          entry.timer = setTimeout(() => { entry.requested = true; this.pump(); }, Math.min(3000 * 2 ** Math.min(entry.polls++, 3), 15000));
        }
      }
    }
  }
}
