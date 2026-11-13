import {Type,type Static} from '@sinclair/typebox';
import {WORKPAPER_LIMITS,type WorkpaperEntry} from './workpaper-entry.js';

export const WORKPAPER_TRIAL_CHAPTERS=8;
export const WORKPAPER_MAX_PARALLEL=2;
export const WorkpaperProgressiveRequestSchema=Type.Object({
  chapter_order:Type.Array(Type.String({minLength:1,maxLength:128}),{minItems:1,maxItems:WORKPAPER_LIMITS.items,uniqueItems:true}),
},{additionalProperties:false});
export type WorkpaperProgressiveRequest=Static<typeof WorkpaperProgressiveRequestSchema>;
export type WorkpaperChapter={id:string;title:string;item_ids:string[]};
export type WorkpaperProgressive={
  phase:'trial'|'awaiting_confirmation'|'remaining'|'retry_failed';
  chapters:WorkpaperChapter[];
  trial_item_ids:string[];
  max_parallel:typeof WORKPAPER_MAX_PARALLEL;
};

const parts=(entry:WorkpaperEntry)=>entry.folder.split(/[\\/]+/).map(s=>s.trim()).filter(Boolean);
const numberParts=(entry:WorkpaperEntry)=>entry.code.trim().match(/^\d+(?:[.．\-、]\d+)*$/)?.[0].split(/[.．\-、]/);

/** Derive chapter names from the immutable catalogue, never from a fixed template
 * or the selected subset. Shared wrapper folders are removed only to expose the
 * first real branching level. Flat numbered catalogues retain their own numbers;
 * a catalogue with no chapter information honestly remains a single group. */
export function workpaperChapters(entries:readonly WorkpaperEntry[]):WorkpaperChapter[]{
  const files=entries.filter(e=>e.kind==='file');
  const sheets=new Map<string,WorkpaperEntry[]>();
  for(const entry of files){const group=sheets.get(entry.sheet)??[];group.push(entry);sheets.set(entry.sheet,group);}
  const metadata=new Map<string,{depth:number;branching:boolean;numbered:boolean}>();
  for(const [sheet,items] of sheets){
    const paths=items.map(parts);let depth=0;
    while(paths[0]?.[depth]&&paths.every(p=>p[depth]===paths[0]![depth]))depth++;
    const branching=new Set(paths.map(p=>p.join('/'))).size>1;
    const numbered=items.every(e=>numberParts(e));
    metadata.set(sheet,{depth,branching,numbered});
  }
  const groups=new Map<string,WorkpaperChapter>();
  for(const entry of files){
    const meta=metadata.get(entry.sheet)!,path=parts(entry);let key:string,title:string;
    if(meta.branching&&path[meta.depth]){
      const chapterPath=path.slice(0,meta.depth+1);
      key=JSON.stringify([entry.sheet,'folder',chapterPath]);title=chapterPath.at(-1)!;
    }else if(!meta.branching&&meta.numbered){
      const prefix=numberParts(entry)![0]!;
      const heading=entries.find(e=>e.sheet===entry.sheet&&(e.code===prefix||new RegExp(`^${prefix}[.．\\-、]0$`).test(e.code)));
      key=JSON.stringify([entry.sheet,'number',prefix]);
      title=heading?[heading.code,heading.title].filter(Boolean).join(' '):`第 ${prefix} 章`;
    }else{
      key=JSON.stringify([entry.sheet,'folder',path]);title=path.at(-1)||entry.sheet||'底稿文件';
    }
    let chapter=groups.get(key);
    if(!chapter){
      chapter={id:`chapter-${groups.size+1}`,title:sheets.size>1?`${entry.sheet} · ${title}`:title,item_ids:[]};
      groups.set(key,chapter);
    }
    chapter.item_ids.push(entry.id);
  }
  return [...groups.values()];
}

/** Validate an exact chapter permutation and return the persisted schedule.
 * Trial items lead the schedule; the remainder retains chapter/catalogue order. */
export function workpaperProgressiveSelection(entries:readonly WorkpaperEntry[],itemIds:readonly string[],order:readonly string[]){
  const selected=new Set(itemIds),files=entries.filter(e=>e.kind==='file');
  if(!selected.size||selected.size!==itemIds.length||itemIds.some(id=>!files.some(e=>e.id===id)))
    throw new Error('WORKPAPER_PROGRESSIVE_SELECTION_INVALID');
  const available=workpaperChapters(entries).map(c=>({...c,item_ids:c.item_ids.filter(id=>selected.has(id))})).filter(c=>c.item_ids.length);
  if(order.length!==available.length||new Set(order).size!==order.length||order.some(id=>!available.some(c=>c.id===id)))
    throw new Error('WORKPAPER_PROGRESSIVE_CHAPTER_ORDER_INVALID');
  const chapters=order.map(id=>available.find(c=>c.id===id)!);
  const trial_item_ids=chapters.slice(0,WORKPAPER_TRIAL_CHAPTERS).map(c=>c.item_ids[0]!);
  const trial=new Set(trial_item_ids);
  const ordered_item_ids=[...trial_item_ids,...chapters.flatMap(c=>c.item_ids).filter(id=>!trial.has(id))];
  return {chapters,trial_item_ids,ordered_item_ids};
}
