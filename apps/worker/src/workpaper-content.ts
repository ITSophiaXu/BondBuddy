import type {ProjectFileText,ProjectFileLink} from '@bondbuddy/contracts';
import type {CodexCollectionDiagnosticDetails} from './codex-adapter.js';
export class WorkpaperCoverageError extends Error {
  constructor(code:string,readonly missingSourceSpanIds:string[],readonly diagnostics:CodexCollectionDiagnosticDetails[]=[]){super(code);}
}
/** Host checks catch empty files, partial table adoption and missing evidence.
 * Report independent blockers together so the one repair turn can fix the final
 * document and its metadata. Every original gate remains mandatory.
 * Semantic relevance still requires professional review; a declaration is not an audit. */
export function validateWorkpaperCoverage(source:ProjectFileText,target:ProjectFileText,links:ProjectFileLink[],proposal:unknown){
  const p=proposal as {reviewed_span_ids?:unknown[];used_span_ids?:unknown[];excluded?:{span_id:string;reason:string}[]}|null;
  if(!p||!Array.isArray(p.reviewed_span_ids)||!Array.isArray(p.used_span_ids)||!Array.isArray(p.excluded))throw Error('WORKPAPER_COVERAGE_REQUIRED');
  const relevant=new Set(p.used_span_ids),reviewed=new Set(p.reviewed_span_ids),excluded=new Map(p.excluded.filter(x=>x&&typeof x.reason==='string'&&x.reason.trim().length>4).map(x=>[x.span_id,x.reason]));
  const nonempty=source.spans.filter(s=>s.text.trim()),ids=new Set(nonempty.map(s=>s.id)),problems:CodexCollectionDiagnosticDetails[]=[];
  const issue=(code:string,file:string,field:string,rule:string,sourceIds:string[]=[])=>{
    const unique=[...new Set(sourceIds)];problems.push({code,file,field,rule,...(unique.length?{source_span_ids:unique.slice(0,32),source_span_count:unique.length}:{})});
  };
  const unread=nonempty.filter(s=>!reviewed.has(s.id)||!relevant.has(s.id)&&!excluded.has(s.id)).map(s=>s.id);
  if(!relevant.size||[...relevant].some(id=>!ids.has(String(id))||excluded.has(String(id)))||unread.length)
    issue('WORKPAPER_SOURCE_COVERAGE_INCOMPLETE','workpaper-coverage.json','/reviewed_span_ids','full_nonempty_source_partition',unread);
  const linked=new Set(links.map(l=>l.source_span_id));
  const missingLinks=nonempty.filter(s=>relevant.has(s.id)&&!linked.has(s.id)).map(s=>s.id);
  if(missingLinks.length)issue('WORKPAPER_CONTENT_LINKS_MISSING','file-links.json','/links','each_used_source_requires_verified_link',missingLinks);
  const tables=new Set(nonempty.filter(s=>relevant.has(s.id)&&s.location.includes(' / 行 ')).map(s=>s.location.split(' / 行 ')[0]));
  const missingTableUse=nonempty.filter(s=>tables.has(s.location.split(' / 行 ')[0])&&!relevant.has(s.id)).map(s=>s.id);
  if(missingTableUse.length)issue('WORKPAPER_TABLE_INCOMPLETE','workpaper-coverage.json','/used_span_ids','all_nonempty_cells_of_each_used_table',missingTableUse);
  const targets=new Map(target.spans.map(s=>[s.id,s])),sources=new Map(nonempty.map(s=>[s.id,s])),missingOutput:string[]=[];
  for(const table of tables){
    const spans=nonempty.filter(s=>s.location.split(' / 行 ')[0]===table),cells=new Set(spans.map(s=>s.location)),linkedCells=new Set<string>(),outputCells=new Set<string>();
    for(const link of links){
      const from=sources.get(link.source_span_id),to=targets.get(link.target_span_id);
      if(from?.location.split(' / 行 ')[0]===table&&to?.location.includes(' / 行 ')){
        linkedCells.add(from.location);outputCells.add(to.location);
      }
    }
    const absent=spans.filter(s=>!linkedCells.has(s.location));
    if(absent.length)missingOutput.push(...absent.map(s=>s.id));
    else if(outputCells.size<cells.size)missingOutput.push(...spans.map(s=>s.id));
  }
  if(missingOutput.length)issue('WORKPAPER_TABLE_OUTPUT_INCOMPLETE','file-links.json','/links','complete_source_table_to_distinct_target_cells',missingOutput);
  const body=target.spans.map(s=>s.text).join('\n');
  if(body.trim().length<80||/\[\[内容\d*\]\]|待补充|待填写|(?:^|\n)\s*(?:来源|依据)[：:]|披露依据及数据|目录原名|\b[PT]\d{3,}\b/.test(body))
    issue('WORKPAPER_EMPTY_OR_INTERNAL_CONTENT','document.docx','/body','business_content_only');
  if(problems.length){const first=problems[0]!;throw new WorkpaperCoverageError(first.code,first.source_span_ids??[],problems);}
  return {reviewed:reviewed.size,used:relevant.size,excluded:excluded.size,source_coverage:source.coverage};
}
