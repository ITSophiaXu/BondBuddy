import {int64} from '@bondbuddy/contracts';
import {formatPoints} from '@bondbuddy/contracts';
import {AUTHORING_ACTIVITY_LABELS,isAutomaticPriceVersion,type Run,type RunEvent,type AuthoringProgress} from './billing-types.js';
import {esc} from './ui.js';
const ended=(r:Run)=>['succeeded','test_completed','failed','rejected','cancelled'].includes(r.state);
export function elapsedLabel(ms:number){const s=Math.floor(ms/1000);return s<60?s+'秒':Math.floor(s/60)+'分'+String(s%60).padStart(2,'0')+'秒';}
export function authoringEventLabel(event:RunEvent):string|null{
  const a=event.payload.authoring_activity;
  if(!a)return null;
  const label=AUTHORING_ACTIVITY_LABELS[a.code];
  // Activity errors describe one internal step, not the run lifecycle; a summary must not hide them.
  if(a.state==='failed')return label.replace('正在','处理步骤出错：')+(a.summary?`。进度说明：${a.summary}`:'');
  if(a.summary)return a.summary;
  return a.state==='completed'?label.replace('正在','处理步骤已返回：'):label;
}
/** Keep public summaries separately from noisy tool events, including across paginated reloads. */
export function retainAuthoringEvents(events:RunEvent[]):RunEvent[]{
  const summaries=events.filter(e=>e.payload.authoring_activity?.summary).slice(-12);
  const important=events.filter(e=>!e.payload.authoring_activity||e.payload.authoring_activity.state==='failed').slice(-12);
  return [...new Map([...summaries,...important,...events.slice(-12)].map(e=>[e.event_id,e])).values()].sort((a,b)=>a.seq-b.seq);
}
function observedEvents(run:Run,events:RunEvent[]):RunEvent[]{
  return events.filter(e=>e.run_id===run.run_id&&e.seq<=(run.event_cursor??Infinity)).sort((a,b)=>a.seq-b.seq);
}
/** Reserve history for model summaries and lifecycle/failure events; ordinary operations share one row. */
export function authoringVisibleEvents(run:Run,events:RunEvent[]):RunEvent[]{
  const observed=observedEvents(run,events);
  const important=observed.filter(e=>!e.payload.authoring_activity||e.payload.authoring_activity.summary||e.payload.authoring_activity.state==='failed');
  const last=observed.at(-1);
  const activity=last?.payload.authoring_activity;
  const trailingOperation=last&&activity&&!activity.summary&&activity.state!=='failed'&&last.seq>(important.at(-1)?.seq??-1)?last:undefined;
  return trailingOperation?[...important.slice(-5),trailingOperation]:important.slice(-6);
}
export function authoringStatus(run:Run,events:RunEvent[],p?:AuthoringProgress){
  if(ended(run))return undefined;
  if(p?.credit_exhausted)return {title:run.state==='paused'?'积分已用完，任务已暂停':'积分已用完，正在保存进度后暂停',summary:'积分已停止扣减，已完成的工作会保留。充值到账后自动继续本次任务。',phase:2 as const};
  if(p?.pause_requested&&run.state==='running')return {title:'正在保存进度后暂停',summary:'积分已冻结。当前模型处理结果保存后暂停，继续时会复用已保存的结果。',phase:2 as const};
  if(run.state==='paused'&&run.stage==='user_paused')return {title:'任务已暂停',summary:'进度已保存，积分停止累计。可继续本次任务，或结束并结算已消耗积分。'};
  if(run.state==='queued'){
    const waiting=p?Math.max(0,Date.parse(p.sampled_at)-Date.parse(p.queued_at)):0;
    return {title:waiting>=60000?'仍在排队，尚未开始处理':'正在安排编制任务',
      summary:(p?.queue_ahead?('前方有 '+p.queue_ahead+' 个同类任务。'):'正在等待执行服务接单。')+(p?'已排队 '+elapsedLabel(waiting)+'。':'')+'排队期间不消耗积分。',phase:0 as const};
  }
  if(run.state!=='running')return undefined;
  const observed=observedEvents(run,events);
  const boundary=observed.map(e=>e.stage!==run.stage||e.state!=='running'||e.payload.reason==='user_resumed'||e.payload.reason==='credits_recharged').lastIndexOf(true);
  const current=observed.slice(boundary+1).reverse();
  const last=current.find(e=>e.payload.authoring_activity);
  const a=last?.payload.authoring_activity;
  const reported=current.find(e=>e.payload.authoring_activity?.summary);
  const report=reported?.payload.authoring_activity;
  const fallback=run.stage==='claimed'||run.stage==='input_lock'?'正在准备本次任务':run.stage==='materials_ready'?'正在读取本次材料':run.stage?.includes('word_delivery')?'正在保存 Word 文件并准备下载':'正在编制募集书';
  // Tool activity cannot refresh the age of a model's public progress sentence.
  const stale=!!(reported&&p&&Date.parse(p.sampled_at)-Date.parse(reported.occurred_at)>=60000);
  const failed=a?.state==='failed';
  const title=failed?'处理步骤遇到问题':report?AUTHORING_ACTIVITY_LABELS[report.code]:a?AUTHORING_ACTIVITY_LABELS[a.code]:fallback;
  const notice=p&&!p.clock_running?'执行连接正在恢复，积分暂不增加。':failed?'该步骤出错，任务尚未结束；后续状态会自动更新。':!report?'暂未收到模型的具体进度说明；收到后会自动显示。':stale?'暂未收到新的进度说明；收到后会自动更新。':'';
  const summary=report?.summary?`最近一次模型进度：${report.summary}${notice?' '+notice:''}`:notice;
  return {title,summary,phase:(run.stage==='claimed'||run.stage==='input_lock'||run.stage==='materials_ready'?1:run.stage?.includes('word_delivery')?3:2) as 1|2|3};
}
export function authoringCreditReceipt(run:Run,p?:AuthoringProgress,legacy?:{points:string;state:string}&CommercePriceMetadata,error=false):string{
  if(isCnyPrice(legacy))return `<section class="authoring-credit-meter" aria-label="${isAutomaticPriceVersion(legacy?.price_version)?'任务积分费用':'人民币任务费用'}"><div><span>${legacy!.state==='settled'?'本次已结算':legacy!.state==='released'?'预留已释放':'本次已预留'}</span><strong role="status">${displayPrice(legacy)}</strong></div><p>按确认范围交付结算；未交付部分释放。原范围修正与平台重试包含，不按内部轮次加收。</p></section>`;
  if(run.billing_mode!=='fixed_credits')return '<p class="task-credit-receipt">本次任务按提交时的试用规则执行，不扣积分。</p>';
  if(!p){
    if(legacy&&legacy.state!=='held')return '<p class="task-credit-receipt">'+(legacy.state==='settled'?'已扣费 '+formatPoints(legacy.points)+' 积分':'已返还，本次不扣费')+'</p>';
    return '<p class="task-credit-receipt">'+(error?'积分状态暂未同步，恢复连接后自动更新。':'正在同步已消耗积分…')+'</p>';
  }
  const terminal=ended(run),n=terminal?p.charged_points:p.accrued_points;
  const caption=terminal?'本次已扣费':'当前已消耗';
  const dynamic=p.policy==='authoring_balance_v2';
  const note=terminal?(int64(p.released_points)>0n?'未消耗的 '+formatPoints(p.released_points)+' 积分已释放。':'结算已完成。'):
    p.pause_requested||p.credit_exhausted||run.state==='paused'?'积分已冻结，继续处理后再累计。':run.state==='queued'?'尚未开始处理，积分不会增加。':dynamic?'已按实际进度扣减；余额归零时暂停，积分充足后继续。':'按有效处理时间和已完成工作累计，完成后结算。';
  return '<section class="authoring-credit-meter" aria-label="积分消耗"><div><span>'+caption+'</span><strong role="status">'+formatPoints(n)+' <small>积分</small></strong></div><div class="authoring-credit-meta">'+(dynamic?'<span>可用余额 '+formatPoints(p.available_points??'0')+' 积分</span>':'')+'<span>有效处理 '+esc(elapsedLabel(p.active_ms))+'</span><span>'+note+'</span></div><details><summary>计费说明</summary><p>'+(dynamic?'有积分即可开始，按服务端有效处理时间和已完成工作扣减；排队和暂停不扣。余额归零保存后暂停，到账后续跑。主动结束保留已扣部分，平台失败退回已扣积分，全程不超过原任务价格。':p.policy==='authoring_progress_v1'?'排队、暂停、执行连接中断时不累计。暂停冻结累计金额；结束任务按已消耗积分结算，其余释放。平台失败不收费。任务完成时按原任务价格结算，全程不超过该价格。':'本次任务保留提交时的规则：成功交付后结算，取消或失败不扣费。')+'</p></details></section>';
}
import type {CommercePriceMetadata} from './billing-types.js';
import {isCnyPrice,displayPrice} from './commerce-price.js';
