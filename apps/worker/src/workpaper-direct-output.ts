import {join} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {WorkpaperDecisionSchema,type ProjectFileText,type WorkpaperEntry} from '@bondbuddy/contracts';
import {makeWorkpaperExplanation,workpaperDocx} from '@bondbuddy/api/workpapers';
import {checkedM4File} from './m4-file-workspace.js';
import {CodexOutputValidationError} from './codex-adapter.js';
import {groundWorkpaperDecision} from './workpaper-grounding.js';

/** Classification and document drafting are outputs of the SAME authoring turn. */
export async function collectDirectWorkpaper(cwd:string,entry:WorkpaperEntry,source:ProjectFileText){
 const invalid=(code:string,file:string,field?:string,rule?:string)=>new CodexOutputValidationError(code,{code,file,field,rule});
 const readJson=async(file:string,max:number)=>{
  let bytes:Buffer;
  try{bytes=await checkedM4File(join(cwd,'output'),file,max);}
  catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')throw invalid('workpaper_file_missing',file);
   if((error as Error).message==='M4_OUTPUT_UNSAFE')throw invalid('workpaper_file_unsafe',file);
   throw error;
  }
  try{return JSON.parse(bytes.toString('utf8')) as unknown;}
  catch{throw invalid('workpaper_json_invalid',file);}
 };
 const proposed=await readJson('workpaper-result.json',1024*1024);
 const coverage=await readJson('workpaper-coverage.json',32*1024*1024);
 if(!Value.Check(WorkpaperDecisionSchema,proposed)){
  // Retain schema paths, never the rejected value or TypeBox's error message.
  const path=Value.Errors(WorkpaperDecisionSchema,proposed).First()?.path;
  const field=path&&path.split('/').slice(1).every(p=>/^[0-9]+$/.test(p)||['item_id','status','reason','citations','span_id','quote','missing_materials'].includes(p))?path:'/';
  throw invalid('workpaper_result_schema_invalid','workpaper-result.json',field,'WorkpaperDecisionSchema');
 }
 if(proposed.item_id!==entry.id)throw invalid('workpaper_item_mismatch','workpaper-result.json','/item_id','expected_item_id');
 const c=coverage as {reviewed_span_ids?:unknown[];used_span_ids?:unknown[];excluded?:{span_id:string;reason:string}[]}|null;
 for(const field of ['reviewed_span_ids','used_span_ids','excluded'] as const)
  if(!c||!Array.isArray(c[field]))throw invalid('workpaper_source_coverage_incomplete','workpaper-coverage.json','/'+field,'array_required');
 if(!c)throw invalid('workpaper_source_coverage_incomplete','workpaper-coverage.json');
 const reviewed=new Set(c.reviewed_span_ids!),used=new Set(c.used_span_ids!),excluded=new Set(c.excluded!.filter(x=>x&&typeof x.reason==='string'&&x.reason.trim().length>4).map(x=>x.span_id));
 if(source.spans.some(s=>s.text.trim()&&(!reviewed.has(s.id)||!used.has(s.id)&&!excluded.has(s.id))))throw invalid('workpaper_source_coverage_incomplete','workpaper-coverage.json','/reviewed_span_ids','all_nonempty_source_spans');
 const decision=groundWorkpaperDecision(proposed,entry,source.spans);
 if(decision.status==='generate')return {decision};
 // The host creates the explanation from the grounded decision and the designated
 // template, so a rejected applicability claim never leaves a fabricated Word file.
 return {decision,replacements:{
  'document.docx':await makeWorkpaperExplanation(entry,decision),
  'preparation-note.docx':await workpaperDocx('内部编制记录',[entry.code+' '+entry.title,decision.reason,'本项仅形成说明，不收取底稿生成积分。'])
 }};
}
