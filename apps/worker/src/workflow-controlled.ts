import {Value} from '@sinclair/typebox/value';
import {ControlledChapterOutputV1Schema,type ControlledChapterOutputV1,type AuthoringWorkflowV1} from '@bondbuddy/contracts';
export type ControlledResult=ControlledChapterOutputV1;
export function validControlled(value:unknown,w:AuthoringWorkflowV1,c:number,b:number,evidenceRefs?:ReadonlySet<string>):value is ControlledResult{
  const v=value as ControlledResult,batch=w.plan.chapters[c]?.batches[b];if(!Value.Check(ControlledChapterOutputV1Schema,v)||!batch||Buffer.byteLength(JSON.stringify(v))>32768)return false;
  if(Object.keys(v).sort().join(',')!=='edits,reviewed,summary'||new Set(v.reviewed).size!==batch.allowed_node_ids.length||v.reviewed.length!==batch.allowed_node_ids.length||v.reviewed.some(id=>!batch.allowed_node_ids.includes(id)))return false;
  return v.edits.every(e=>batch.allowed_node_ids.includes(e.node_id)&&(!('style_node_id' in e)||!e.style_node_id||batch.allowed_node_ids.includes(e.style_node_id))&&e.evidence.every(r=>(evidenceRefs?.has(r)??batch.context_refs.includes(r))||['target','requirements'].includes(r))&&(e.evidence.length>0||e.pending.length>0)&&(!('rows' in e)||e.rows.every(row=>row.length===e.rows[0]!.length)));
}
/** Only protocol data reaches the trusted editor; IDs and hashes are host-owned. */
export function controlledOperation(edit:ControlledResult['edits'][number],opId:string,node?:{scope_only?:unknown;text_sha256?:unknown}){
  const {evidence:_,pending:__,...fields}=edit;
  if(node?.scope_only){if(typeof node.text_sha256!=='string'||edit.before!==`sha256:${node.text_sha256}`)throw Error('WORD_EDIT_ANCHOR_MISMATCH');(fields as Record<string,unknown>).before={sha256:node.text_sha256};}
  if(edit.kind==='add_comment'){const {after,...rest}=fields as typeof edit;return {id:opId,...rest,text:after};}
  return {id:opId,...fields};
}
export function verifyAcceptedReceipt(receipt:any,request:any,hash:string){
  if(receipt?.version!=='word-edit-receipt-v2'||receipt.status!=='accepted'||receipt.workspace_id!==request.workspace_id||receipt.op_id!==request.op_id||receipt.batch_id!==request.batch_id||receipt.input_hash!==hash||!Number.isSafeInteger(receipt.projection_version)||receipt.projection_version!==request.projection_version+1||!/^\.operations\.json\.objects\/[a-f0-9]{64}\.json$/.test(receipt.receipt_object_path??'')||!/^[a-f0-9]{64}$/.test(receipt.receipt_sha256??''))throw Error('WORD_EDIT_RECEIPT_INVALID');
}
export function visiblePending(pending:string[]){
  const texts=[...new Set(pending.filter(p=>p.trim()))],chunks:string[]=[];let chunk='';
  for(const text of texts){
    if(text.length>4096)throw Error('WORKFLOW_PENDING_TOO_LARGE');
    for(let offset=0;offset<text.length;offset+=3800){const part=text.slice(offset,offset+3800);if(chunk.length+part.length>3900){chunks.push(chunk);chunk='';}chunk+=(chunk?'\n':'')+part;}
  }
  if(chunk)chunks.push(chunk);
  if(chunks.length>32)throw Error('WORKFLOW_PENDING_TOO_LARGE');
  return chunks.map(text=>'待人工确认：\n'+text);
}
