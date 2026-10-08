import { ApiClient, ApiError, type Dto } from './api';
import { ArtifactDownloads, artifactError } from './artifact-download';
import { date, esc } from './ui';
import './artifact-page.css';

type Artifact = Dto<'ArtifactResponse'>;
type Variant = NonNullable<Artifact['word_delivery']>['variant'];
const variants: Record<Variant, { label: string; description: string }> = {
  revision: { label: '修订版', description: '查看本轮增删修改；待人工确认标记仍需逐项核对。' },
  clean: { label: '清洁版', description: '查看接受本轮修订后的工作稿；保留未解决的待人工确认标记。' },
  baseline: { label: '有效基线', description: '本轮修改前的有效正文副本，用于对照；上传原件保持不变。' }
};

export class ArtifactPage {
  private controller = new AbortController();
  private generation = 0;
  private downloads = new ArtifactDownloads();
  constructor(private api: ApiClient, private shell: (html: string, section: string) => void, private current: () => boolean) {}

  dispose() {
    this.generation++;
    this.controller.abort();
    this.downloads.dispose();
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
      if (artifact.artifact_id !== id || artifact.quality_status !== 'passed' || !['available','test_only'].includes(artifact.delivery_status)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const run = await this.api.run(artifact.run_id, signal);
      if (!this.current() || signal.aborted) return;
      if (run.run_id !== artifact.run_id ||
        !((run.state === 'succeeded' && run.channel === 'production' && artifact.delivery_status === 'available') ||
          (run.state === 'test_completed' && run.channel === 'non_production_test' && artifact.delivery_status === 'test_only')) ||
        run.artifact_id !== (artifact.word_delivery?.revision_artifact_id ?? id)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const project = await this.api.project(run.project_id, signal);
      if (!this.current() || generation !== this.generation) return;
      if (project.project_id !== run.project_id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.show(artifact, run, project, generation);
    } catch (error) {
      if (!this.current() || generation !== this.generation || signal.aborted) return;
      this.shell(`<a class="back-link" href="#/">← 返回我的项目</a><section class="panel artifact-page"><h1>成果暂时无法打开</h1><p role="alert">${esc(artifactError(error))}</p><button class="button secondary" id="retry-artifact">重新读取成果</button></section>`, 'projects');
      document.querySelector('#retry-artifact')!.addEventListener('click', () => { void this.render(id); });
    }
  }

  private show(artifact: Artifact, run: Dto<'RunResponse'>, project: Dto<'ProjectResponse'>, generation: number) {
    const delivery = artifact.word_delivery;
    const pending = delivery ? Math.max(delivery.pending_review_count ?? 0, delivery.pending_review.length) : 0;
    const generatedPair = delivery?.delivery_policy === 'generated_pair_v1';
    const files = delivery
      ? (['revision', 'clean'] as const).map(variant => ({ id: delivery[`${variant}_artifact_id`], variant, ...variants[variant], ...(delivery.baseline_kind === 'none' ? { description: '本次为首次编制，没有旧文对照；两份均为可编辑首稿。' } : {}) }))
      : [{ id: artifact.artifact_id, variant: undefined, label: 'Word 成果', description: '此历史成果未提供修订、清洁版和基线的分类信息。' }];
    this.shell(`<a class="back-link" href="#/projects/${encodeURIComponent(project.project_id)}">← 返回项目工作区</a>
      <div class="page-heading"><div><p class="eyebrow">成果与下载</p><h1>${esc(project.name)}</h1><p class="muted">成果 v${artifact.version} · 输入版本 ${run.input_revision} · ${esc(date(run.updated_at))}</p></div><button class="button secondary" id="refresh-artifact">重新读取成果</button>${artifact.delivery_status==='available'&&delivery?'<button class="button secondary" id="assistant-artifact">与 BondBuddy 讨论／继续修改</button>':''}</div>
      <section class="panel artifact-page" aria-labelledby="artifact-summary"><h2 id="artifact-summary">${artifact.delivery_status === 'test_only' ? '内部测试工作稿·未经专业审核·不得对外使用' : pending ? '工作稿已生成，含待人工确认事项' : '工作稿已生成'}</h2>
        <p>${generatedPair ? '修订版和清洁版已生成，可以下载。' : '文件已通过服务端交付检查；生成完成不表示业务事实已全部确认或达到正式申报条件。'}</p>
        ${delivery ? `<p>${delivery.baseline_kind === 'none' ? '本次为首次编制，没有历史修订对照。' : delivery.replacements !== null && delivery.columns !== null ? `本轮完成 ${delivery.replacements} 处替换、${delivery.columns} 处表格增列。` : ''}</p>${delivery.source_issuer ? `<p>${delivery.baseline_kind === 'project_output' ? '对照本项目上一版成果，发行人：' : '对照原稿企业：'}${esc(delivery.source_issuer)}${delivery.baseline_kind === 'reconstructed_pdf' ? '；PDF 重建基线，排版请核对。' : ''}</p>` : ''}${delivery.authoring_summary?.length ? `${generatedPair ? '<details><summary>编制说明</summary>' : ''}<ul>${delivery.authoring_summary.map(item => `<li>${esc(item)}</li>`).join('')}</ul>${generatedPair ? '</details>' : ''}` : ''}
          ${generatedPair ? '' : `
          <div class="artifact-review" aria-labelledby="artifact-review-title"><h3 id="artifact-review-title">待人工确认（${pending} 项）</h3>
          ${pending ? `<ul>${delivery.pending_review.map(item => `<li><p>${esc(item.message)}</p><span class="muted">原文记录：${esc(item.record_id)}</span></li>`).join('')}</ul>${pending > delivery.pending_review.length ? '<p>部分待确认详情尚未提供，请核对 Word 内的标记与批注。</p>' : ''}` : '<p>本轮交付摘要未列出待确认项，仍需核对原始材料和工作稿。</p>'}</div>`}` : '<p class="muted">此历史成果未提供变更摘要或待确认清单，请核对文档内容。</p>'}
      </section>
      <section class="panel artifact-page" aria-labelledby="artifact-downloads"><h2 id="artifact-downloads">下载 Word</h2><p class="muted">下载已有文件不会发起新任务。WPS/Word 兼容范围以实际验收记录为准。</p>
        <div class="artifact-files">${files.map((file, index) => `<article class="artifact-file"><h3>${file.label}</h3><p>${file.description}</p><button class="button ${index === 0 ? 'primary' : 'secondary'}" data-artifact-file="${index}" title="${esc(file.description)}">下载${file.label}</button><p class="artifact-download-status" data-download-status="${index}" role="status"></p></article>`).join('')}</div>
      </section>
      <section class="panel artifact-page"><details><summary>来源与版本核对</summary><dl class="artifact-provenance"><dt>任务编号</dt><dd>${esc(run.run_id)}</dd><dt>成果编号</dt><dd>${esc(artifact.artifact_id)}</dd><dt>输入版本</dt><dd>${run.input_revision}</dd><dt>当前文件 SHA-256</dt><dd>${esc(artifact.sha256)}</dd>${delivery ? `${delivery.source_sha256 ? `<dt>${delivery.baseline_kind === 'project_output' ? '上一版成果' : '原上传文件'} SHA-256</dt><dd>${esc(delivery.source_sha256)}</dd>` : ''}${delivery.effective_baseline_sha256 ? `<dt>${delivery.baseline_kind === 'none' ? '本次首稿 DOCX' : '有效基线 DOCX'} SHA-256</dt><dd>${esc(delivery.effective_baseline_sha256)}</dd>` : ''}` : ''}</dl></details></section>`, 'projects');
    document.querySelector('#assistant-artifact')?.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('bondbuddy:assistant',{detail:{projectId:project.project_id,artifactId:delivery?.clean_artifact_id}})));
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
            fresh.quality_status !== 'passed' || fresh.delivery_status !== artifact.delivery_status ||
            (file.variant && (fresh.word_delivery?.variant !== file.variant || fresh.word_delivery.revision_artifact_id !== delivery?.revision_artifact_id))) throw new ApiError(0, 'DATA_UNAVAILABLE');
          const bytes = await this.api.artifactBytes(fresh, signal);
          if (!this.current() || generation !== this.generation || signal.aborted) return;
          this.downloads.save(bytes, `${project.name}-v${artifact.version}-${file.label}.docx`);
          status.textContent = '文件已交给浏览器下载，请在浏览器下载列表中查看。';
        } catch (error) {
          if (this.current() && generation === this.generation && !signal.aborted) status.textContent = artifactError(error);
        } finally { button.disabled = false; }
      });
    });
  }
}
