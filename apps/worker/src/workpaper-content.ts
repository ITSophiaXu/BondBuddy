import type {ProjectFileText,ProjectFileLink} from '@bondbuddy/contracts';
/** Host checks catch empty files, partial table adoption and missing evidence.
 * Semantic relevance still requires professional review; a model's coverage
 * declaration is never presented as an independent audit. */
export function validateWorkpaperCoverage(source:ProjectFileText,target:ProjectFileText,links:ProjectFileLink[],proposal:unknown){
  const p=proposal as {reviewed_span_ids?:unknown[];used_span_ids?:unknown[];excluded?:{span_id:string;reason:string}[]}|null;
  if(!p||!Array.isArray(p.reviewed_span_ids)||!Array.isArray(p.used_span_ids)||!Array.isArray(p.excluded))throw Error('WORKPAPER_COVERAGE_REQUIRED');
  const relevant=new Set(p.used_span_ids),reviewed=new Set(p.reviewed_span_ids),excluded=new Map(p.excluded.filter(x=>x&&typeof x.reason==='string'&&x.reason.trim().length>4).map(x=>[x.span_id,x.reason]));
  const nonempty=source.spans.filter(s=>s.text.trim()),ids=new Set(nonempty.map(s=>s.id));
  if(!relevant.size||[...relevant].some(id=>!ids.has(String(id))||excluded.has(String(id)))||nonempty.some(s=>!reviewed.has(s.id)||!relevant.has(s.id)&&!excluded.has(s.id)))throw Error('WORKPAPER_SOURCE_COVERAGE_INCOMPLETE');
  const linked=new Set(links.map(l=>l.source_span_id));
  if([...relevant].some(id=>!linked.has(String(id))))throw Error('WORKPAPER_CONTENT_LINKS_MISSING');
  // Once a table is used, every nonempty cell must be accounted for. The author
  // can split wide tables, but cannot take only the first few rows.
  const tables=new Set(nonempty.filter(s=>relevant.has(s.id)&&s.location.includes(' / 行 ')).map(s=>s.location.split(' / 行 ')[0]));
  if(nonempty.some(s=>tables.has(s.location.split(' / 行 ')[0])&&!relevant.has(s.id)))throw Error('WORKPAPER_TABLE_INCOMPLETE');
  const targets=new Map(target.spans.map(s=>[s.id,s])),sources=new Map(nonempty.map(s=>[s.id,s]));
  for(const table of tables){
    const cells=new Set(nonempty.filter(s=>s.location.split(' / 行 ')[0]===table).map(s=>s.location)),linkedCells=new Set<string>(),outputCells=new Set<string>();
    for(const link of links){
      const from=sources.get(link.source_span_id),to=targets.get(link.target_span_id);
      if(from?.location.split(' / 行 ')[0]===table&&to?.location.includes(' / 行 ')){
        linkedCells.add(from.location);outputCells.add(to.location);
      }
    }
    // A paragraph summary or many links pointing at the same filled cell cannot
    // stand in for the complete table. Split tables and repeated key columns work.
    if([...cells].some(c=>!linkedCells.has(c))||outputCells.size<cells.size)throw Error('WORKPAPER_TABLE_OUTPUT_INCOMPLETE');
  }
  const body=target.spans.map(s=>s.text).join('\n');
  if(body.trim().length<80||/\[\[内容\d*\]\]|待补充|待填写|(?:^|\n)\s*(?:来源|依据)[：:]|披露依据及数据|目录原名|\b[PT]\d{3,}\b/.test(body))throw Error('WORKPAPER_EMPTY_OR_INTERNAL_CONTENT');
  return {reviewed:reviewed.size,used:relevant.size,excluded:excluded.size,source_coverage:source.coverage};
}
