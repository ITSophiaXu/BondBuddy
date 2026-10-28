import {join} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {WorkpaperDecisionSchema,type ProjectFileText,type WorkpaperEntry} from '@bondbuddy/contracts';
import {makeWorkpaperExplanation,workpaperDocx} from '@bondbuddy/api/workpapers';
import {checkedM4File} from './m4-file-workspace.js';
import {CodexOutputValidationError} from './codex-adapter.js';
import {groundWorkpaperDecision} from './workpaper-grounding.js';

/** Classification and document drafting are outputs of the SAME authoring turn. */
export async function collectDirectWorkpaper(cwd:string,entry:WorkpaperEntry,source:ProjectFileText){
 let proposed:unknown,coverage:unknown;
 try{
  proposed=JSON.parse((await checkedM4File(join(cwd,'output'),'workpaper-result.json',1024*1024)).toString('utf8'));
  coverage=JSON.parse((await checkedM4File(join(cwd,'output'),'workpaper-coverage.json',32*1024*1024)).toString('utf8'));
 }catch(error){
  if(error instanceof SyntaxError||(error as NodeJS.ErrnoException).code==='ENOENT'||(error as Error).message==='M4_OUTPUT_UNSAFE')
   throw new CodexOutputValidationError('workpaper_result_missing_or_invalid');
  throw error;
 }
 if(!Value.Check(WorkpaperDecisionSchema,proposed)||proposed.item_id!==entry.id)throw new CodexOutputValidationError('workpaper_result_schema_invalid');
 const c=coverage as {reviewed_span_ids?:unknown[];used_span_ids?:unknown[];excluded?:{span_id:string;reason:string}[]}|null;
 if(!c||!Array.isArray(c.reviewed_span_ids)||!Array.isArray(c.used_span_ids)||!Array.isArray(c.excluded))throw new CodexOutputValidationError('workpaper_source_coverage_incomplete');
 const reviewed=new Set(c.reviewed_span_ids),used=new Set(c.used_span_ids),excluded=new Set(c.excluded.filter(x=>x&&typeof x.reason==='string'&&x.reason.trim().length>4).map(x=>x.span_id));
 if(source.spans.some(s=>s.text.trim()&&(!reviewed.has(s.id)||!used.has(s.id)&&!excluded.has(s.id))))throw new CodexOutputValidationError('workpaper_source_coverage_incomplete');
 const decision=groundWorkpaperDecision(proposed,entry,source.spans);
 if(decision.status==='generate')return {decision};
 // The host creates the explanation from the grounded decision and the designated
 // template, so a rejected applicability claim never leaves a fabricated Word file.
 return {decision,replacements:{
  'document.docx':await makeWorkpaperExplanation(entry,decision),
  'preparation-note.docx':await workpaperDocx('内部编制记录',[entry.code+' '+entry.title,decision.reason,'本项仅形成说明，不收取底稿生成积分。'])
 }};
}
