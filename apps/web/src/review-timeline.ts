import type { ReviewProposal, ReviewProposalV2, ReviewTimelineEntry, ReviewTask, Run, RunEvent, ReviewActionCode } from '@bondbuddy/contracts';
import { runStateLabel, isActiveRun } from './review-state.js';
import { ApiError, friendlyError } from './api.js';
import { esc } from './ui.js';

export const reviewOperationLabels = { full_review: '完整复核', differential_review: '针对问题重新核验', revision: '按已选问题修订' };
export function isTypedReviewProposal(proposal: ReviewProposal): proposal is ReviewProposalV2 {
  return 'version' in proposal && proposal.version === 'review-proposal-v2';
}

// Only known host stages are translated. Model output and unknown/raw event payloads never become progress.
const stageLabels: Record<string, string> = { queued: '等待处理', input_lock: '准备本次材料', materials_ready: '读取材料',
  review_sources: '读取已固定的材料依据', review_rules: '核对复核依据', review_completion: '核对复核成果完整性',
  review_revision_cli_method: '核对已确认修订范围', review_revision_cli_v1_prompt: '准备修订请求',
  public_review_prompt: '准备公开信息核验', model_generation: '整理复核结果', provider_call: '正在复核募集书',
  provider_reconcile: '核对先前调用结果', review_file_v1_prompt: '准备复核请求', word_delivery: '准备 Word 成果', word_delivery_pair: '登记 Word 成果',
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
  WORD_FORMAT_OPERATIONS_MISSING: '本轮编制未保存必需的修订记录，未生成可交付的 Word。请联系支持核对本轮结果。',
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
  if (run && ['preparing','queued'].includes(run.state)) return { heading:'复核等待处理', message:'本轮已提交，尚未生成有效报告；页面会自动显示最新进度。' };
  return isActiveRun(run)
    ? { heading:'复核正在进行', message:'报告生成后可在这里下载，关闭页面后任务仍会继续。' }
    : { heading:'还没有复核报告', message:'提供材料并开始复核后，在这里下载复核报告。' };
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
  const event=[...task.events].sort((a,b)=>b.seq-a.seq).find(item=>item.run_id===run.run_id&&item.seq<=(run.event_cursor??0)&&item.state===run.state&&item.stage===run.stage&&item.payload.reason!=='review_action'&&(item.payload.reason||item.payload.error_code));
  return eventNotice(event)??(['failed','rejected'].includes(run.state)?'本轮未完成。请核对已保存的材料与服务状态；仍无法继续时联系支持。':run.state==='paused'?'本轮已暂停，正在等待处理条件恢复；当前输入和已保存结果保留。':undefined);
}

const actionCopy: Record<ReviewActionCode,{started:string;completed:string;failed:string;summary:string}> = {
  read_materials:{started:'正在读取材料',completed:'已读取材料',failed:'材料读取未完成',summary:'正在读取本轮固定的募集书与核验材料，确认可用依据。'},
  read_knowledge:{started:'正在读取复核依据',completed:'已读取复核依据',failed:'复核依据读取未完成',summary:'正在读取本轮适用的复核知识与规则依据。'},
  check_financial:{started:'正在核对财务数据',completed:'已执行财务数据核对',failed:'财务数据核对未完成',summary:'正在执行财务核对，检查披露数据与材料中的依据。'},
  check_compliance:{started:'正在检查合规与格式',completed:'已执行合规与格式检查',failed:'合规与格式检查未完成',summary:'正在对照适用依据，检查披露事项与文档格式。'},
  search_public:{started:'正在检索公开依据',completed:'已执行公开依据检索',failed:'公开依据检索未完成',summary:'正在查找与本轮核验对象有关的公开来源。'},
  compare_sources:{started:'正在对照核验依据',completed:'已执行依据对照',failed:'依据对照未完成',summary:'正在对照募集书与核验来源，检查披露是否一致。'},
  revise_document:{started:'正在处理修订任务',completed:'已执行修订处理动作',failed:'修订处理动作未完成',summary:'正在按已确认范围处理募集书，保留原报告与未修改事项。'},
  prepare_report:{started:'正在整理复核报告',completed:'已整理复核报告',failed:'复核报告整理未完成',summary:'正在汇总复核发现、依据与覆盖限制。'},
};
export type ReviewTaskProgress = {title:string;summary:string;completed:{code:ReviewActionCode;label:string}[]};
export function reviewActionLabel(event:RunEvent):string|undefined {
  const action=event.payload.action;
  if(!action||action.version!=='review-action-v1'||!/^[a-f0-9]{64}$/.test(action.action_id)||!Object.hasOwn(actionCopy,action.code)||!['started','completed','failed'].includes(action.state))return undefined;
  return actionCopy[action.code][action.state];
}

/** Current state always wins over a late tool event; no stage transition implies a completed action. */
export function reviewRunProgress(run: Run): Pick<ReviewTaskProgress,'title'|'summary'> {
  if(run.state==='cancelled')return{title:'本轮任务已停止',summary:'原有效报告保留，本轮中断的范围未完成。'};
  if(['failed','rejected'].includes(run.state))return{title:'本轮任务未完成',summary:'原有效报告与已保存的输入保留。'};
  if(run.state==='paused')return{title:'本轮任务已暂停',summary:'正在等待处理条件恢复，当前输入与已保存结果保留。'};
  if(run.state==='awaiting_input')return{title:'等待补充信息',summary:'请核对本轮需要补充的信息，当前输入与原有效报告保留。'};
  if(['succeeded','test_completed'].includes(run.state))return{title:run.state==='test_completed'?'内部测试稿已生成':'本轮任务已完成',summary:'请结合已登记成果的实际覆盖与依据阅读结论。'};
  if(['queued','preparing'].includes(run.state))return{title:run.state==='queued'?'任务已提交，等待开始':'正在准备本轮任务',summary:'本轮材料与要求已保存，无需重复提交。'};
  const stage=reviewStageLabel(run.stage,run.state);
  return{title:stage??'正在执行本轮任务',summary:'正在按本轮固定材料与已确认范围处理。'};
}

/** Host-validated action identities are replay-safe. Consecutive activity of one kind has one summary. */
export function reviewTaskProgress(task: ReviewTask): ReviewTaskProgress {
  const run=task.run;
  const events=[...new Map(task.events.filter(event=>event.run_id===run.run_id&&event.seq<=(run.event_cursor??0)).map(event=>[event.event_id,event])).values()].sort((a,b)=>a.seq-b.seq);
  const actions=new Map<string,RunEvent>();
  for(const event of events){
    const action=event.payload.action;
    if(!action||action.version!=='review-action-v1'||!Object.hasOwn(actionCopy,action.code)||!['started','completed','failed'].includes(action.state)||!/^[a-f0-9]{64}$/.test(action.action_id))continue;
    const previous=actions.get(action.action_id)?.payload.action;
    if(previous&&(previous.code!==action.code||previous.state!=='started'&&previous.state!==action.state))continue;
    actions.set(action.action_id,event);
  }
  const finalActions=[...actions.values()].sort((a,b)=>a.seq-b.seq);
  const completed:ReviewTaskProgress['completed']=[];
  for(const event of finalActions){const action=event.payload.action!;if(action.state==='completed'&&completed.at(-1)?.code!==action.code)completed.push({code:action.code,label:actionCopy[action.code].completed});}
  const fallback={...reviewRunProgress(run),completed};
  if(!['running','validating','delivering','settlement_pending'].includes(run.state))return fallback;
  if(reviewTaskNotice(task)==='正在停止')return{...fallback,title:'正在停止本轮任务',summary:'停止请求已提交，正在等待服务端确认。'};
  const latestAction=finalActions.filter(event=>event.payload.action!.state==='started').at(-1)??finalActions.at(-1);
  if(!latestAction)return fallback;
  const laterStage=events.find(event=>event.seq>latestAction.seq&&!event.payload.action&&reviewStageLabel(event.stage,event.state));
  if(laterStage)return fallback;
  const action=latestAction.payload.action!,copy=actionCopy[action.code];
  const stageProgress=reviewRunProgress(run);
  if(action.state==='started'&&stageProgress.title!==copy.started&&stageProgress.title!=='正在执行本轮任务')return fallback;
  return{title:copy[action.state],summary:action.state==='started'?copy.summary:action.state==='completed'?'这项动作已完成，任务继续以已确认范围执行。':'这项动作未完成，正在核对任务的后续处理状态。',completed};
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

export function reviewTaskHtml(task: ReviewTask, _createdAt: string, reportNames: Record<string,string> = {}): string {
  const run = task.run, active = isActiveRun(run), progress=reviewTaskProgress(task);
  const notices=[...new Set(task.events.filter(event=>event.run_id===run.run_id&&event.seq<=(run.event_cursor??0)).map(eventNotice).filter((notice):notice is string=>Boolean(notice)))];
  const reason = reviewTaskNotice(task);
  const origin = task.origin.entrypoint === 'assistant_proposal' ? '对话确认执行' : task.origin.entrypoint==='quick_action'?'页面快捷操作':'入口未记录（旧任务）';
  return `<article class="review-task-card ${active?'active':''}" id="review-task-${esc(run.run_id)}" data-task-run="${esc(run.run_id)}" tabindex="-1">
    <header><span>✦ 任务记录</span><span class="review-tag">${runStateLabel[run.state]}</span></header>
    <h3>${task.export_only?'保存处理结果':reviewOperationLabels[task.operation]}</h3><p class="review-task-meta">执行 V${task.version} · 固定输入 V${task.input_version} · ${origin}</p>
    <p class="review-task-scope">${task.export_only?'按已保存选择导出 · 不调用 AI':task.operation==='full_review'?'财务数据 · 勾稽关系 · 政策重点提示 · 格式与标点':task.finding_ids.map(esc).join('、')||'范围以已确认计划为准'}</p>
    ${task.source_report_id?`<p class="review-muted">来源报告 <button class="text-btn" data-assistant-action="report" data-report-id="${esc(task.source_report_id)}" title="${esc(task.source_report_id)}">${esc(reportNames[task.source_report_id]??'来源报告')}</button></p>`:''}
    <div class="review-task-current" role="status"><strong class="review-task-stage">${esc(progress.title)}</strong><p>${esc(progress.summary)}</p></div>${reason?`<p class="review-warning">${esc(reason)}</p>`:''}
    <p class="review-task-boundary">${active?'本次材料与要求已锁定，关闭页面不会取消任务。':run.state==='cancelled'?'本轮已停止，原有效报告保留。':run.state==='failed'||run.state==='rejected'?'本轮未完成，原有效报告保留。':task.operation==='revision'?'已修改，待复核；修订不会自动开始重核。':task.report_id?'成果已登记；请结合实际覆盖与依据阅读结论。':'尚无已登记复核成果。'}</p>
    <div class="review-task-actions">${task.report_id?`<button class="btn secondary small" data-assistant-action="report" data-report-id="${esc(task.report_id)}">查看本轮结果</button>`:task.source_report_id?`<button class="btn secondary small" data-assistant-action="report" data-report-id="${esc(task.source_report_id)}">查看保留报告</button>`:''}${active?`<button class="text-btn" data-review-action="cancel">停止本次任务</button><button class="text-btn" data-review-action="task-status" data-run-id="${esc(run.run_id)}">${run.state==='paused'?'查看暂停任务':'查看进行中任务'}</button>`:''}${task.artifacts.map(artifact=>`<button class="text-btn" data-review-action="task-download" data-run-id="${esc(run.run_id)}" data-artifact-id="${esc(artifact.artifact_id)}">下载${{report:'问题报告',comments:'批注稿',revision:'修订版',clean:'清洁版',baseline:'基线文稿'}[artifact.kind]}</button>`).join('')}</div>
    ${progress.completed.length||notices.length?`<details class="review-task-events"><summary>${progress.completed.length?`已完成 ${progress.completed.length} 项动作`:'查看处理说明'}</summary>${progress.completed.length?`<ol>${progress.completed.map(action=>`<li>${esc(action.label)}</li>`).join('')}</ol>`:''}${notices.filter(notice=>notice!==reason).map(notice=>`<p class="review-task-notice">${esc(notice)}</p>`).join('')}</details>`:''}
  </article>`;
}
