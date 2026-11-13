import type {WorkpaperBatch} from './billing-types';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import {formatPoints,WORKPAPER_DECISION_LABELS} from '@bondbuddy/contracts';
import {withProjectContext} from './project-navigation';
import './workpaper-progressive.css';

const active=(state:string)=>['preparing','running','validating','delivering','settlement_pending'].includes(state);
export const workpaperFailed=(item:WorkpaperBatch['items'][number])=>['failed','rejected'].includes(item.state)||item.state==='cancelled'&&!!item.run_id;
export function progressiveBatchHtml(batch:WorkpaperBatch,busy:boolean){
 const progress=batch.progressive!;const items=batch.items,done=items.filter(i=>i.state==='succeeded').length,failed=items.filter(workpaperFailed).length;
 const documents=items.filter(i=>i.state==='succeeded'&&i.artifacts.some(a=>a.kind==='document')).length,explanations=items.filter(i=>i.state==='succeeded'&&i.explanation).length;
 const trial=items.filter(i=>progress.trial_item_ids.includes(i.entry.id)),trialDone=trial.filter(i=>i.state==='succeeded').length,trialFailed=trial.filter(workpaperFailed).length;
 const remaining=items.filter(i=>!progress.trial_item_ids.includes(i.entry.id)&&i.state!=='succeeded'&&!workpaperFailed(i)).length;
 const running=items.filter(i=>active(i.state)||i.state==='queued'&&!!i.run_id),terminal=['complete','partial','cancelled'].includes(batch.state);
 const needsAttention=items.filter(i=>!!i.run_id&&['paused','awaiting_input'].includes(i.state));
 const sharedBlocked=batch.state==='paused'&&batch.pause_reason==='shared_blocked';
 const unfinished=items.length-done-failed,awaiting=progress.phase==='awaiting_confirmation'&&batch.state==='paused'&&!sharedBlocked;
 const current=progress.chapters.filter(c=>c.item_ids.some(id=>running.some(i=>i.entry.id===id))).map(c=>c.title);
 const badge=terminal?(batch.state==='cancelled'?'已停止':failed||unfinished?'部分完成':'已完成'):awaiting?'待确认':batch.state==='paused'?'已暂停':progress.phase==='trial'?'试生成中':progress.phase==='retry_failed'?'重试中':'生成中';
 const heading=terminal?(batch.state==='cancelled'?'已停止后续生成':failed||unfinished?'本次生成已结束':'全部文件已生成')
  :sharedBlocked?'生成遇到阻碍，已保留成果':awaiting?'试生成已结束，请查看成果':batch.state==='paused'?'后续生成已暂停':progress.phase==='trial'?`正在试生成 ${trial.length} 份文件`:progress.phase==='retry_failed'?'正在重试失败文件':'正在生成其余文件';
 const description=terminal?`已完成 ${done} / ${items.length} 份${failed?`，${failed} 份失败`:''}${unfinished?`，${unfinished} 份未生成`:''}。已完成文件可继续查看和下载。`
  :sharedBlocked?`已完成 ${done} 份${failed?`，${failed} 份失败`:''}。${failed?'处理阻碍后可重试受阻文件，已完成文件保留。':needsAttention.length?'请先在下方查看并处理受阻任务。':running.length?'已完成文件保留。':'受阻文件已处理，可继续本批任务。'}${running.length?`当前 ${running.length} 份仍在收尾，请等待收尾完成。`:''}`
  :awaiting?`试生成 ${trial.length} 份：${trialDone} 份完成${trialFailed?`，${trialFailed} 份失败`:''}。${remaining?`确认后将按章节顺序自动生成其余 ${remaining} 份。`:'已无待生成文件。'}`
  :batch.state==='paused'?`已完成 ${done} 份，已保存进度。${running.length?`当前 ${running.length} 份仍在收尾。`:'可继续本批任务。'}`
  :progress.phase==='trial'?`从前 ${trial.length} 个所选章节各生成 1 份。每份完成后即可查看，试生成结束后再由你确认继续。`
  :`按已选章节顺序连续生成，无需逐批确认。${current.length?`当前章节：${current.join('、')}。`:''}`;
 const action=(name:string,text:string,primary=false)=>`<button class="btn ${primary?'primary':'secondary'}" data-wp-action="${name}" data-batch="${esc(batch.batch_id)}" ${busy||(name==='retry_failed'||sharedBlocked&&name==='resume')&&(running.length||needsAttention.length)?'disabled':''}>${text}</button>`;
 let actions='';
 if(sharedBlocked){if(failed)actions=action('retry_failed','重试受阻文件并继续',true);else if(!needsAttention.length)actions=action('resume','继续本批',true);actions+=action('cancel','停止后续生成');}
 else if(awaiting){if(remaining)actions+=action('continue_remaining',`继续生成其余 ${remaining} 份`,true);if(trialFailed)actions+=action('retry_failed',`仅重试失败的 ${trialFailed} 份`);actions+=`<button class="btn secondary" data-wp-reselect="${esc(batch.batch_id)}" ${busy?'disabled':''}>结束本批并重新选择</button>`;}
 else if(['running','queued'].includes(batch.state))actions=action('pause','暂停')+action('cancel','停止');
 else if(batch.state==='paused')actions=action('resume','继续本批',true)+action('cancel','停止后续生成');
 if(terminal){if(failed)actions+=action('retry_failed',`仅重试失败的 ${failed} 份`,true);actions+=`<button class="btn secondary" data-wp-restart="${esc(batch.batch_id)}" ${busy?'disabled':''}>重新开始</button>`;}
 if(done)actions+=`<button class="btn secondary" data-wp-show-results="${esc(batch.batch_id)}">查看已完成的 ${done} 份</button>`;
 const ordered=progress.chapters.flatMap(c=>c.item_ids).map(id=>items.find(i=>i.entry.id===id)).filter((i):i is WorkpaperBatch['items'][number]=>!!i);
 const resultPriority=(item:WorkpaperBatch['items'][number])=>item.state==='succeeded'?0:workpaperFailed(item)?1:2;
 ordered.sort((a,b)=>resultPriority(a)-resultPriority(b));
 return `<article class="wp-batch wpg-batch" data-wp-batch-id="${esc(batch.batch_id)}"><section class="wpg-status"><div class="wpg-status-top"><div class="wpg-status-copy"><span class="wpg-phase">${badge}</span><h3>${heading}</h3><p>${esc(description)}</p></div><div class="wp-actions">${actions}</div></div><div class="wpg-total"><div><span>${progress.phase==='trial'&&!terminal?`试生成：${trialDone+trialFailed} / ${trial.length} 份已处理`:'总进度'}</span><strong>${done} / ${items.length} 份完成${failed?` · ${failed} 份失败`:''}</strong></div><progress max="${Math.max(1,items.length)}" value="${done}" aria-label="底稿完成进度"></progress><p class="wpg-output-counts">已生成底稿 ${documents} 份 · 说明 ${explanations} 份 · 失败 ${failed} 份</p></div>${!terminal?`<p class="wpg-stop-note">暂停或停止后不再启动新文件，当前最多 ${progress.max_parallel} 份会继续完成并保留成果。</p>`:running.length?`<p class="wpg-stop-note">当前 ${running.length} 份仍在收尾，完成后会更新成果；请等待收尾后再重试失败文件。</p>`:''}${needsAttention.length?`<p class="wpg-stop-note">${needsAttention.length} 份文件等待处理条件恢复或补充信息，请在下方点击“查看任务”处理。</p>`:''}${batch.error?`<p role="status">${esc(batch.error)}</p>`:''}</section>
 <div class="wpg-chapters" aria-label="各章节生成进度">${progress.chapters.map(chapter=>{const files=items.filter(i=>chapter.item_ids.includes(i.entry.id)),completed=files.filter(i=>i.state==='succeeded').length,failures=files.filter(workpaperFailed).length,inProgress=files.some(i=>running.includes(i));
  const state=inProgress?'正在生成':completed===files.length?'已完成':failures&&completed+failures===files.length?'有失败文件':terminal?'已结束':batch.state==='paused'?'等待继续':'等待生成';
  return `<section class="wpg-chapter-progress" data-progress-chapter="${esc(chapter.id)}"><div><h4>${esc(chapter.title)}</h4><p>${files.length} 份文件</p></div><progress max="${Math.max(1,files.length)}" value="${completed}" aria-label="${esc(chapter.title)}完成进度"></progress><div class="wpg-chapter-state"><strong>${completed} / ${files.length}${failures?` · ${failures} 份失败`:''}</strong><span>${state}</span></div></section>`;
 }).join('')}</div><dl class="wp-batch-meta"><div><dt>生成依据</dt><dd>${esc(batch.source.filename)} · V${batch.source.sequence}</dd></div><div><dt>提交时间</dt><dd>${date(batch.created_at)}</dd></div><div><dt>已扣积分</dt><dd>${formatPoints(batch.charged_points)} 积分</dd></div></dl>
 ${batch.billing_resume?`<p>本批继续生成需要 ${formatPoints(batch.billing_resume.required_points)} 积分，当前可用 ${formatPoints(batch.billing_resume.available_points)} 积分。已完成文件保留。</p>`:''}
 <section class="wpg-results"><div class="wp-actions"><h4>逐份成果与状态</h4>${done?`<button class="btn primary" data-wp-zip="${esc(batch.batch_id)}">下载已完成文件（ZIP）</button>`:''}</div><p class="muted">每份完成后即可查看或下载；试生成文件标记为“试生成”。</p><ul class="wp-items">${ordered.map(item=>{const available=item.state==='succeeded'&&(item.explanation||item.artifacts.some(a=>a.kind==='document'));return `<li data-result-item="${esc(item.entry.id)}"><div><strong>${esc(item.entry.code)} ${esc(item.entry.title)}</strong><small><span class="wpg-item-state" data-state="${esc(item.state)}">${esc(item.state==='queued'&&!item.run_id?'尚未开始':runStateLabel[item.state as keyof typeof runStateLabel]??item.state)}</span>${progress.trial_item_ids.includes(item.entry.id)?'试生成 · ':''}${item.explanation?esc(item.decision?WORKPAPER_DECISION_LABELS[item.decision.status]:'已生成说明文件'):''}${item.error?esc(item.error):''}</small></div><div class="wp-actions">${available?`<button class="text-button" data-wp-preview="${esc(item.entry.id)}" data-batch="${esc(batch.batch_id)}">查看</button>`:''}${item.explanation?`<button class="text-button" data-wp-explanation="${esc(item.entry.id)}" data-batch="${esc(batch.batch_id)}">下载说明</button>`:''}${item.artifacts.filter(a=>a.kind==='document').map(a=>`<button class="text-button" data-wp-art="${esc(a.pin.artifact_id)}" data-wp-batch="${esc(batch.batch_id)}">下载底稿</button>`).join('')}${item.run_id&&['paused','awaiting_input'].includes(item.state)?`<a class="text-button" href="${esc('#generate?'+withProjectContext(new URLSearchParams({topic:batch.topic_id,run:item.run_id})))}">查看任务</a>`:''}</div></li>`;}).join('')}</ul></section></article>`;
}
