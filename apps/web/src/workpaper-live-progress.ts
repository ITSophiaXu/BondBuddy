import {WORKPAPER_PROGRESS_LABELS,type WorkpaperItem} from '@bondbuddy/contracts';
import {esc,date} from './ui.js';

/** An event reports work, not a completed document. Never estimate a percentage. */
export function workpaperLiveProgressHtml(items:WorkpaperItem[]):string{
 if(!items.length)return '';
 return `<div class="wpg-live-progress" role="status" aria-live="polite" aria-label="当前处理进度">${items.map(item=>{
  const progress=item.progress;
  const label=progress?.interrupted?'执行暂时中断，等待恢复':progress?WORKPAPER_PROGRESS_LABELS[progress.phase]:item.state==='queued'?'排队等待':'正在处理文件';
  return `<div class="wpg-live-item${progress?.interrupted?' is-interrupted':''}" data-live-item="${esc(item.entry.id)}"><strong>${esc(item.entry.code)} ${esc(item.entry.title)}</strong><span>${esc(label)}</span>${progress?`<small>最近进展：${esc(date(progress.updated_at))}</small>`:''}${progress?.interrupted?'<small>已完成成果保留，无需重复提交。</small>':''}</div>`;
 }).join('')}</div>`;
}
