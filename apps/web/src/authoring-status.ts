import type {Run,RunEvent,AuthoringProgress,RunRetryResponse} from './billing-types.js';
import {authoringStatus,authoringVisibleEvents,authoringEventLabel,authoringCreditReceipt} from './authoring-progress.js';
import {isCnyPrice,displayPrice} from './commerce-price.js';
import {date,esc} from './ui.js';

const labels=['等待开始','准备材料','编制募集书','保存文档','可下载'];
type Phase=0|1|2|3|4;
export function authoringPhase(run:Run,events:RunEvent[],progress?:AuthoringProgress,override?:Phase):Phase{
  if(['succeeded','test_completed'].includes(run.state)&&run.artifact_id)return 4;
  if(['delivering','settlement_pending'].includes(run.state)||run.stage?.startsWith('word_delivery'))return 3;
  const observed=events.filter(e=>e.run_id===run.run_id&&e.seq<=(run.event_cursor??Infinity)).sort((a,b)=>a.seq-b.seq);
  const reason=observed.at(-1)?.payload.reason;
  if(run.state==='queued'&&['file_authoring_payload_retry_scheduled','file_authoring_output_limit_retry_scheduled','file_authoring_timeout_retry_scheduled','file_authoring_manual_restart_scheduled'].includes(reason??''))return 2;
  if(['queued','preparing','rejected'].includes(run.state))return 0;
  const current=authoringStatus(run,events,progress)?.phase;
  if(current!==undefined)return current;
  if(override!==undefined)return override;
  const stage=run.stage==='billing_reconcile'
    ?[...observed].reverse().find(e=>e.stage&&!['billing_reconcile','provider_reconcile','user_paused'].includes(e.stage))?.stage
    :[...observed].reverse().find(e=>e.type==='run.progress'&&e.stage)?.stage??run.stage;
  if(stage?.startsWith('word_delivery'))return 3;
  if(stage==='queued'||run.stage==='billing_reconcile'&&!stage)return 0;
  if(['input_lock','materials_ready','claimed','awaiting_materials','capability_not_ready'].includes(stage??''))return 1;
  return 2;
}
export function retryExplanation(offer:RunRetryResponse):string{
  const reasons:Record<RunRetryResponse['reason_code'],string>={
    user_paused:'任务由你暂停，可继续本次任务。',
    checkpoint_available:'已保存的工作进度可以继续，重试仍沿用本次任务与积分预留。',
    restart_confirmation_required:'上次处理已结束，但没有可续跑的工作快照。重试将使用本次锁定的原材料重新处理，需先确认。',
    not_paused:'任务状态已经变化，正在刷新最新进度。',
    unsupported_task:'这类任务暂不支持从此处重试，请联系支持核对。',
    provider_evidence_unresolved:'上次调用记录尚需核对，暂不能再次处理。请稍后刷新，持续未恢复时请联系支持。',
    active_attempt:'上次模型处理仍在运行或退出状态尚未确认，请稍后刷新状态。',
    provider_result_present:'系统已收到处理结果，正在核对已有成果，暂不重复生成。',
    provider_evidence_conflict:'上次处理结果存在不一致记录，需要支持核对后才能继续。',
    billing_not_ready:'积分账务正在核对，完成后才能重试。',
    credits_exhausted:'积分不足，请查看余额与支付状态后继续本次任务。',
    retry_limit_reached:'本次任务已达到重试上限，请联系支持处理。',
    checkpoint_unavailable:'恢复进度暂不可用，请联系支持核对；已保存材料会保留。',
    user_pause_pending:'已收到你的暂停请求，保存完成后可继续本次任务。',
    checkpoint_capacity_exceeded:'本次工作进度超过恢复文件的保存上限，未能保存可续跑快照。',
    checkpoint_storage_failed:'本次恢复文件未能保存到存储，尚无已确认的可续跑快照。',
    checkpoint_integrity_failed:'本次工作文件未通过完整性检查，未能保存可续跑快照。',
    checkpoint_capture_incomplete:'本次恢复文件的保存结果尚未确认，暂不能从中间进度续跑。',
  };
  if(['checkpoint_capacity_exceeded','checkpoint_storage_failed','checkpoint_integrity_failed','checkpoint_capture_incomplete'].includes(offer.reason_code))
    return reasons[offer.reason_code]+(offer.mode==='restart_materials'?'可点击重试，确认后从本次锁定的原材料重新处理；未保存的中间进度无法恢复。':'请联系支持核对，已上传材料与已有成果会保留。');
  return reasons[offer.reason_code];
}
export function authoringStatusCard(run:Run,events:RunEvent[],options:{progress?:AuthoringProgress;summary?:string;phase?:Phase;actions:string;feedback?:string;retry?:RunRetryResponse}){
  const observed=authoringStatus(run,events,options.progress),phase=authoringPhase(run,events,options.progress,options.phase);
  const success=['succeeded','test_completed'].includes(run.state)&&!!run.artifact_id;
  const missingArtifact=['succeeded','test_completed'].includes(run.state)&&!run.artifact_id;
  const failed=['failed','rejected'].includes(run.state),paused=run.state==='paused',awaitingInput=run.state==='awaiting_input';
  const captureUnavailable=paused&&run.stage==='provider_reconcile'&&options.retry&&['checkpoint_capacity_exceeded','checkpoint_storage_failed','checkpoint_integrity_failed','checkpoint_capture_incomplete'].includes(options.retry.reason_code);
  const tone=success?'success':paused||awaitingInput?'paused':failed?'failed':run.state==='cancelled'||missingArtifact?'neutral':'running';
  const badge=success?'已完成':missingArtifact?'待核对':awaitingInput?'待补信息':paused?'已暂停':failed?'未完成':run.state==='cancelled'?'已停止':run.state==='queued'?'排队中':'处理中';
  const title=success?(run.state==='test_completed'?'内部测试稿已生成':'募集书已编制完成'):missingArtifact?'任务已结束，文档尚未同步':failed?'本轮未完成':run.state==='cancelled'?'本轮已停止'
    :awaitingInput?'等待补充信息':captureUnavailable?'恢复进度未能保存':paused?run.stage==='credits_exhausted'?'积分不足，任务已暂停':run.stage==='billing_reconcile'?'正在核对积分账务，任务已暂停':run.stage==='user_paused'?'任务已暂停':`${labels[phase]}时暂停`
    :observed?.title??labels[phase];
  const summary=captureUnavailable?retryExplanation(options.retry!):options.summary??observed?.summary??(success?'5 个步骤全部完成，文档已保存。':missingArtifact?'暂未取得可下载文档，请重新读取任务状态。':failed?'本轮未完成，已保存材料会保留。':run.state==='cancelled'?'任务已停止，已保存材料与已有成果保留。':'正在核对任务状态。');
  const outputLimitEnded=failed&&['file_authoring_output_limit_recovery_unavailable','file_authoring_output_limit_retries_exhausted','file_authoring_timeout_recovery_unavailable','file_authoring_timeout_retries_exhausted'].includes(authoringVisibleEvents(run,events).at(-1)?.payload.reason??'');
  const note=success||missingArtifact?'':run.state==='cancelled'?'':outputLimitEnded?'已保存的材料会保留。':paused&&run.stage==='provider_reconcile'?'已保存的材料会保留。关闭页面不会取消任务。':'关闭页面不会取消任务。';
  const symbol=success?'✓':paused?'Ⅱ':failed?'!':run.state==='cancelled'?'—':'•';
  const extra=!captureUnavailable&&options.retry&&options.retry.mode!=='restore_checkpoint'?retryExplanation(options.retry):'';
  return `<section class="authoring-status-card task-progress" data-tone="${tone}" data-input-revision="${run.input_revision}" aria-label="编制进度"><div class="authoring-status-header task-progress-heading"><div class="authoring-status-title-group"><div class="authoring-status-title-line"><span class="authoring-status-badge"><span aria-hidden="true">${symbol}</span>${badge}</span><h3 role="status">${esc(title)}</h3></div><div class="authoring-status-description">${summary?`<p${options.summary?' class="execution-summary"':''}>${esc(summary)}</p>`:''}${note?`<p>${esc(note)}</p>`:''}${extra?`<p class="authoring-status-retry-note">${esc(extra)}</p>`:''}${options.feedback?`<p id="run-action-feedback" role="status">${esc(options.feedback)}</p>`:''}</div></div>${options.actions?`<div class="authoring-status-actions">${options.actions}</div>`:''}</div><ol class="authoring-status-steps task-progress-steps" aria-label="处理流程">${labels.map((label,i)=>{
    const state=success||i<phase?'done':i===phase?'current':'future';
    return `<li class="authoring-status-step" data-step-state="${state}" ${i===phase?'aria-current="step"':''}><div class="authoring-status-step-row"><span class="authoring-status-step-icon" aria-hidden="true">${state==='done'?'':i+1}</span><span class="authoring-status-step-label">${label}</span></div></li>`;
  }).join('')}</ol></section>`;
}
export function authoringStatusRecords(run:Run,events:RunEvent[]):string{
  const visible=authoringVisibleEvents(run,events);
  const names:Record<string,string>={input_lock:'正在核对本次输入',materials_ready:'正在准备材料',provider_call:'正在编制募集书',word_delivery:'正在保存文档',queued:'任务已提交，正在排队'};
  return `<details class="authoring-status-records" id="authoring-records" open><summary>处理记录（${visible.length} 条）</summary>${visible.length?`<ol class="authoring-status-record-list execution-events">${visible.map(event=>{
    const failed=event.payload.authoring_activity?.state==='failed'||event.state==='failed';
    const badge=failed?'出错':event.state==='paused'?'暂停':['succeeded','test_completed'].includes(event.state)?'完成':'';
    const tone=failed?'failed':event.state==='paused'?'paused':'success';
    const label=authoringEventLabel(event)??(event.state==='succeeded'?'文档已保存，可下载':event.state==='paused'?'任务已暂停':event.state==='cancelled'?'任务已停止':names[event.stage??'']??'任务状态已更新');
    const time=new Date(event.occurred_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
    return `<li class="authoring-status-record"><time datetime="${esc(event.occurred_at)}" title="${esc(date(event.occurred_at))}">${esc(time)}</time><div>${badge?`<span class="authoring-status-record-badge" data-tone="${tone}">${badge}</span>`:''}<span>${esc(label)}${event.payload.completed_items!==undefined?` · 已处理 ${event.payload.completed_items}${event.payload.total_items!=null?' / '+event.payload.total_items:''} 项`:''}</span></div></li>`;
  }).join('')}</ol>`:'<p class="authoring-status-empty">处理记录尚未同步，任务状态会自动更新。</p>'}</details>`;
}
export function authoringStatusReceipt(...args:Parameters<typeof authoringCreditReceipt>):string{
  const legacy=args[2];
  if(isCnyPrice(legacy))return `<section class="authoring-status-billing authoring-credit-meter" aria-label="任务费用"><div><span>${legacy!.state==='settled'?'本次已结算':legacy!.state==='released'?'预留已释放':'已预留'}</span><strong role="status">${esc(displayPrice(legacy))}</strong><span>· 按确认范围交付结算，未交付部分释放</span></div><details><summary>计费说明</summary><p>原范围修正与平台重试包含，不按内部轮次加收。实际费用以本次任务保存的报价和账务为准。</p></details></section>`;
  return `<div class="authoring-status-billing">${authoringCreditReceipt(...args)}</div>`;
}
