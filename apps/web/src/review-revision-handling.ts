import { ReviewRevisionHandlingSchema, type ReviewArtifact, type ReviewMaterialPin, type ReviewPlan, type ReviewReport, type ReviewRevisionHandling } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { ApiClient, friendlyError, type Dto } from './api.js';
import { UserFacingError } from './user-facing-error';
import { sourceLocator } from './review-presentation.js';
import { esc } from './ui.js';

type HandlingContext = {
  artifact: ReviewArtifact;
  runId: string;
  version: number;
  sourceReportId: string | null;
  sourceReport?: ReviewReport;
  sourceMaterial?: ReviewMaterialPin | null;
  plan?: ReviewPlan | null;
  materialNames?: Record<string, string>;
};
const statusLabels: Record<ReviewRevisionHandling['items'][number]['status'], string> = {
  modified: '已修改', not_modified: '未修改', needs_evidence: '待补证',
};
class HandlingError extends UserFacingError {}

/** The dialog is pinned to the clicked artifact, never to a later workspace refresh. */
export function checkedRevisionHandling(metadata: Dto<'ArtifactResponse'>, context: HandlingContext): ReviewRevisionHandling {
  const delivery = metadata.word_delivery;
  const handling = delivery?.revision_handling;
  if (!handling) throw new HandlingError('此成果尚未提供处理清单。不能据此认定全部问题已修改，请稍后重试。');
  const invalid = () => new HandlingError('处理清单的成果、任务或来源版本不一致，暂不展示。请刷新后重试。');
  if (metadata.artifact_id !== context.artifact.artifact_id || metadata.version !== context.artifact.artifact_version
    || metadata.run_id !== context.runId || metadata.quality_status !== 'passed' || context.artifact.kind !== 'revision'
    || delivery?.variant !== 'revision' || delivery.revision_artifact_id !== context.artifact.artifact_id
    || delivery.review_passed !== false || !Value.Check(ReviewRevisionHandlingSchema, handling)
    || !context.sourceReportId || handling.source_report.report_id !== context.sourceReportId
    || handling.items.some(item => item.report_id !== context.sourceReportId)
    || new Set(handling.items.map(item => item.finding_id)).size !== handling.items.length) throw invalid();
  const report = context.sourceReport;
  if (report && (handling.source_report.report_id !== report.report_id || handling.source_report.run_id !== report.run_id
    || handling.source_report.version !== report.version || handling.source_report.input_revision !== report.input_revision)) throw invalid();
  const material = context.sourceMaterial ?? report?.source_material;
  if (material && (handling.source_material.material_id !== material.material_id
    || handling.source_material.material_version !== material.material_version || handling.source_material.sha256 !== material.sha256)) throw invalid();
  const plan = context.plan;
  if (plan && (handling.accepted_plan.plan_id !== plan.plan_id || handling.accepted_plan.version !== plan.version
    || handling.accepted_plan.sha256 !== plan.sha256 || handling.accepted_plan.accepted_at !== plan.accepted_at)) throw invalid();
  return handling;
}

export function revisionHandlingHtml(handling: ReviewRevisionHandling, context: HandlingContext): string {
  const source = handling.source_material;
  const names = context.materialNames ?? {};
  return `<p class="review-kicker">执行版本 V${context.version} · ${esc(context.runId)}</p>
    <p>成果：${esc(context.artifact.filename)} · V${context.artifact.artifact_version}<br>来源报告：${esc(handling.source_report.report_id)} · V${handling.source_report.version}<br>源稿：${esc(names[source.material_id] ?? source.material_id)} · V${source.material_version}<br>已采纳计划：${esc(handling.accepted_plan.plan_id)} · V${handling.accepted_plan.version}</p>
    <div class="review-notice">处理状态只说明本轮修订情况。已修改不代表复核通过；未修改和待补证项保留，需补证或另行明确复核。</div>
    <p class="review-handling-summary">${Object.entries(statusLabels).map(([status, label]) => `${label} ${handling.items.filter(item => item.status === status).length} 项`).join(' · ')}</p>
    <div class="review-handling-list">${handling.items.map(item => `<article class="review-handling-item" data-handling-finding="${esc(item.finding_id)}"><header><h3>${esc(item.finding_id)}</h3><span class="review-tag${item.status === 'modified' ? '' : ' review-warning'}">${statusLabels[item.status]}</span></header><p><strong>处理原因</strong> ${esc(item.reason)}</p><p><strong>原文位置</strong></p>${item.locations.length ? `<ul>${item.locations.map(location => `<li>${esc(sourceLocator(location) || '未提供详细位置')} <small>（${esc(location.record_id)}）</small></li>`).join('')}</ul>` : '<p class="review-muted">未提供可确认的原文位置。</p>'}${item.evidence_refs.length ? `<details><summary>依据记录（${item.evidence_refs.length}）</summary><ul>${item.evidence_refs.map(ref => `<li>${esc(ref)}</li>`).join('')}</ul></details>` : '<p class="review-muted">未提供额外依据记录。</p>'}</article>`).join('')}</div>
    ${handling.limitations.length ? `<section class="review-notice"><h3>本轮限制</h3><ul>${handling.limitations.map(limitation => `<li>${esc(limitation)}</li>`).join('')}</ul></section>` : ''}`;
}

/** A secondary modal preserves the workbench history and its selected execution. */
export class RevisionHandlingDialog {
  private dialog?: HTMLDialogElement;
  private controller?: AbortController;
  constructor(private api: ApiClient) {}
  dispose() { this.controller?.abort(); this.dialog?.remove(); }
  open(context: HandlingContext) {
    this.dispose();
    const pinned = structuredClone(context), controller = new AbortController();
    this.controller = controller;
    const dialog = document.createElement('dialog');
    this.dialog = dialog;
    dialog.className = 'review-dialog review-handling-dialog';
    dialog.setAttribute('aria-labelledby', 'review-handling-title');
    dialog.innerHTML = '<header class="review-dialog-head"><h2 id="review-handling-title">修订处理清单</h2><button class="review-agent-close" aria-label="关闭处理清单">×</button></header><div class="review-dialog-content"></div><footer class="review-dialog-actions"><button class="btn secondary">返回</button></footer>';
    dialog.querySelectorAll('button').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => controller.abort());
    document.body.append(dialog); dialog.showModal();
    const content = dialog.querySelector<HTMLElement>('.review-dialog-content')!;
    const load = async () => {
      content.innerHTML = `<p>执行版本 V${pinned.version} · 来源报告 ${esc(pinned.sourceReportId ?? '待核对')}</p><p role="status">正在读取此成果的处理清单…</p>`;
      try {
        const metadata = await this.api.artifact(pinned.artifact.artifact_id, controller.signal);
        if (controller.signal.aborted) return;
        content.innerHTML = revisionHandlingHtml(checkedRevisionHandling(metadata, pinned), pinned);
      } catch (error) {
        if (controller.signal.aborted) return;
        content.innerHTML = `<p>执行版本 V${pinned.version} · 来源报告 ${esc(pinned.sourceReportId ?? '待核对')}</p><p role="alert">${esc(error instanceof HandlingError ? error.message : friendlyError(error,'read'))}</p><button class="btn secondary small">重试读取处理清单</button>`;
        content.querySelector('button')!.addEventListener('click', () => void load());
      }
    };
    void load();
  }
}
