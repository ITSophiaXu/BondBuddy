import {workpaperChapters,type WorkpaperEntry} from '@bondbuddy/contracts';
import {esc} from './ui';
import './workpaper-progressive.css';

/** Keep the selected chapter order complete when individual file choices change. */
export function selectedChapterOrder(entries:WorkpaperEntry[],itemIds:string[],order:string[]=[]){
 const selected=new Set(itemIds),chapters=workpaperChapters(entries).filter(c=>c.item_ids.some(id=>selected.has(id)));
 const valid=new Set(chapters.map(c=>c.id));
 return [...new Set([...order.filter(id=>valid.has(id)),...chapters.map(c=>c.id)])];
}
type Options={entries:WorkpaperEntry[];itemIds:string[];order:string[];disabled?:boolean;filter?:string;
 change:(itemIds:string[],order:string[])=>void};
export function renderChapterSelection(host:HTMLElement,options:Options){
 const {entries,itemIds,disabled=false,filter='',change}=options,selected=new Set(itemIds);
 const chapters=workpaperChapters(entries),order=selectedChapterOrder(entries,itemIds,options.order);
 const sorted=[...chapters].sort((a,b)=>{const ai=order.indexOf(a.id),bi=order.indexOf(b.id);return (ai<0?order.length+chapters.indexOf(a):ai)-(bi<0?order.length+chapters.indexOf(b):bi);});
 const files=new Map(entries.filter(e=>e.kind==='file').map(e=>[e.id,e]));
 const active=host.contains(document.activeElement)?document.activeElement as HTMLElement:undefined;
 const focus=active?.dataset.focusKey;
 host.innerHTML=`<div class="wpg-selection-heading"><div><h3>选择章节并调整生成顺序</h3><p>已选 ${order.length} 个章节、${itemIds.length} 份文件。先试生成前 ${Math.min(8,order.length)} 个所选章节，每章 1 份；确认后自动生成其余文件。</p></div></div><div class="wpg-chapter-list" aria-label="章节选择与生成顺序">${sorted.map(chapter=>{
  const chapterFiles=chapter.item_ids.map(id=>files.get(id)!).filter(Boolean),shown=chapterFiles.filter(e=>!filter||`${chapter.title} ${e.code} ${e.title} ${e.folder}`.includes(filter));
  if(!shown.length)return '';
  const count=chapter.item_ids.filter(id=>selected.has(id)).length,index=order.indexOf(chapter.id);
  return `<section class="wpg-select-chapter ${count?'is-selected':''}" data-chapter-id="${esc(chapter.id)}"><div class="wpg-select-row"><label class="wpg-chapter-label"><input type="checkbox" data-chapter-select="${esc(chapter.id)}" data-focus-key="select-${esc(chapter.id)}" aria-label="选择章节 ${esc(chapter.title)}" ${count===chapter.item_ids.length?'checked':''} data-partial="${count>0&&count<chapter.item_ids.length}" ${disabled?'disabled':''}><span><strong>${esc(chapter.title)}</strong><small>已选 ${count} / ${chapter.item_ids.length} 份${index>=0?` · 第 ${index+1} 个生成`:''}</small></span></label><div class="wpg-order-actions" role="group" aria-label="${esc(chapter.title)}的生成顺序"><button type="button" class="btn secondary" data-chapter-move="${esc(chapter.id)}" data-direction="-1" data-focus-key="up-${esc(chapter.id)}" aria-label="上移 ${esc(chapter.title)}" ${disabled||index<=0?'disabled':''}>↑ <span>上移</span></button><button type="button" class="btn secondary" data-chapter-move="${esc(chapter.id)}" data-direction="1" data-focus-key="down-${esc(chapter.id)}" aria-label="下移 ${esc(chapter.title)}" ${disabled||index<0||index>=order.length-1?'disabled':''}>↓ <span>下移</span></button></div></div><div class="wpg-select-files" data-chapter-files="${esc(chapter.id)}">${shown.map(entry=>`<label class="wpg-file-choice"><input type="checkbox" data-chapter-item="${esc(entry.id)}" data-focus-key="item-${esc(entry.id)}" ${selected.has(entry.id)?'checked':''} ${disabled?'disabled':''}><span><strong>${esc(entry.code)} ${esc(entry.title)}</strong>${entry.instructions?`<small>${esc(entry.instructions)}</small>`:''}</span></label>`).join('')}</div></section>`;
 }).join('')||'<p class="muted">没有匹配的文件，请换一个编号或名称。</p>'}</div>`;
 host.querySelectorAll<HTMLInputElement>('[data-partial="true"]').forEach(n=>n.indeterminate=true);
 host.querySelectorAll<HTMLInputElement>('[data-chapter-select]').forEach(n=>n.onchange=()=>{
  const chapter=chapters.find(c=>c.id===n.dataset.chapterSelect)!;
  for(const id of chapter.item_ids)n.checked?selected.add(id):selected.delete(id);
  change([...selected],selectedChapterOrder(entries,[...selected],order));
 });
 host.querySelectorAll<HTMLInputElement>('[data-chapter-item]').forEach(n=>n.onchange=()=>{
  n.checked?selected.add(n.dataset.chapterItem!):selected.delete(n.dataset.chapterItem!);
  change([...selected],selectedChapterOrder(entries,[...selected],order));
 });
 host.querySelectorAll<HTMLButtonElement>('[data-chapter-move]').forEach(n=>n.onclick=()=>{
  const next=[...order],index=next.indexOf(n.dataset.chapterMove!),target=index+Number(n.dataset.direction);
  if(index<0||target<0||target>=next.length)return;
  [next[index],next[target]]=[next[target],next[index]];change([...selected],next);
 });
 if(focus)restoreChapterFocus(host,focus);
}
export function restoreChapterFocus(host:HTMLElement,key:string){
 const target=host.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`);
 if(target instanceof HTMLButtonElement&&target.disabled){target.closest('[data-chapter-id]')?.querySelector<HTMLInputElement>('[data-chapter-select]')?.focus({preventScroll:true});}
 else target?.focus({preventScroll:true});
}
