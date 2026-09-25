import { MARKET_LABELS, OFFERING_LABELS, MATERIAL_PARSE_OCR_STAGE, type MaterialParseJob, type Recognition } from '@bondbuddy/contracts';
import { ApiError, type ApiClient, type Dto } from './api.js';
import { esc, date } from './ui.js';

type Material = Dto<'MaterialResponse'>;
type Reader = Pick<ApiClient, 'materialParseJob' | 'sourceProfile' | 'material'>;
type Entry = {
  material: Material; job?: MaterialParseJob; profile?: Recognition;
  error?: string; profileError?: string; loading: boolean; requested: boolean;
  controller?: AbortController; timer?: ReturnType<typeof setTimeout>; polls: number;
};
export const materialProcessingKey = (material: Material) => `${material.material_id}:${material.material_version}:${material.sha256}`;

function readError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 404) return '当前材料或识别记录不可访问，请刷新材料列表。';
    if (error.code === 'RATE_LIMITED') return '读取过于频繁，请稍后重新读取。';
    if (error.code === 'CAPABILITY_NOT_READY' || error.status === 501) return '识别结果暂不可用，请稍后重新读取。';
  }
  return '暂时无法读取处理状态。文件保存不受影响，请检查网络后重新读取。';
}

function failureMessage(code: MaterialParseJob['error_code']) {
  switch (code) {
    case 'MATERIAL_ENCRYPTED': return '文件加密，无法解析。请提供可读取的副本。';
    case 'MATERIAL_UNREADABLE': return '文件无法解析。请检查原文件是否损坏，必要时重新导出并上传。';
    case 'MATERIAL_CONTENT_MISMATCH': return '文件内容核验未通过，请检查原文件并提供正确副本。';
    case 'MATERIAL_FORMAT_UNSUPPORTED': return '当前解析服务不支持此文件格式，请提供支持的格式。';
    case 'CAPABILITY_NOT_READY': return '所需解析能力暂不可用，请联系支持。';
    default: return '解析未完成，请稍后读取状态；持续失败时请联系支持。';
  }
}

function jobSummary(job: MaterialParseJob, role: Material['role']): [string, string, string] {
  switch (job.state) {
    case 'queued': return ['pending', job.attempts ? '等待重新解析' : '等待解析', '已进入处理队列，尚无可展示的完成进度。'];
    case 'running': return ['pending', job.stage === MATERIAL_PARSE_OCR_STAGE || job.stage === 'awaiting_ocr' || job.pending_capabilities.includes('ocr') ? '正在识别扫描内容（OCR）'
      : role === 'historical' && (job.completed_stages.includes('parse_evidence') || job.stage === 'historical_profile') ? '正在识别历史稿信息' : '正在解析内容', '处理状态会自动刷新，关闭页面不取消服务端任务。'];
    case 'paused': return ['attention', job.pending_capabilities.includes('ocr') || job.stage === 'awaiting_ocr' ? '等待文字识别（OCR）' : '解析已暂停', '内容尚未完整识别。可补充文字版材料；当前无法在此继续识别。'];
    case 'failed': return ['error', '解析失败', failureMessage(job.error_code)];
    case 'cancelled': return ['attention', '解析已取消', '原文件已保存，取消不代表解析成功。'];
    case 'succeeded': return job.outcome === 'needs_confirmation' || job.parse_status === 'needs_confirmation'
      ? ['attention', '解析结束 · 有待确认项', '部分内容仍需核对，不能视为材料完整或财务数据准确。']
      : ['ready', '解析完成', '已取得解析结果；仍需核对材料完整性与财务数据。'];
  }
}

type Source = Pick<Recognition['source_market'], 'status' | 'uncertainty' | 'raw_value'>;
function sourceNotes(field: Source) {
  const status = field.status === 'unknown' ? '未识别'
    : field.status === 'user_asserted' ? '用户提供 · 尚非核验事实'
    : field.status === 'needs_confirmation' || field.uncertainty.length ? '待确认' : '已识别';
  return `<p class="source-certainty">${status}</p>${field.uncertainty.length ? `<ul class="source-uncertainty">${field.uncertainty.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
    ${field.raw_value ? `<blockquote class="source-quote">原文：${esc(field.raw_value)}</blockquote>` : ''}`;
}

function renderProfile(profile: Recognition) {
  const state = { queued: '等待识别', analyzing: '识别中', ready: '源信息已识别', needs_confirmation: '源信息待确认', failed: '源信息识别失败' }[profile.state];
  return `<section class="source-profile" aria-label="历史稿识别结果"><h4>历史稿信息 <small>${state}</small></h4>
    <p class="source-note">以下来自历史稿，供更新难度评估使用。本次发行目标仍以项目表单为准。</p>
    <dl class="source-fields"><div><dt>原发行市场</dt><dd>${esc(profile.source_market.value ? MARKET_LABELS[profile.source_market.value] : '未识别')}${sourceNotes(profile.source_market)}</dd></div>
    <div><dt>原发行方式</dt><dd>${esc(profile.source_offering.value ? OFFERING_LABELS[profile.source_offering.value] : '未识别')}${sourceNotes(profile.source_offering)}</dd></div>
    <div><dt>最新报告截止日</dt><dd>${esc(profile.latest_reporting_cutoff.value ?? '未识别')}${sourceNotes(profile.latest_reporting_cutoff)}</dd></div></dl>
    <h5>原报告期</h5>${profile.reporting_periods.length ? `<ul class="source-periods">${profile.reporting_periods.map(period => `<li><p>${esc(period.start ?? '起始日待确认')} 至 ${esc(period.end ?? '截止日待确认')}</p><p>${period.period_kind === 'annual' ? '年度' : period.period_kind === 'interim' ? '中期' : '期间类型待确认'} · ${period.scope === 'consolidated' ? '合并口径' : period.scope === 'parent' ? '母公司口径' : '报表口径待确认'}</p>${sourceNotes(period)}</li>`).join('')}</ul>` : '<p class="source-note">未识别到有依据的报告期，不能用发行日或签署日代替。</p>'}
    <p class="source-note">来源：本文件第 ${profile.material_version} 版 · 识别结果第 ${profile.profile_version} 版。请对照原文件核对；源信息在线校正尚未开放。</p></section>`;
}

/** One instance per authenticated project view. Only reads; never enqueues, corrects or executes work. */
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
    const summary = entry?.job ? jobSummary(entry.job, material.role) : ['pending', '正在读取解析状态…', ''];
    const [tone, title, hint] = entry?.error ? ['attention', '处理状态暂不可用', entry.error] : summary;
    return `<div class="material-processing" data-material-processing="${esc(key)}" data-tone="${tone}">
      <p class="processing-title" role="status">${esc(title)}</p><p class="processing-hint">${esc(hint)}</p>
      ${entry?.job ? `<p class="processing-time">状态更新于 ${esc(date(entry.job.updated_at))}</p>` : ''}
      ${entry?.profile ? renderProfile(entry.profile) : ''}
      ${entry?.profileError ? `<p class="material-file-error">历史稿信息：${esc(entry.profileError)}</p>` : ''}
      <button type="button" class="text-button" data-processing-retry="${esc(key)}" ${!entry || entry.loading ? 'disabled' : ''}>${!entry || entry.loading ? '正在读取状态…' : '重新读取状态'}</button>
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
      entry.job = job; entry.error = undefined; entry.profile = undefined; entry.profileError = undefined;
      if (material.role === 'historical' && (job.profile_version !== null || job.completed_stages.includes('historical_profile') || job.state === 'succeeded')) {
        try {
          const profile = await this.api.sourceProfile(this.projectId, material.material_id, controller.signal);
          controller.signal.throwIfAborted();
          if (!current()) return;
          const sources = [profile.source_market, profile.source_offering, profile.latest_reporting_cutoff, ...profile.reporting_periods];
          if (profile.material_id !== material.material_id || profile.material_version !== material.material_version ||
              job.profile_version !== null && profile.profile_version < job.profile_version ||
              sources.some(field => field.provenance.material_id !== material.material_id || field.provenance.material_version !== material.material_version)) throw new Error('Profile version mismatch');
          entry.profile = profile;
        } catch (error) {
          if (!current()) return;
          entry.profileError = readError(error);
        }
      }
    } catch (error) {
      if (!current()) return;
      entry.job = undefined; entry.profile = undefined; entry.profileError = undefined;
      entry.error = readError(error);
      if (error instanceof ApiError && error.status === 404) {
        try {
          const saved = await this.api.material(this.projectId, material.material_id, controller.signal);
          if (current() && !controller.signal.aborted && materialProcessingKey(saved) === key) entry.error = '未找到当前版本的解析记录。文件已保存，可重新读取；持续未出现时请联系支持。';
        } catch { /* Do not retain a previous profile when access is no longer confirmed. */ }
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
