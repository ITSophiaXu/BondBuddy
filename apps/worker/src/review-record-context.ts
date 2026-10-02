import { canonical, evidenceKey, reviewContentHash, type TrustedReviewRecord } from '../../../packages/domain/dist/review-evidence.js';
import type { ReviewAnalysisRecord } from './review-model-stage.js';

export const reviewPromptRecordId = (record:Parameters<typeof evidenceKey>[0]):string => `R-${reviewContentHash(evidenceKey(record)).slice(0,32)}`;
export function promptReviewRecord(record:ReviewAnalysisRecord){
  return {id:reviewPromptRecordId(record),source_kind:record.source_kind,material_id:record.material_id,material_version:record.material_version,
    locator_type:record.locator_type,locator:record.locator,literal_quote:record.literal_quote,context:record.context??'',
    uncertainty:record.uncertainty,extraction_method:record.extraction_method,
    ...(record.locator_type==='xlsx_cell'?{sheet_state:record.formatting?.sheet_state??'unknown'}:{})};
}
const snapshotKey=(r:TrustedReviewRecord)=>canonical([r.owner_user_id,r.project_id,r.material_id,r.material_version,r.material_sha256,r.parse_snapshot_id,r.parse_response_sha256]);
export const sameReviewSnapshot=(left:TrustedReviewRecord,right:TrustedReviewRecord)=>snapshotKey(left)===snapshotKey(right);
type TableScope={key:string;locator_type:string;locator_scope:Record<string,unknown>;row:number};
/** Structural membership only. Sheet names, positions and table prefixes are not semantic proof. */
export function reviewTableScope(record:TrustedReviewRecord):TableScope|null {
  let scope:Record<string,unknown>,row:number;
  if(record.locator_type==='xlsx_cell'){
    const cell=/^([A-Z]{1,3})([1-9]\d*)$/.exec(String(record.locator.cell));
    if(!cell||typeof record.locator.sheet!=='string')return null;
    row=Number(cell[2]);scope={sheet:record.locator.sheet};
  }else if(record.locator_type==='csv_cell'){
    if(!Number.isInteger(record.locator.row)||!Number.isInteger(record.locator.column))return null;
    row=Number(record.locator.row);scope={table:'csv'};
  }else if(record.locator_type==='docx_block'){
    const path=record.locator.path;if(!Array.isArray(path))return null;
    const last=path.flatMap((p,i)=>p&&typeof p==='object'&&typeof p.table==='number'?[i]:[]).at(-1)??-1;
    if(last<0)return null;
    const position=path.slice(last).find(p=>typeof p?.row==='number');
    if(!position||!Number.isInteger(position.row))return null;
    row=position.row;scope={path:[...path.slice(0,last),{table:path[last].table}]};
  }else return null;
  return {key:canonical([snapshotKey(record),record.locator_type,scope]),locator_type:record.locator_type,locator_scope:scope,row};
}
export interface ReviewContextGroup {
  group_id:string; locator_type:string; locator_scope:Record<string,unknown>;
  main_record_ids:string[]; context_record_ids:string[];
  selection:'structural_candidates_only'; omitted_record_count:number;
}
export interface ReviewContextGap {group_id:string;targets:ReviewAnalysisRecord[];omitted_record_count:number}
export interface ReviewBatchContext {records:ReviewAnalysisRecord[];groups:ReviewContextGroup[];gaps:ReviewContextGap[]}

/**
 * Index once per run. A table gets its own first 12 occupied rows, complete primary rows, and
 * up to 12 preceding same-table records. No workbook-global or foreign-table preamble is borrowed.
 * Original records/uncertainty are retained; a missing semantic header is never synthesized.
 */
export function createReviewContextSelector(records:readonly ReviewAnalysisRecord[]){
  const tables=new Map<string,{scope:TableScope;records:ReviewAnalysisRecord[];rows:Map<number,ReviewAnalysisRecord[]>}>();
  const prose=new Map<string,ReviewAnalysisRecord[]>();
  for(const record of records){
    const scope=reviewTableScope(record);
    if(scope){
      const group=tables.get(scope.key)??{scope,records:[],rows:new Map<number,ReviewAnalysisRecord[]>()};
      group.records.push(record);const row=group.rows.get(scope.row)??[];row.push(record);group.rows.set(scope.row,row);tables.set(scope.key,group);
    }else{
      const key=canonical([snapshotKey(record),record.locator_type]);const group=prose.get(key)??[];group.push(record);prose.set(key,group);
    }
  }
  return (primary:readonly ReviewAnalysisRecord[],options:{maxBytes?:number;maxRecords?:number}={}):ReviewBatchContext=>{
    const maxBytes=options.maxBytes??64000,maxRecords=options.maxRecords??240;
    const primaryIds=new Set(primary.map(reviewPromptRecordId));const selected=new Map<string,ReviewAnalysisRecord>();let bytes=0;
    const requested=new Map<string,{scope:Omit<TableScope,'row'>;primary:ReviewAnalysisRecord[];candidates:ReviewAnalysisRecord[]}>();
    for(const record of primary){
      const table=reviewTableScope(record);const key=table?.key??canonical([snapshotKey(record),record.locator_type]);
      const group=requested.get(key)??{scope:table??{key,locator_type:record.locator_type,locator_scope:{kind:'same_snapshot_prose'}},primary:[],candidates:[]};
      group.primary.push(record);requested.set(key,group);
    }
    for(const [key,group] of requested){
      const table=tables.get(key);
      if(table){
        // Complete rows matter when a batch boundary falls between a label and its value.
        const mainRows=new Set(group.primary.map(r=>reviewTableScope(r)!.row));
        const prefixRows=[...table.rows.keys()].sort((a,b)=>a-b).slice(0,12);
        const first=table.records.findIndex(r=>primaryIds.has(reviewPromptRecordId(r)));
        group.candidates=[...prefixRows.flatMap(row=>table.rows.get(row)!),...Array.from(mainRows).flatMap(row=>table.rows.get(row)!),
          ...table.records.slice(Math.max(0,first-12),first)];
      }else{
        const available=prose.get(key)??[];const first=available.findIndex(r=>primaryIds.has(reviewPromptRecordId(r)));
        group.candidates=[...available.slice(0,12),...available.slice(Math.max(0,first-12),first)];
      }
    }
    const groups:ReviewContextGroup[]=[],gaps:ReviewContextGap[]=[];
    for(const [key,group] of requested){
      const groupId=`G-${reviewContentHash(key).slice(0,24)}`;const contextIds:string[]=[];let omitted=0;
      const candidates=new Map(group.candidates.filter(r=>!primaryIds.has(reviewPromptRecordId(r))).map(r=>[reviewPromptRecordId(r),r]));
      for(const [id,record] of candidates){
        const count=Buffer.byteLength(JSON.stringify(promptReviewRecord(record)));
        if(selected.size>=maxRecords||bytes+count>maxBytes){omitted++;continue;}
        selected.set(id,record);contextIds.push(id);bytes+=count;
      }
      groups.push({group_id:groupId,locator_type:group.scope.locator_type,locator_scope:group.scope.locator_scope,
        main_record_ids:group.primary.map(reviewPromptRecordId),context_record_ids:contextIds,
        selection:'structural_candidates_only',omitted_record_count:omitted});
      if(omitted)gaps.push({group_id:groupId,targets:group.primary,omitted_record_count:omitted});
    }
    return {records:[...selected.values()],groups,gaps};
  };
}
