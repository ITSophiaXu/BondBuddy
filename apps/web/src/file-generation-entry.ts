import type {M4DocumentType} from './billing-types.js';

export type FileGenerationEntry='documents'|'workpapers';
export const generationRoute=(entry:FileGenerationEntry)=>entry==='workpapers'?'workpapers':'generate';

/** Keep bookmarked workpaper tasks, batches and source-selection links on their own entry. */
export function generationEntry(hash:string):FileGenerationEntry{
 const [path,search='']=hash.replace(/^#/,'').split('?'),query=new URLSearchParams(search);
 return path==='workpapers'||path==='generate'&&!query.has('topic')&&(
  query.get('step')==='workpapers'||query.get('mode')==='workpapers'||query.has('workpaper_batch')||
  ['workpaper_assessment','workpaper_check'].includes(query.get('operation')??'')
 )?'workpapers':'documents';
}

export function generationDocumentTypes(types:M4DocumentType[],entry:FileGenerationEntry,saved:M4DocumentType[]=[]):M4DocumentType[]{
 if(entry==='workpapers')return ['workpaper'];
 const documents=types.filter(type=>type!=='workpaper');
 return documents.length||!types.includes('workpaper')?documents:saved.filter(type=>type!=='workpaper');
}
