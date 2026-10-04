import type { ReviewProposal, ReviewProposalV2, ReviewTimelineEntry, ReviewTask, Run, RunEvent } from '@bondbuddy/contracts';
import { runStateLabel, isActiveRun } from './review-state.js';
import { ApiError, friendlyError } from './api.js';
import { date, esc } from './ui.js';

export const reviewOperationLabels = { full_review: '完整三维复核', differential_review: '针对问题重新核验', revision: '按已选问题修订' };
export function isTypedReviewProposal(proposal: ReviewProposal): proposal is ReviewProposalV2 {
  return 'version' in proposal && proposal.version === 'review-proposal-v2';
}

// Only known host stages are translated. Model output and unknown/raw event payloads never become progress.
const stageLabels: Record<string, string> = { queued: '等待处理', input_lock: '核对固定输入', materials_ready: '读取材料',
  review_sources: '读取已固定的材料依据', review_rules: '核对复核依据', review_completion: '核对复核成果完整性',
  review_revision_cli_method: '核对已确认修订范围', review_revision_cli_v1_prompt: '准备修订请求',
  public_review_prompt: '准备公开信息核验', model_generation: '整理已确认任务成果', provider_call: '执行已确认请求',
  provider_reconcile: '核对先前调用结果', word_delivery: '准备 Word 成果', word_delivery_pair: '登记 Word 成果',
  completed: '处理完成', capability_not_ready: '等待处理条件', awaiting_materials:'等待材料就绪', trial_limit:'等待处理限制解除' };
export function reviewStageLabel(stage:string|null|undefined,state?:Run['state']):string|undefined {
  if(!stage)return undefined;
  // Resume keeps the previous stage until claim; queued work is already past its former blocker.
  if(state==='queued')return stageLabels.queued;
  if(stageLabels[stage])return stageLabels[stage];
  if(/^review_cli_v[23]_[a-f0-9]+_prompt$/.test(stage))return '准备已确认复核请求';
  if(/^public_search_v2_[a-f0-9]+_prompt$/.test(stage))return '准备公开依据检索';
  if(/^public_compare_v2_[a-f0-9]+_prompt$/.test(stage)||/^public_compare_\d+_prompt$/.test(stage))return '准备公开依据对比';
  return undefined;
}
const reasonLabels: Record<string, string> = { user_cancelled: '用户请求停止', user_cancel_requested: '正在停止',
  provider_reconciliation_required: '正在核对先前调用，暂不重复执行', provider_result_pending: '等待先前调用结果',
  material_versions: '材料尚未就绪', capability_not_ready: '处理条件尚未就绪', user_resumed: '任务已恢复',
  review_assembly_requeued: '复用已保存结果，恢复报告整理', word_pair_delivery_requeued:'复用已保存文稿，恢复文档交付',
  model_tokens_per_user_per_day:'今日处理额度已用完，额度恢复后本任务会自动继续。',
  kill_switch:'复核服务暂时停用，服务恢复后本任务会自动继续。',
  trial_limit_cleared:'处理限制已解除，本任务已恢复排队。',
  provider_call_retrying:'系统已准备重试，当前输入保持不变。' };
const failureLabels: Record<string, string> = {
  DELIVERY_FAILED: '本轮文档交付失败，未取得可核验的成果。请联系支持核对任务结果。',
  VALIDATION_FAILED: '本轮成果未通过校验，未登记为有效报告。请核对输入后，明确开始下一轮。',
  MODEL_TIMEOUT: '本轮处理超时。请核对连接与输入后，明确开始下一轮。',
  MODEL_STREAM_BROKEN: '本轮响应中断，未取得完整成果。请核对服务连接后，明确开始下一轮。',
  MODEL_PROVIDER_AUTH_FAILED: '处理服务的登录已失效。请联系管理员恢复服务登录后再开始。',
  MODEL_PROVIDER_RATE_LIMITED: '处理服务暂时限流。请稍后明确开始下一轮。',
  MODEL_PROVIDER_BALANCE_EXHAUSTED: '处理服务暂时无法继续。请联系管理员恢复服务后再开始。',
  MODEL_PROVIDER_REQUEST_REJECTED: '处理服务拒绝了本轮请求。请联系管理员核对服务配置后再开始。',
  MODEL_OUTPUT_SCHEMA_INVALID: '本轮响应未符合成果格式，未登记为有效报告。',
  MODEL_RESULT_STORE_FAILED: '本轮成果保存失败，未登记为有效报告。请联系支持核对任务结果。',
  MODEL_PRIOR_ATTEMPT_UNRESOLVED: '先前调用的结果尚未核实，请等待核对后再继续，避免重复执行。',
  TRIAL_QUOTA_EXCEEDED:'本轮暂受处理额度限制，限制解除后会自动继续。',
  MODEL_CALLS_SUSPENDED:'复核服务暂时停用，服务恢复后本任务会自动继续。',
  TRIAL_ACCESS_DENIED:'当前账号的处理服务已暂停，请联系管理员核对。',
};

/** Display progress independently of the active-task lock, which also includes paused work. */
export function reviewEmptyResultText(run: Run | null | undefined): { heading: string; message: string } {
  if (run?.state === 'paused') return { heading:'复核已暂停', message:'本轮仍在等待处理条件恢复，尚未生成有效报告；材料与要求已保留。' };
  if (run?.state === 'awaiting_input') return { heading:'复核等待补充信息', message:'本轮尚未生成有效报告；请根据任务状态核对需要补充的信息。' };
  if (run && ['preparing','queued'].includes(run.state)) return { heading:'复核等待处理', message:'本轮已提交，尚未生成有效报告；项目助手会继续显示处理状态。' };
  return isActiveRun(run)
    ? { heading:'复核正在进行', message:'结果就绪后会在这里显示，项目助手仍可记录下一版说明。' }
    : { heading:'还没有复核报告', message:'提供材料并明确开始后，在这里查看问题、依据与成果。' };
}

/** Fixed host labels only: an event's raw reason or provider text never becomes UI copy. */
function eventNotice(event: RunEvent | undefined): string | undefined {
  const reason=event?.payload.reason, code=event?.payload.error_code;
  const explanation=code&&failureLabels[code];
  if(reason&&reasonLabels[reason])return reason==='provider_call_retrying'&&explanation?`${explanation} ${reasonLabels[reason]}`:reasonLabels[reason];
  if(explanation)return explanation;
  if(code&&['INPUT_REQUIRED','MATERIAL_UNREADABLE','CAPABILITY_NOT_READY','DATA_UNAVAILABLE','VALIDATION_FAILED','RATE_LIMITED'].includes(code))return friendlyError(new ApiError(0,code));
  return undefined;
}

/** Only the persisted event matching the current task snapshot supplies its reason. */
export function reviewTaskNotice(task: ReviewTask): string | undefined {
  const run=task.run;
  const event=[...task.events].sort((a,b)=>b.seq-a.seq).find(item=>item.run_id===run.run_id&&item.seq<=(run.event_cursor??0)&&item.state===run.state&&item.stage===run.stage);
  return eventNotice(event)??(['failed','rejected'].includes(run.state)?'本轮未完成。请核对已保存的材料与服务状态；仍无法继续时联系支持。':run.state==='paused'?'本轮已暂停，正在等待处理条件恢复；当前输入和已保存结果保留。':undefined);
}

/** A snapshot replaces a task card by run identity; duplicate/replayed entries do not add cards. */
export function uniqueReviewTimeline(entries: ReviewTimelineEntry[]): ReviewTimelineEntry[] {
  const records = new Map<string, ReviewTimelineEntry>();
  for (const entry of entries) {
    const key = entry.kind === 'task' ? `task:${entry.task.run.run_id}` : `message:${entry.message.message_id}`;
    const previous = records.get(key);
    if (previous?.kind === 'task' && entry.kind === 'task' && (previous.task.run.event_cursor??0) > (entry.task.run.event_cursor??0)) continue;
    if (previous?.kind === 'task' && entry.kind === 'task' && !isActiveRun(previous.task.run) && isActiveRun(entry.task.run)) {
      const recovered=previous.task.run.state==='failed'&&(entry.task.run.event_cursor??0)>(previous.task.run.event_cursor??0)&&entry.task.events.some(event=>event.run_id===entry.task.run.run_id&&event.seq>(previous.task.run.event_cursor??0)&&event.seq<=(entry.task.run.event_cursor??0)&&['review_assembly_requeued','word_pair_delivery_requeued'].includes(event.payload.reason??''));
      if(!recovered)continue;
    }
    records.set(key, entry);
  }
  return [...records.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.entry_id.localeCompare(b.entry_id));
}

export function reviewTaskHtml(task: ReviewTask, createdAt: string, reportNames: Record<string,string> = {}): string {
  const run = task.run, active = isActiveRun(run), stage = reviewStageLabel(run.stage,run.state);
  const events = [...new Map(task.events.map(event=>[event.event_id,event])).values()].sort((a,b)=>a.seq-b.seq);
  const reason = reviewTaskNotice(task);
  const origin = task.origin.entrypoint === 'assistant_proposal' ? '对话确认执行' : task.origin.entrypoint==='quick_action'?'页面快捷操作':'入口未记录（旧任务）';
  return `<article class="review-task-card ${active?'active':''}" id="review-task-${esc(run.run_id)}" data-task-run="${esc(run.run_id)}" tabindex="-1">
    <header><span>✦ 任务记录</span><span class="review-tag">${runStateLabel[run.state]}</span></header>
    <h3>${reviewOperationLabels[task.operation]}</h3><p class="review-task-meta">执行 V${task.version} · 固定输入 V${task.input_version} · ${origin}</p>
    <p class="review-task-scope">${task.operation==='full_review'?'财务数据 · 合规与格式 · 公开信息':task.finding_ids.map(esc).join('、')||'范围以已确认计划为准'}</p>
    ${task.source_report_id?`<p class="review-muted">来源报告 <button class="text-btn" data-assistant-action="report" data-report-id="${esc(task.source_report_id)}" title="${esc(task.source_report_id)}">${esc(reportNames[task.source_report_id]??'来源报告')}</button></p>`:''}
    ${run.stage?`<p class="review-task-stage" role="status">${esc(stage??'已记录处理阶段')}</p>`:''}${reason?`<p class="review-warning">${esc(reason)}</p>`:''}
    <small>提交 ${esc(date(createdAt))}${task.started_at?` · 开始 ${esc(date(task.started_at))}`:''}${task.completed_at?` · 结束 ${esc(date(task.completed_at))}`:''}${active?' · 新说明只用于下一版':''}</small>
    <p class="review-task-boundary">${active?'本次材料与要求已锁定，关闭页面不会取消任务。':run.state==='cancelled'?'本轮已停止，原有效报告保留。':run.state==='failed'||run.state==='rejected'?'本轮未完成，原有效报告保留。':task.operation==='revision'?'已修改，待复核；修订不会自动开始重核。':task.report_id?'成果已登记；请结合实际覆盖与依据阅读结论。':'尚无已登记复核成果。'}</p>
    <div class="review-task-actions">${task.report_id?`<button class="btn secondary small" data-assistant-action="report" data-report-id="${esc(task.report_id)}">查看本轮结果</button>`:task.source_report_id?`<button class="btn secondary small" data-assistant-action="report" data-report-id="${esc(task.source_report_id)}">查看保留报告</button>`:''}${active?`<button class="text-btn" data-review-action="task-status" data-run-id="${esc(run.run_id)}">${run.state==='paused'?'查看暂停任务':'查看进行中任务'}</button>`:''}${task.artifacts.map(artifact=>`<button class="text-btn" data-review-action="task-download" data-run-id="${esc(run.run_id)}" data-artifact-id="${esc(artifact.artifact_id)}">下载${{report:'问题报告',comments:'批注稿',revision:'修订版',clean:'清洁版',baseline:'基线文稿'}[artifact.kind]}</button>`).join('')}</div>
    ${events.length?`<details class="review-task-events"><summary>查看已记录过程</summary><ol>${events.map(event=>`<li><span>${esc(date(event.occurred_at))}</span> ${esc(reviewStageLabel(event.stage,event.state)??runStateLabel[event.state])}${eventNotice(event)?` · ${esc(eventNotice(event))}`:''}</li>`).join('')}</ol></details>`:''}
  </article>`;
}
