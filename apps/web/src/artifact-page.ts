import { ApiClient, ApiError, type Dto } from './api';
import { ArtifactDownloads, artifactError, artifactFilename } from './artifact-download';
import { date, esc } from './ui';
import { authoringSummary } from './authoring-summary';
import {navigationProjectContext,projectWorkHref,withProjectContext} from './project-navigation';
import './artifact-page.css';

type Artifact = Dto<'ArtifactResponse'>;
type Variant = NonNullable<Artifact['word_delivery']>['variant'];
const variants: Record<Variant, { label: string; description: string }> = {
  revision: { label: '修订版', description: '保留本轮新增、删除和修改痕迹，便于逐项对照原稿、审核改动。' },
  clean: { label: '清洁版', description: '展示本轮修改后的完整正文，不显示修订痕迹，适合通读和继续编辑。' },
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
    const directChecks=delivery?.direct_checks;
    const pending = delivery ? Math.max(delivery.pending_review_count ?? 0, delivery.pending_review.length) : 0;
    const generatedPair = delivery?.delivery_policy === 'generated_pair_v1';
    const files = delivery
      ? (['clean', 'revision'] as const).map(variant => ({ id: delivery[`${variant}_artifact_id`], variant, ...variants[variant], ...(delivery.baseline_kind === 'none' ? { description: '本次为首次编制，没有旧文对照；两份均为可编辑首稿。' } : {}) }))
      : [{ id: artifact.artifact_id, variant: undefined, label: 'Word 成果', description: '此历史成果未提供修订、清洁版和基线的分类信息。' }];
    const context=navigationProjectContext(location.hash),returnId=context?.projectId;
    const back=returnId?projectWorkHref('files',returnId):'#/projects/'+encodeURIComponent(project.project_id);
    const consistency=withProjectContext(new URLSearchParams({project:project.source_project_id??project.project_id}));
    this.shell(`<a class="back-link" href="${esc(back)}">← ${returnId?'返回本项目文件':'返回项目工作区'}</a>
      <div class="page-heading"><div><p class="eyebrow">成果与下载</p><h1>${esc(project.name)}</h1><p class="muted">第 ${artifact.display_version ?? artifact.version} 版 · ${esc(date(run.updated_at))}</p></div><button class="button secondary" id="refresh-artifact">重新读取成果</button>${artifact.delivery_status==='available'&&delivery?'<button class="button secondary" id="assistant-artifact">与 BondBuddy 讨论／继续修改</button>':''}</div>
      <section class="panel artifact-page artifact-download-panel" aria-labelledby="artifact-downloads"><h2 id="artifact-downloads" tabindex="-1">下载募集书</h2>
        <p class="muted" data-artifact-result-context hidden>本轮成果 · ${artifact.display_version ? `第 ${artifact.display_version} 版` : '显示版本未提供'} · 任务记录时间 <time datetime="${esc(run.updated_at)}">${esc(date(run.updated_at))}</time></p>
        ${artifact.delivery_status === 'test_only' ? '<p>内部测试工作稿·未经专业审核·不得对外使用</p>' : ''}
        <div class="artifact-files">${files.map((file, index) => `<article class="artifact-file ${index === 0 ? 'artifact-file-primary' : ''}"><h3>${file.label}${file.variant === 'clean' ? '<span class="artifact-recommended">推荐阅读</span>' : ''}</h3><p>${file.description}</p><button class="button ${index === 0 ? 'primary' : 'secondary'}" data-artifact-file="${index}">下载${file.label}</button><p class="artifact-download-status" data-download-status="${index}" role="status"></p></article>`).join('')}</div>
        ${delivery ? '<p class="artifact-download-note">两版均可能保留待人工确认的标记或批注，请在使用前核对。</p>' : ''}
        <a class="button secondary" href="#consistency?${esc(consistency.toString())}">检查文件一致性</a>
      </section>
      <section class="panel artifact-page" aria-labelledby="artifact-summary"><h2 id="artifact-summary">${artifact.delivery_status === 'test_only' ? '内部测试工作稿·未经专业审核·不得对外使用' : pending ? '工作稿已生成，含待人工确认事项' : '工作稿已生成'}</h2>
        <p>${generatedPair ? '修订版和清洁版已生成，可以下载。' : '文件已通过服务端交付检查；生成完成不表示业务事实已全部确认或达到正式申报条件。'}</p>
        ${directChecks?`<div class="artifact-review"><h3>本次检查状态</h3><p>页数：原稿 ${directChecks.page_check.baseline_pages} 页，成稿 ${directChecks.page_check.result_pages} 页，检查通过。</p><p>财务勾稽：${directChecks.financial_check.status==='passed'?'已完整核对且一致':directChecks.financial_check.status==='not_checked'?'部分项目未核对':'存在不一致'}；已比较 ${directChecks.financial_check.compared} 项。</p>${directChecks.financial_check.unchecked.length?`<p>未核对：${esc(directChecks.financial_check.unchecked.join('、'))}</p>`:''}</div>`:''}
        ${delivery ? `<p>${delivery.baseline_kind === 'none' ? '本次为首次编制，没有历史修订对照。' : delivery.replacements !== null && delivery.columns !== null ? `本轮完成 ${delivery.replacements} 处替换、${delivery.columns} 处表格增列。` : ''}</p>${delivery.source_issuer ? `<p>${delivery.baseline_kind === 'project_output' ? '对照本项目上一版成果，发行人：' : '对照原稿企业：'}${esc(delivery.source_issuer)}${delivery.baseline_kind === 'reconstructed_pdf' ? '；原稿来自 PDF，请核对转换后的排版。' : ''}</p>` : ''}
          ${generatedPair ? '' : `
          <div class="artifact-review" aria-labelledby="artifact-review-title"><h3 id="artifact-review-title">待人工确认（${pending} 项）</h3>
          ${pending ? `<ul>${delivery.pending_review.map(item => `<li><p>${esc(item.message)}</p><span class="muted">原文记录：${esc(item.record_id)}</span></li>`).join('')}</ul>${pending > delivery.pending_review.length ? '<p>部分待确认详情尚未提供，请核对 Word 内的标记与批注。</p>' : ''}` : '<p>本轮交付摘要未列出待确认项，仍需核对原始材料和工作稿。</p>'}</div>`}` : '<p class="muted">此历史成果未提供变更摘要或待确认清单，请核对文档内容。</p>'}
      </section>
      ${delivery?.authoring_summary?.length ? `<section class="panel artifact-page" aria-labelledby="authoring-summary-title"><h2 id="authoring-summary-title">本次更新说明</h2><div class="authoring-summary">${authoringSummary(delivery.authoring_summary)}</div></section>` : ''}`, 'projects');
    const resultContext=document.querySelector<HTMLElement>('[data-artifact-result-context]');if(resultContext)resultContext.hidden=!resultContext.closest('.embedded-artifact');
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
          const freshDelivery = fresh.word_delivery;
          // A first draft may deduplicate identical Word bytes into one artifact.
          // Its metadata calls that shared artifact "revision"; only this explicit
          // no-baseline pair can also satisfy the clean download action.
          const firstDraftCleanAlias = file.variant === 'clean' && freshDelivery?.variant === 'revision' &&
            delivery?.baseline_kind === 'none' && freshDelivery.baseline_kind === 'none' &&
            delivery.revision_artifact_id === delivery.clean_artifact_id &&
            freshDelivery.revision_artifact_id === freshDelivery.clean_artifact_id && fresh.sha256 === artifact.sha256;
          if (fresh.artifact_id !== file.id || fresh.run_id !== artifact.run_id || fresh.version !== artifact.version ||
            fresh.quality_status !== 'passed' || fresh.delivery_status !== artifact.delivery_status ||
            (file.variant && ((!firstDraftCleanAlias && freshDelivery?.variant !== file.variant) ||
              freshDelivery?.revision_artifact_id !== delivery?.revision_artifact_id ||
              freshDelivery?.clean_artifact_id !== delivery?.clean_artifact_id))) throw new ApiError(0, 'DATA_UNAVAILABLE');
          const bytes = await this.api.artifactBytes(fresh, signal);
          if (!this.current() || generation !== this.generation || signal.aborted) return;
          let filename = artifactFilename(fresh);
          if (firstDraftCleanAlias) {
            const cleanName = filename.replace(/募集书修订版(?=_V\d+(?:_\d{8})?\.docx$)/, '募集书清洁版');
            filename = cleanName !== filename ? cleanName : artifactFilename({ ...fresh, filename: undefined,
              word_delivery: { ...freshDelivery!, variant: 'clean' } });
          }
          this.downloads.save(bytes, filename);
          status.textContent = '文件已交给浏览器下载，请在浏览器下载列表中查看。';
        } catch (error) {
          if (this.current() && generation === this.generation && !signal.aborted) status.textContent = artifactError(error);
        } finally { button.disabled = false; }
      });
    });
  }
}
