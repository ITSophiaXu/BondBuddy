import {formatPoints} from '@bondbuddy/contracts';
import type {AuthoringProgress, ReviewTask, Run, RunEvent} from './billing-types.js';
import type {Dto} from './api';
import {esc} from './ui';
import {authoringCreditReceipt, elapsedLabel} from './authoring-progress';
import {taskProgress} from './task-progress';
import {isActiveRun} from './review-state';
import {reviewActionLabel, reviewRunProgress, reviewStageLabel, reviewTaskProgress} from './review-timeline';
import './project-execution.css';
import './review-progress.css';
import {isCnyPrice} from './commerce-price.js';

export function reviewLiveStatus(run:Run,task?:ReviewTask,p?:AuthoringProgress){
  const observed=task?reviewTaskProgress(task):reviewRunProgress(run);
  if(task?.export_only)return {...observed,title:['queued','preparing','running'].includes(run.state)?'正在保存处理结果并导出文档':observed.title,summary:'按你保存的处理选择生成新版本，保留历次成果；不调用 AI，不消耗积分。'};
  if(!isActiveRun(run))return observed;
  if(p?.credit_exhausted)return {...observed,title:run.state==='paused'?'积分已用完，复核已暂停':'积分已用完，正在保存进度后暂停',summary:'积分已停止扣减，已完成的工作会保留。充值到账后继续同一次复核。'};
  if(p?.pause_requested)return {...observed,title:run.state==='paused'?'复核已暂停':'正在保存进度后暂停',summary:'积分停止累计；继续时会复用已保存的复核结果。'};
  if(run.state==='queued')return {...observed,title:'正在安排复核任务',summary:(p?`已排队 ${elapsedLabel(Math.max(0,Date.parse(p.sampled_at)-Date.parse(p.queued_at)))}。`:'')+(p?.queue_ahead?`前方有 ${p.queue_ahead} 个同类任务。`:'正在等待执行服务接单。')+'排队期间不消耗积分。'};
  if(run.state==='running'&&p){
    if(!p.clock_running)return {...observed,summary:'执行连接正在恢复，积分暂不增加；已保存的复核进度保留。'};
    if(p.last_activity_at&&Date.parse(p.sampled_at)-Date.parse(p.last_activity_at)>=60000)return {...observed,summary:'模型仍在处理，暂未返回新的复核状态；收到新状态后会自动展示。'};
  }
  return observed;
}

export function reviewActivityEntries(run:Run,events:RunEvent[]){
  const seen=new Set<string>();
  return [...events].filter(e=>e.run_id===run.run_id&&e.seq<=(run.event_cursor??0)).sort((a,b)=>a.seq-b.seq).flatMap(event=>{
    const label=reviewActionLabel(event)??(!event.payload.action?reviewStageLabel(event.stage,event.state):undefined);
    const key=event.payload.action?`${event.payload.action.action_id}:${event.payload.action.state}`:`${event.state}:${event.stage}`;
    if(!label||seen.has(key))return [];seen.add(key);
    return [{label,at:event.occurred_at,seq:event.seq}];
  }).slice(-30);
}

export function reviewProgressPage(run:Run,task:ReviewTask|undefined,charge:Dto<'RunCreditChargeResponse'>|undefined,options:{chargeError?:boolean}={}){
  const p=charge?.progress,active=isActiveRun(run),status=reviewLiveStatus(run,task,p),entries=reviewActivityEntries(run,task?.events??[]);
  const exporting=task?.export_only===true,revision=task?.operation==='revision'||charge?.quote?.task_type==='review_revision',verb=exporting?'导出':revision?'修订':'复核';
  if(revision){status.title=status.title.replaceAll('复核','修订');status.summary=status.summary.replaceAll('复核','修订');}
  const legacy=run.billing_mode==='fixed_credits'&&charge?.quote&&!isCnyPrice(charge.quote)&&(!p||p.policy==='on_delivery');
  const credits=exporting?'<p class="review-muted" role="status">本次仅导出处理结果，不调用 AI，不消耗积分。</p>':legacy?`<section class="review-legacy-credit" aria-label="积分消耗"><strong>本轮沿用原计费规则</strong><p>${formatPoints(charge.quote!.points)} 积分 · ${{held:'已预留，成功交付后扣费',settled:'已扣费',released:'已返还，本次不扣费'}[charge.state??'held']}</p></section>`:authoringCreditReceipt(run,p,charge?.quote?{...charge.quote,state:charge.state??'held'}:undefined,options.chargeError);
  const canPause=!exporting&&active&&['queued','running'].includes(run.state)&&!p?.pause_requested&&!p?.credit_exhausted;
  const canResume=!exporting&&active&&run.state==='running'&&!!p?.pause_requested;
  return `<div class="review-live-workspace"><header class="review-live-heading"><div><h2>${active?verb+'进度':'本轮'+verb}</h2><p>${revision?'按已选问题修订 · 完成后可另行复核':task?.operation==='differential_review'?'重核本轮选定问题 · 保留未涉及的原结论':exporting?'按已保存选择导出 · 保留旧版':'财务数据 · 勾稽关系 · 政策重点提示 · 格式与标点'}</p></div><span class="review-tag">${task?`第 ${task.version} 轮`:'本轮任务'}</span></header>${taskProgress(run,exporting?'export':revision?'revision':'review',status,{availablePoints:p?.available_points})}${credits}${options.chargeError&&charge?'<p class="review-muted" role="status">积分状态暂未同步，上方保留最近一次记录；恢复连接后自动更新。</p>':''}
  <div class="review-live-controls">${canPause?`<button class="btn secondary" data-review-action="pause">暂停${verb}</button>`:''}${canResume?`<button class="btn primary" data-review-action="resume">继续${verb}</button>`:''}${p?.credit_exhausted?'<button class="btn primary" data-review-action="recharge">查看积分与支付状态</button>':''}${active?`<button class="text-btn" data-review-action="cancel">结束本次${verb}</button>`:`<button class="btn primary" data-review-action="task-result" data-run-id="${esc(run.run_id)}">查看${verb}结果</button><button class="btn secondary" data-review-action="prepare">准备新任务</button>`}</div>
  <section class="review-activity-log" aria-label="${verb}过程"><h3>${verb}过程</h3><p class="review-muted">展示本轮已返回的处理状态，随${verb}自动更新。</p>${entries.length?`<ol>${entries.map(e=>`<li><time datetime="${esc(e.at)}">${esc(new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false}))}</time><span>${esc(e.label)}</span></li>`).join('')}</ol>`:`<p class="review-activity-empty">${run.state==='queued'?'任务已提交，等待执行服务开始处理。':'尚未收到详细处理状态；新状态返回后会显示在这里。'}</p>`}</section>
  </div>`;
}
