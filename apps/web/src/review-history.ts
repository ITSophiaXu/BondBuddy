import type { ReviewHistoryEntry } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError } from './api';
import { ArtifactDownloads, artifactError } from './artifact-download';
import { ReviewApi } from './review-api';
import { RevisionHandlingDialog } from './review-revision-handling';
import { runStateLabel } from './review-state';
import { date, esc } from './ui';
import './review-workspace.css';

/** Workbench owns version navigation; unsuccessful attempts remain inspectable. */
export class ReviewHistory {
  private dialog?: HTMLDialogElement;
  private controller?: AbortController;
  private downloads = new ArtifactDownloads();
  private handling: RevisionHandlingDialog;
  constructor(private api: ApiClient, private navigation=()=>new URLSearchParams({from:'projects'})) { this.handling = new RevisionHandlingDialog(api); }
  dispose() { this.controller?.abort(); this.dialog?.remove(); this.downloads.dispose(); this.handling.dispose(); }

  async open(projectId: string, name: string) {
    this.controller?.abort(); this.dialog?.remove(); this.handling.dispose();
    const controller = new AbortController(); this.controller = controller;
    const dialog = document.createElement('dialog'); this.dialog = dialog;
    dialog.className = 'review-history-dialog'; dialog.setAttribute('aria-labelledby', 'review-history-title');
    dialog.innerHTML = `<header class="review-dialog-head"><h2 id="review-history-title">${esc(name)} · 版本记录</h2><button class="review-agent-close" aria-label="关闭版本记录">×</button></header><div class="review-dialog-content" id="review-history-content"><p role="status">正在读取版本记录…</p></div>`;
    document.body.append(dialog);
    dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { controller.abort(); this.handling.dispose(); });
    dialog.showModal();
    const content = dialog.querySelector<HTMLElement>('#review-history-content')!;
    const load = async () => {
      try {
        const { items } = await new ReviewApi(this.api, projectId, controller.signal).history();
        if (controller.signal.aborted) return;
        content.innerHTML = `<p class="review-muted">每次执行单独保存输入、范围和状态。失败与停止记录也会保留；补充说明不会改写已开始的版本。</p><div class="review-history-list">${[...items].sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(item=>this.entry(projectId,item)).join('') || '<p>还没有执行记录。材料和说明草稿保留在项目中。</p>'}</div><p class="review-status" id="review-history-status" role="status"></p>`;
        content.querySelectorAll<HTMLButtonElement>('[data-history-download]').forEach(button => button.addEventListener('click', async () => {
          const artifact = items.flatMap(item=>item.artifacts).find(a=>a.artifact_id===button.dataset.historyDownload);
          if (!artifact || button.disabled) return;
          button.disabled = true;
          try {
            const metadata = await this.api.artifact(artifact.artifact_id, controller.signal);
            const entry=items.find(item=>item.artifacts.some(a=>a.artifact_id===artifact.artifact_id));
            if(metadata.artifact_id!==artifact.artifact_id||metadata.version!==artifact.artifact_version||metadata.run_id!==entry?.run.run_id||metadata.quality_status!=='passed')throw new ApiError(0,'DATA_UNAVAILABLE');
            const bytes = await this.api.artifactBytes(metadata, controller.signal);
            if (!controller.signal.aborted) this.downloads.save(bytes,metadata.filename ?? artifact.filename);
          } catch(error) { if(!controller.signal.aborted) content.querySelector('#review-history-status')!.textContent=artifactError(error); }
          finally { button.disabled=false; }
        }));
        content.querySelectorAll<HTMLButtonElement>('[data-history-handling]').forEach(button=>button.addEventListener('click',()=>{
          const entry=items.find(item=>item.run.run_id===button.dataset.historyHandling);
          const artifact=entry?.artifacts.find(a=>a.kind==='revision');
          if(!entry||!artifact||entry.operation!=='revision')return;
          this.handling.open({artifact,runId:entry.run.run_id,version:entry.version,sourceReportId:entry.source_report_id,
            sourceMaterial:entry.input.source_material_ref,plan:entry.plan});
        }));
        content.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>dialog.close()));
      } catch(error) {
        if(controller.signal.aborted)return;
        content.innerHTML=`<p role="alert">${esc(friendlyError(error,'read'))}</p><button class="btn secondary">重新读取版本</button>`;
        content.querySelector('button')!.addEventListener('click',()=>void load());
      }
    };
    await load();
  }

  private discussion(item:ReviewHistoryEntry) {
    return item.context_messages?.length?`<h4>执行时保存的讨论（未自动采纳）</h4><p>讨论保留原问题引用，执行范围按本轮确认的要求与计划确定。</p>${item.context_messages.map(m=>`<blockquote class="review-source"><p>${esc(m.content)}</p><footer>${m.role==='user'?'用户说明':'助手讨论'} · ${esc(m.context.report_id??'项目级说明')} ${m.context.finding_ids.map(esc).join('、')}</footer></blockquote>`).join('')}`:'';
  }
  private entry(projectId:string,item:ReviewHistoryEntry) {
    const operation={full_review:'完整三维复核',differential_review:'差异复核',revision:'按已选问题修订'}[item.operation];
    const source=item.input.source_material_ref;
    const href=`#/projects/${encodeURIComponent(projectId)}/review?tab=results&${this.navigation()}&report_id=${encodeURIComponent(item.report_id??item.source_report_id??'')}`;
    return `<article class="review-history-entry"><header><h3>V${item.version} · ${operation}</h3><span class="review-tag">${runStateLabel[item.run.state]}</span></header><p>${esc(date(item.created_at))} · ${esc(item.run.run_id)}</p><p>输入版本 ${item.input_revision} · ${item.report_id?`报告 ${esc(item.report_id)}`:'本轮未产生新复核报告'}${item.source_report_id?` · 来源报告 ${esc(item.source_report_id)}`:''}</p><details><summary>查看本轮输入与处理范围</summary><p>源稿：${source?`${esc(source.material_id)} · V${source.material_version}`:'未指定'}<br>来源报告：${esc(item.source_report_id??'无')}<br>披露截止日：${esc(item.input.as_of??'未指定')}<br>问题范围：${item.finding_ids.length?item.finding_ids.map(esc).join('、'):'完整三维复核'}</p><h4>材料版本</h4><ul>${item.input.material_versions.map(m=>`<li>${esc(m.material_id)} · V${m.material_version}<br><small>SHA-256 ${esc(m.sha256)}</small></li>`).join('')}</ul><h4>本轮要求</h4><ul>${item.input.requirements.map(r=>`<li>${esc(r)}</li>`).join('')||'<li>未附加特别要求</li>'}</ul>${item.plan?`<h4>修订计划 V${item.plan.version}</h4><p>选中：${item.plan.finding_ids.map(esc).join('、')||'无'}</p><ul>${item.plan.excluded_findings.map(f=>`<li>排除 ${esc(f.finding_id)}：${esc(f.reason)}</li>`).join('')}${item.plan.requirements.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}${item.input.evidence_links?.length?`<h4>补证关联</h4><ul>${item.input.evidence_links.map(l=>`<li>${esc(l.report_id)} · ${esc(l.finding_id)} ← ${esc(l.material_ref.material_id)} · V${l.material_ref.material_version}</li>`).join('')}</ul>`:''}${this.discussion(item)}</details><div class="review-history-actions">${item.operation==='revision'&&item.artifacts.some(a=>a.kind==='revision')?`<button class="btn secondary small" data-history-handling="${esc(item.run.run_id)}">处理清单</button>`:''}${item.report_id||item.source_report_id?`<a class="btn secondary small" href="${href}">${item.report_id?'打开此版报告':'打开来源报告'}</a>`:''}${item.artifacts.map(a=>`<button class="btn secondary small" data-history-download="${esc(a.artifact_id)}">下载${{report:'问题报告',comments:'批注稿',revision:'修订版',clean:'清洁版',baseline:'基线文稿'}[a.kind]}</button>`).join('')}<a class="text-btn" href="#/projects/${encodeURIComponent(projectId)}/review?tab=materials&${this.navigation()}">继续准备下一版</a></div></article>`;
  }
}
