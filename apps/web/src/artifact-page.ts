import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { date, esc } from './ui';
import './artifact-page.css';

type Artifact = Dto<'ArtifactResponse'>;
type Variant = NonNullable<Artifact['word_delivery']>['variant'];
const variants: Record<Variant, { label: string; description: string }> = {
  revision: { label: '修订版', description: '查看本轮增删修改；待人工确认标记仍需逐项核对。' },
  clean: { label: '清洁版', description: '查看接受本轮修订后的工作稿；保留未解决的待人工确认标记。' },
  baseline: { label: '有效基线', description: '本轮修改前的有效正文副本，用于对照；上传原件保持不变。' }
};

function resultError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return '成果或下载授权不可用，请重新读取；也可能已移除或不属于当前账号。';
    if (error.code === 'DATA_UNAVAILABLE') return '成果文件暂时无法读取或校验未通过，请稍后重试。';
    return friendlyError(error);
  }
  return '连接中断，成果尚未读取完成，请重试。';
}

export class ArtifactPage {
  private controller = new AbortController();
  private generation = 0;
  private objectUrls = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private api: ApiClient, private shell: (html: string, section: string) => void, private current: () => boolean) {}

  dispose() {
    this.generation++;
    this.controller.abort();
    for (const [url, timer] of this.objectUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    this.objectUrls.clear();
  }

  async render(id: string) {
    this.controller.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;
    const signal = this.controller.signal;
    this.shell('<a class="back-link" href="#/">← 返回我的项目</a><p role="status">正在读取成果…</p>', 'projects');
    try {
      const artifact = await this.api.artifact(id, signal);
      if (!this.current() || signal.aborted) return;
      if (artifact.artifact_id !== id || artifact.quality_status !== 'passed' || artifact.delivery_status !== 'available') throw new ApiError(0, 'DATA_UNAVAILABLE');
      const run = await this.api.run(artifact.run_id, signal);
      if (!this.current() || signal.aborted) return;
      if (run.run_id !== artifact.run_id || run.state !== 'succeeded' || run.artifact_id !== (artifact.word_delivery?.revision_artifact_id ?? id)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const project = await this.api.project(run.project_id, signal);
      if (!this.current() || generation !== this.generation) return;
      if (project.project_id !== run.project_id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.show(artifact, run, project, generation);
    } catch (error) {
      if (!this.current() || generation !== this.generation || signal.aborted) return;
      this.shell(`<a class="back-link" href="#/">← 返回我的项目</a><section class="panel artifact-page"><h1>成果暂时无法打开</h1><p role="alert">${esc(resultError(error))}</p><button class="button secondary" id="retry-artifact">重新读取成果</button></section>`, 'projects');
      document.querySelector('#retry-artifact')!.addEventListener('click', () => { void this.render(id); });
    }
  }

  private show(artifact: Artifact, run: Dto<'RunResponse'>, project: Dto<'ProjectResponse'>, generation: number) {
    const delivery = artifact.word_delivery;
    const pending = delivery ? Math.max(delivery.pending_review_count, delivery.pending_review.length) : 0;
    const files = delivery
      ? (Object.keys(variants) as Variant[]).map(variant => ({ id: delivery[`${variant}_artifact_id`], variant, ...variants[variant] }))
      : [{ id: artifact.artifact_id, variant: undefined, label: 'Word 成果', description: '此历史成果未提供修订、清洁版和基线的分类信息。' }];
    this.shell(`<a class="back-link" href="#/projects/${encodeURIComponent(project.project_id)}">← 返回项目工作区</a>
      <div class="page-heading"><div><p class="eyebrow">成果与下载</p><h1>${esc(project.name)}</h1><p class="muted">成果 v${artifact.version} · 输入版本 ${run.input_revision} · ${esc(date(run.updated_at))}</p></div><button class="button secondary" id="refresh-artifact">重新读取成果</button></div>
      <section class="panel artifact-page" aria-labelledby="artifact-summary"><h2 id="artifact-summary">${pending ? '工作稿已生成，含待人工确认事项' : '工作稿已生成'}</h2>
        <p>文件已通过服务端交付检查；生成完成不表示业务事实已全部确认或达到正式申报条件。</p>
        ${delivery ? `<p>本轮完成 ${delivery.replacements} 处替换、${delivery.columns} 处表格增列。</p>
          <div class="artifact-review" aria-labelledby="artifact-review-title"><h3 id="artifact-review-title">待人工确认（${pending} 项）</h3>
          ${pending ? `<ul>${delivery.pending_review.map(item => `<li><p>${esc(item.message)}</p><span class="muted">原文记录：${esc(item.record_id)}</span></li>`).join('')}</ul>${pending > delivery.pending_review.length ? '<p>部分待确认详情尚未提供，请核对 Word 内的标记与批注。</p>' : ''}` : '<p>本轮交付摘要未列出待确认项，仍需核对原始材料和工作稿。</p>'}</div>` : '<p class="muted">此历史成果未提供变更摘要或待确认清单，请核对文档内容。</p>'}
      </section>
      <section class="panel artifact-page" aria-labelledby="artifact-downloads"><h2 id="artifact-downloads">下载 Word</h2><p class="muted">下载已有文件不会发起新任务。WPS/Word 兼容范围以实际验收记录为准。</p>
        <div class="artifact-files">${files.map((file, index) => `<article class="artifact-file"><h3>${file.label}</h3><p>${file.description}</p><button class="button ${index === 0 ? 'primary' : 'secondary'}" data-artifact-file="${index}">下载${file.label}</button><p class="artifact-download-status" data-download-status="${index}" role="status"></p></article>`).join('')}</div>
      </section>
      <section class="panel artifact-page"><details><summary>来源与版本核对</summary><dl class="artifact-provenance"><dt>任务编号</dt><dd>${esc(run.run_id)}</dd><dt>成果编号</dt><dd>${esc(artifact.artifact_id)}</dd><dt>输入版本</dt><dd>${run.input_revision}</dd><dt>当前文件 SHA-256</dt><dd>${esc(artifact.sha256)}</dd>${delivery ? `<dt>原上传文件 SHA-256</dt><dd>${esc(delivery.source_sha256)}</dd><dt>有效基线 DOCX SHA-256</dt><dd>${esc(delivery.effective_baseline_sha256)}</dd>` : ''}</dl></details></section>`, 'projects');
    document.querySelector('#refresh-artifact')!.addEventListener('click', () => { void this.render(artifact.artifact_id); });
    document.querySelectorAll<HTMLButtonElement>('[data-artifact-file]').forEach(button => {
      const index = Number(button.dataset.artifactFile);
      const file = files[index];
      const status = document.querySelector<HTMLElement>(`[data-download-status="${index}"]`)!;
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        status.textContent = '正在读取并核验文件…';
        const signal = this.controller.signal;
        try {
          // Obtain a fresh grant for every attempt; never reuse a URL from page load.
          const fresh = await this.api.artifact(file.id, signal);
          if (!this.current() || generation !== this.generation || signal.aborted) return;
          if (fresh.artifact_id !== file.id || fresh.run_id !== artifact.run_id || fresh.version !== artifact.version ||
            fresh.quality_status !== 'passed' || fresh.delivery_status !== 'available' ||
            (file.variant && (fresh.word_delivery?.variant !== file.variant || fresh.word_delivery.revision_artifact_id !== delivery?.revision_artifact_id))) throw new ApiError(0, 'DATA_UNAVAILABLE');
          const bytes = await this.api.artifactBytes(fresh, signal);
          if (!this.current() || generation !== this.generation || signal.aborted) return;
          const url = URL.createObjectURL(bytes);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${project.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}-v${artifact.version}-${file.label}.docx`;
          document.body.append(link); link.click(); link.remove();
          this.objectUrls.set(url, setTimeout(() => { URL.revokeObjectURL(url); this.objectUrls.delete(url); }, 60_000));
          status.textContent = '文件已交给浏览器下载，请在浏览器下载列表中查看。';
        } catch (error) {
          if (this.current() && generation === this.generation && !signal.aborted) status.textContent = resultError(error);
        } finally { button.disabled = false; }
      });
    });
  }
}
