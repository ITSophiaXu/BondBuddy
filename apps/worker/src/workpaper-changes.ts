import type {ProjectFileText,ProjectFileLink,WorkpaperImpact,WorkpaperChange,WorkpaperDecision} from '@bondbuddy/contracts';
export type SourceDiff={before_ids:string[];after_ids:string[];before:string;after:string;location:string}[];
/** A source edit is an update candidate, never an invented replacement or a
 * statement that legal/procedural evidence has been independently verified. */
export function workpaperImpact(item:{id:string;links:ProjectFileLink[];decision?:WorkpaperDecision;explanation:boolean;available:boolean},baseline:ProjectFileText,current:ProjectFileText,diff:SourceDiff):WorkpaperImpact{
  if(!item.available)return {item_id:item.id,status:'manual',changes:[],reason:'该底稿尚未成功生成，需要先完成文件。'};
  const dependencies=new Set([...item.links.map(l=>l.source_span_id),...(item.explanation?item.decision?.citations.map(c=>c.span_id)??[]:[])]);
  const changes:WorkpaperChange[]=diff.filter(d=>d.before_ids.some(id=>dependencies.has(id))).map(d=>{
    const links=item.links.filter(l=>d.before_ids.includes(l.source_span_id));
    return {source_span_id:d.before_ids.join(','),before:d.before,after:d.after,source_location:d.location,
      target_locations:[...new Set(links.map(l=>l.target_location))],fields:[...new Set(links.map(l=>[l.field,l.period,l.unit].filter(Boolean).join(' · ')).filter(Boolean))],
      reason:item.explanation?'原适用性判断涉及的披露已改变，需重新判断。':'该底稿关联的披露已改变，需核对并更新对应内容。'};
  });
  const partial=baseline.coverage==='partial'||current.coverage==='partial';
  const unlinked=diff.some(d=>!d.before_ids.length||!d.before_ids.some(id=>dependencies.has(id)));
  return {item_id:item.id,status:changes.length?'needs_update':partial||!dependencies.size||unlinked?'manual':'current',changes,
    reason:changes.length?'已定位到本底稿关联内容的变更。'+(partial||unlinked?'其他新增、未关联或未读取内容仍需核对。':''):
      partial?'存在未完整读取的内容，不能确认没有影响。':!dependencies.size?'该文件缺少可核验的内容关联，需重新核对全文。':unlinked?'募集书存在新增或尚未关联到本底稿的变更，需核对是否新增核查事项。':'本次未发现已关联披露的变更。'};
}
