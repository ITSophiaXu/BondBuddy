import {formatPoints} from '@bondbuddy/contracts';
import type {M4Task, RunEvent} from './billing-types.js';
import {authoringCreditReceipt, authoringEventLabel, authoringStatus} from './authoring-progress';
import {m4ProgressLabel} from './m4-workspace-state';
import {esc} from './ui';
import './project-execution.css';
import './material-progress.css';

const materialWords=(s:string)=>s.replaceAll('正在编制募集书内容','正在编制材料正文').replaceAll('正在编制募集书','正在编制材料').replaceAll('原稿与财务材料','本次材料').replaceAll('材料与更新范围','材料与编制要求').replaceAll('积分已冻结','积分已停止扣减');
function activityLabel(e:RunEvent):string|null {
  const activity=authoringEventLabel(e);
  if(activity)return materialWords(activity);
  const states:Record<string,string>={succeeded:'正文 Word 和编制说明已生成，可以下载',cancelled:'本次生成已结束',failed:'本次生成未完成',rejected:'本次生成未开始'};
  if(states[e.state])return states[e.state];
  if(e.stage==='billing_reconcile')return '正在核对积分账务，已保存进度并暂停';
  if(e.stage==='credits_exhausted')return '积分已用完，已保存进度并暂停';
  if(e.stage==='user_paused')return '已保存进度，生成已暂停';
  if(e.payload.reason==='user_pause_requested')return '已收到暂停请求，正在保存进度';
  if(e.payload.reason==='user_resumed'||e.payload.reason==='credits_recharged')return '继续本次生成，复用已保存的结果';
  if(e.state==='queued')return '任务已提交，等待开始处理';
  if(e.payload.reason?.startsWith('m4_'))return m4ProgressLabel(e.stage,e.payload.reason);
  if(['input_lock','materials_ready','model_generation','word_delivery'].includes(e.stage??'')&&e.payload.reason==='stage_started')return m4ProgressLabel(e.stage);
  return null;
}
export function materialActivityEntries(task:M4Task){
  const seen=new Set<string>();
  return [...task.events].filter(e=>e.run_id===task.run.run_id&&e.seq<=(task.run.event_cursor??0)).sort((a,b)=>a.seq-b.seq).flatMap(e=>{
    const label=activityLabel(e),a=e.payload.authoring_activity;
    const key=a?`${a.activity_id}:${a.state}`:`${e.state}:${e.stage}:${e.payload.reason}`;
    if(!label||seen.has(key))return [];seen.add(key);
    return [{label,at:e.occurred_at}];
  }).slice(-30);
}
export function materialActivityLog(task:M4Task){
  const entries=materialActivityEntries(task);
  return `<section class="material-activity-log" aria-label="生成过程"><h3>生成过程</h3><p class="m4-muted">记录本轮已返回的处理状态，随生成自动更新。</p>${entries.length?`<ol>${entries.map(e=>`<li><time datetime="${esc(e.at)}">${esc(new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false}))}</time><span>${esc(e.label)}</span></li>`).join('')}</ol>`:'<p class="m4-muted" role="status">尚未收到处理记录，新状态返回后会显示在这里。</p>'}</section>`;
}
export function materialLiveStatus(task:M4Task){
  const status=authoringStatus(task.run,task.events,task.credit_charge?.progress);
  if(!status)return undefined;
  const latest=task.events.at(-1);
  const stage=task.run.stage,generating=['model_generation','m4_document_prompt','m4_document_v1_prompt'].includes(stage??'');
  if(task.run.state==='running'&&latest?.state==='running'&&(latest.stage===stage||generating&&latest.stage==='model_generation')&&!task.credit_charge?.progress?.credit_exhausted&&!task.credit_charge?.progress?.pause_requested&&latest?.payload.reason?.startsWith('m4_')){
    status.title=m4ProgressLabel(stage,latest.payload.reason);
    if(latest.payload.reason==='m4_reading_materials')status.phase=1;
    if(latest.payload.reason==='m4_registering_artifacts')status.phase=3;
  }
  return {...status,title:materialWords(status.title),summary:materialWords(status.summary)};
}
export function materialCreditReceipt(task:M4Task){
  const charge=task.credit_charge,p=charge?.progress;
  if(charge?.quote&&(!p||p.policy==='on_delivery'))return `<section class="material-legacy-credit" aria-label="积分消耗"><strong>本轮沿用原计费规则</strong><p>${formatPoints(charge.quote.points)} 积分 · ${{held:'已预留，成功交付后扣费',settled:'已扣费',released:'已返还，本次不扣费'}[charge.state??'held']}</p></section>`;
  const receipt=materialWords(authoringCreditReceipt(task.run,p,charge?.quote?{...charge.quote,state:charge.state??'held'}:undefined));
  return p?.policy==='authoring_balance_v2'&&charge?.quote?receipt.replace('全程不超过原任务价格。',`本次完整交付共 ${formatPoints(charge.quote.points)} 积分，任务完成时结清剩余积分。`):receipt;
}
