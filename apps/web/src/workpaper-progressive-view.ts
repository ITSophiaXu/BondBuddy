import { taskRestartHtml } from './task-restart.js';
import type {WorkpaperBatch} from './billing-types';
import {esc,date} from './ui';
import {formatPoints,WORKPAPER_DECISION_LABELS} from '@bondbuddy/contracts';
import {withProjectContext} from './project-navigation';
import {workpaperLiveProgressHtml} from './workpaper-live-progress';
import './workpaper-progressive.css';

const active=(state:string)=>['preparing','running','validating','delivering','settlement_pending'].includes(state);
export const workpaperFailed=(item:WorkpaperBatch['items'][number])=>['failed','rejected'].includes(item.state)||item.state==='cancelled'&&!!item.run_id;
export function progressiveBatchHtml(batch:WorkpaperBatch,busy:boolean){
 const progress=batch.progressive!;const items=batch.items,done=items.filter(i=>i.state==='succeeded').length,failed=items.filter(workpaperFailed).length;
 const documents=items.filter(i=>i.state==='succeeded'&&i.artifacts.some(a=>a.kind==='document')).length,explanations=items.filter(i=>i.state==='succeeded'&&i.explanation).length;
 const trial=items.filter(i=>progress.trial_item_ids.includes(i.entry.id)),trialDone=trial.filter(i=>i.state==='succeeded').length,trialFailed=trial.filter(workpaperFailed).length;
 const trialResults=progress.trial_item_ids.map(id=>trial.find(i=>i.entry.id===id)).filter((item):item is WorkpaperBatch['items'][number]=>!!item&&item.state==='succeeded'&&!!(item.explanation||item.artifacts.some(a=>a.kind==='document')));
 const remaining=items.filter(i=>!progress.trial_item_ids.includes(i.entry.id)&&i.state!=='succeeded'&&!workpaperFailed(i)).length;
 const running=items.filter(i=>active(i.state)||i.state==='queued'&&!!i.run_id),terminal=['complete','partial','cancelled'].includes(batch.state);
 const needsAttention=items.filter(i=>!!i.run_id&&['paused','awaiting_input'].includes(i.state));
 const reasons=new Map<string,number>();
 for(const item of items.filter(workpaperFailed)){const reason=item.error?.trim();if(reason)reasons.set(reason,(reasons.get(reason)??0)+1);}
 const failureReasons=[...reasons],shownReasons=failureReasons.slice(0,3),otherFailures=failureReasons.slice(3).reduce((count,[,affected])=>count+affected,0);
 const failureSummary=shownReasons.length?`<div class="wpg-failure-summary"><h4>失败原因</h4><ul>${shownReasons.map(([reason,count])=>`<li>${esc(reason)}${count>1?`（${count} 份）`:''}</li>`).join('')}</ul>${otherFailures?`<p>另有 ${failureReasons.length-shownReasons.length} 类失败原因，涉及 ${otherFailures} 份文件。</p>`:''}</div>`:'';
 const sharedBlocked=batch.state==='paused'&&batch.pause_reason==='shared_blocked';
 const unfinished=items.length-done-failed,awaiting=progress.phase==='awaiting_confirmation'&&batch.state==='paused'&&!sharedBlocked;
 const working=running.filter(item=>active(item.state)&&!item.progress?.interrupted),interrupted=running.some(item=>item.progress?.interrupted),recovering=interrupted&&!working.length;
 const waiting=['running','queued'].includes(batch.state)&&!working.length&&!interrupted&&(progress.phase==='trial'?trial:items).some(item=>item.state==='queued');
 const current=progress.chapters.filter(c=>c.item_ids.some(id=>working.some(i=>i.entry.id===id))).map(c=>c.title);
 const badge=terminal?(batch.state==='cancelled'?'已停止':failed||unfinished?'部分完成':'已完成'):awaiting?'待确认':batch.state==='paused'?'已暂停':recovering?'执行待恢复':interrupted?'部分文件待恢复':waiting?'排队等待':progress.phase==='trial'?'试生成中':progress.phase==='retry_failed'?'重试中':'生成中';
 const heading=terminal?(batch.state==='cancelled'?'已停止后续生成':failed||unfinished?'本次生成已结束':'全部文件已生成')
  :sharedBlocked?'生成遇到阻碍，已保留成果':awaiting?'试生成已结束，请查看成果':batch.state==='paused'?'后续生成已暂停':recovering?(progress.phase==='trial'?'试生成等待恢复':'生成等待恢复'):waiting?(progress.phase==='trial'?`等待开始试生成 ${trial.length} 份文件`:progress.phase==='retry_failed'?'等待开始重试失败文件':'等待开始生成'):progress.phase==='trial'?`正在试生成 ${trial.length} 份文件`:progress.phase==='retry_failed'?'正在重试失败文件':'正在生成其余文件';
 const description=terminal?`已完成 ${done} / ${items.length} 份${failed?`，${failed} 份失败`:''}${unfinished?`，${unfinished} 份未生成`:''}。已完成文件可继续查看和下载。`
  :sharedBlocked?`已完成 ${done} 份${failed?`，${failed} 份失败`:''}。${failed?'处理阻碍后可重试受阻文件，已完成文件保留。':needsAttention.length?'请先在下方查看并处理受阻任务。':running.length?'已完成文件保留。':'受阻文件已处理，可继续本批任务。'}${running.length?`当前 ${running.length} 份仍在收尾，请等待收尾完成。`:''}`
  :awaiting?`试生成 ${trial.length} 份：${trialDone} 份完成${trialFailed?`，${trialFailed} 份失败`:''}。${remaining?`确认后将按章节顺序自动生成其余 ${remaining} 份。`:'已无待生成文件。'}`
  :batch.state==='paused'?`已完成 ${done} 份，已保存进度。${running.length?`当前 ${running.length} 份仍在收尾。`:'可继续本批任务。'}`
  :progress.phase==='trial'?`从前 ${trial.length} 个所选章节各生成 1 份。每份完成后即可查看，试生成结束后再由你确认继续。`
  :`按已选章节顺序连续生成，无需逐批确认。${current.length?`当前章节：${current.join('、')}。`:''}`;
 const action=(name:string,text:string,primary=false)=>`<button class="btn ${primary?'primary':'secondary'}" data-wp-action="${name}" data-batch="${esc(batch.batch_id)}" ${busy||(name==='retry_failed'&&(running.length||needsAttention.length)||sharedBlocked&&name==='resume'&&running.length)?'disabled':''}>${text}</button>`;
 let actions='';
 if(sharedBlocked){if(failed)actions=action('retry_failed','重试受阻文件并继续',true);else actions=action('resume','重新启动本批',true);actions+=action('cancel','停止后续生成');}
 else if(awaiting){if(remaining)actions+=action('continue_remaining',`继续生成其余 ${remaining} 份`,true);if(trialFailed)actions+=action('retry_failed',`仅重试失败的 ${trialFailed} 份`);actions+=`<button class="btn secondary" data-wp-reselect="${esc(batch.batch_id)}" ${busy?'disabled':''}>结束本批并重新选择</button>`;}
 else if(['running','queued'].includes(batch.state))actions=action('pause','暂停')+action('cancel','停止');
 else if(batch.state==='paused')actions=action('resume','重新启动本批',true)+action('cancel','停止后续生成');
 if(terminal){if(failed)actions+=action('retry_failed',`仅重试失败的 ${failed} 份`,true);actions+=`<button class="btn secondary" data-wp-restart="${esc(batch.batch_id)}" ${busy?'disabled':''}>重新开始</button>`;}
 if(trialResults.length)actions+=`<button class="btn secondary" data-wp-show-results="${esc(batch.batch_id)}">查看试生成成果</button>`;
 return `<article class="wp-batch wpg-batch" data-wp-batch-id="${esc(batch.batch_id)}"><section class="wpg-status"><div class="wpg-status-top"><div class="wpg-status-copy"><span class="wpg-phase">${badge}</span><h3>${heading}</h3><p>${esc(description)}</p></div><div class="wp-actions">${actions}</div></div>${workpaperLiveProgressHtml(running)}<div class="wpg-total"><div><span>${progress.phase==='trial'&&!terminal?`试生成：${trialDone+trialFailed} / ${trial.length} 份已处理`:'总进度'}</span><strong>${done} / ${items.length} 份完成${failed?` · ${failed} 份失败`:''}</strong></div><progress max="${Math.max(1,items.length)}" value="${done}" aria-label="底稿完成进度"></progress><p class="wpg-output-counts">已生成底稿 ${documents} 份 · 说明 ${explanations} 份 · 失败 ${failed} 份</p></div>${!terminal?`<p class="wpg-stop-note">暂停或停止后不再启动新文件，当前最多 ${progress.max_parallel} 份会继续完成并保留成果。</p>`:running.length?`<p class="wpg-stop-note">当前 ${running.length} 份仍在收尾，完成后会更新成果；请等待收尾后再重试失败文件。</p>`:''}${needsAttention.length?`<p class="wpg-stop-note">${needsAttention.length} 份文件等待处理条件恢复或补充信息，请在下方点击“查看任务”处理。</p>`:''}${batch.error&&!shownReasons.some(([reason])=>reason===batch.error?.trim())?`<p role="status">${esc(batch.error)}</p>`:''}${failureSummary}</section>
 <div class="wpg-chapters" aria-label="各章节生成进度">${progress.chapters.map(chapter=>{const files=items.filter(i=>chapter.item_ids.includes(i.entry.id)),completed=files.filter(i=>i.state==='succeeded').length,failures=files.filter(workpaperFailed).length,inProgress=files.some(i=>active(i.state)&&!i.progress?.interrupted);
  const state=files.some(i=>active(i.state)&&i.progress?.interrupted)?'执行待恢复':inProgress?'正在生成':completed===files.length?'已完成':failures&&completed+failures===files.length?'有失败文件':terminal?'已结束':batch.state==='paused'?'等待继续':files.some(i=>i.state==='queued'&&!!i.run_id)?'排队等待':'等待生成';
  return `<section class="wpg-chapter-progress" data-progress-chapter="${esc(chapter.id)}"><div><h4>${esc(chapter.title)}</h4><p>${files.length} 份文件</p></div><progress max="${Math.max(1,files.length)}" value="${completed}" aria-label="${esc(chapter.title)}完成进度"></progress><div class="wpg-chapter-state"><strong>${completed} / ${files.length}${failures?` · ${failures} 份失败`:''}</strong><span>${state}</span></div></section>`;
 }).join('')}</div><dl class="wp-batch-meta"><div><dt>生成依据</dt><dd>${esc(batch.source.filename)} · V${batch.source.sequence}</dd></div><div><dt>提交时间</dt><dd>${date(batch.created_at)}</dd></div><div><dt>已扣积分</dt><dd>${formatPoints(batch.charged_points)} 积分</dd></div></dl>
 ${batch.billing_resume?`<p>本批继续生成需要 ${formatPoints(batch.billing_resume.required_points)} 积分，当前可用 ${formatPoints(batch.billing_resume.available_points)} 积分。已完成文件保留。</p>`:''}
 ${needsAttention.length?`<section class="wpg-attention" aria-label="需要处理的任务"><h4>需要处理的任务（${needsAttention.length}）</h4><div class="wpg-attention-links">${needsAttention.map(item=>`<div><span>${esc(item.entry.code)} ${esc(item.entry.title)}</span><a class="text-button" href="${esc('#generate?'+withProjectContext(new URLSearchParams({topic:batch.topic_id,run:item.run_id!})))}">查看任务</a>${taskRestartHtml({run_id:item.run_id!,state:item.state},{compact:true})}</div>`).join('')}</div></section>`:''}
 <section class="wpg-results"><div class="wp-actions"><h4>试生成成果</h4>${done?`<button class="btn primary" data-wp-zip="${esc(batch.batch_id)}">下载已完成文件（ZIP）</button>`:''}</div><p class="muted">${trialResults.length?'本批试生成文件可在这里查看；全部已完成文件可通过 ZIP 下载。':'试生成文件完成后可在这里查看；全部已完成文件可通过 ZIP 下载。'}</p>${trialResults.length?`<ul class="wp-items">${trialResults.map(item=>`<li data-result-item="${esc(item.entry.id)}"><div><strong>${esc(item.entry.code)} ${esc(item.entry.title)}</strong><small>试生成${item.explanation?' · '+esc(item.decision?WORKPAPER_DECISION_LABELS[item.decision.status]:'已生成说明文件'):''}</small></div><div class="wp-actions"><button class="text-button" data-wp-preview="${esc(item.entry.id)}" data-batch="${esc(batch.batch_id)}">查看</button>${item.explanation?`<button class="text-button" data-wp-explanation="${esc(item.entry.id)}" data-batch="${esc(batch.batch_id)}">下载说明</button>`:''}${item.artifacts.filter(a=>a.kind==='document').map(a=>`<button class="text-button" data-wp-art="${esc(a.pin.artifact_id)}" data-wp-batch="${esc(batch.batch_id)}">下载底稿</button>`).join('')}</div></li>`).join('')}</ul>`:''}</section></article>`;
}
