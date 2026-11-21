import {Value} from '@sinclair/typebox/value';
import {AuthoringPlanV1Schema,DocumentProjectionV1Schema,type AuthoringPlanV1,type DocumentProjectionV1} from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';

export const WORKFLOW_LIMITS={call_ms:1200000,repair_ms:300000,repair_revisions:2,context_records:600,context_chars:18000,context_bytes:96000,output_bytes:98304} as const;
export type ChapterSource={title:string;source_node_ids:string[]};
export type WorkflowNode={node_id:string;text:string;kind:string;scope_only?:boolean;text_sha256?:string;[key:string]:unknown};
export function buildAuthoringPlan(input:{inputHash:string;baselineHash:string|null;materialSnapshotHash:string;knowledgeHash:string;chapters:ChapterSource[];contextRefs:string[];nodes?:WorkflowNode[]}):AuthoringPlanV1 {
  const nodes=new Map(input.nodes?.map(n=>[n.node_id,n]));
  const assigned=new Set<string>();
  const chapters=input.chapters.map((chapter,c)=>{
    const groups:string[][]=[];let group:string[]=[],chars=0,bytes=2;
    for(const id of chapter.source_node_ids){
      if(assigned.has(id))throw Error('CHAPTER_SCOPE_CONFLICT');assigned.add(id);
      const node=nodes.get(id);if(!node&&input.nodes)throw Error('CHAPTER_SCOPE_INVALID');
      const nChars=node?.text.length??0,nBytes=Buffer.byteLength(JSON.stringify(node??id));
      if(nChars>WORKFLOW_LIMITS.context_chars||nBytes>WORKFLOW_LIMITS.context_bytes)throw Error('CHAPTER_NODE_TOO_LARGE');
      if(group.length&&(group.length>=12||chars+nChars>WORKFLOW_LIMITS.context_chars||bytes+nBytes>WORKFLOW_LIMITS.context_bytes)){groups.push(group);group=[];chars=0;bytes=2;}
      group.push(id);chars+=nChars;bytes+=nBytes;
    }
    if(group.length)groups.push(group);if(!groups.length)groups.push([]);
    return {chapter_id:`chapter-${c}`,order:c,title:chapter.title,required:true,depends_on:c?[`chapter-${c-1}`]:[],source_node_ids:chapter.source_node_ids,evidence_refs:input.contextRefs,
      batches:groups.map((allowed,b)=>({batch_id:`batch-${b}`,order:b,allowed_node_ids:allowed,context_refs:input.contextRefs,output_contract:input.baselineHash?'controlled-operations-v1' as const:'document-projection-v1' as const}))};
  });
  const content={version:'authoring-plan-v1' as const,input_hash:input.inputHash,baseline_hash:input.baselineHash,material_snapshot_hash:input.materialSnapshotHash,knowledge_hash:input.knowledgeHash,chapters,limits:{...WORKFLOW_LIMITS}};
  const plan={...content,plan_hash:inputManifestHash(content)};
  if(!Value.Check(AuthoringPlanV1Schema,plan))throw Error('AUTHORING_PLAN_INVALID');
  if(input.nodes&&assigned.size!==input.nodes.length)throw Error('CHAPTER_COVERAGE_INCOMPLETE');
  return plan;
}
export function verifyPlan(plan:AuthoringPlanV1){
  const {plan_hash,...content}=plan;
  if(!Value.Check(AuthoringPlanV1Schema,plan)||inputManifestHash(content)!==plan_hash)throw Error('AUTHORING_PLAN_INVALID');
  const ids=new Set<string>();
  for(const [i,c] of plan.chapters.entries()){
    if(c.order!==i||ids.has(c.chapter_id)||c.depends_on.some(d=>!ids.has(d)))throw Error('AUTHORING_PLAN_DEPENDENCY');ids.add(c.chapter_id);
    if(new Set(c.source_node_ids).size!==c.source_node_ids.length||c.batches.some((b,j)=>b.order!==j||b.allowed_node_ids.some(n=>!c.source_node_ids.includes(n))))throw Error('CHAPTER_SCOPE_INVALID');
  }
}
export function logicalChapterCall(runId:string,plan:AuthoringPlanV1,chapter:number,batch:number,revision:number){
  const c=plan.chapters[chapter],b=c?.batches[batch];if(!b)throw Error('CHAPTER_CURSOR_INVALID');
  return inputManifestHash([runId,plan.plan_hash,c!.chapter_id,b.batch_id,revision]);
}
export function callDeadline(runDeadline:string,callMs:number,now=Date.now()){
  const remaining=Date.parse(runDeadline)-now;if(!Number.isFinite(remaining)||remaining<=0)throw Error('WORKFLOW_RUN_DEADLINE');
  return Math.min(callMs,remaining);
}
export function repairCallDeadline(runDeadline:string,callMs:number,repairMs:number,usedMs:number,batchDeadline:string,now=Date.now()){
  const remaining=repairMs-usedMs;
  if(!Number.isSafeInteger(remaining)||remaining<=0)throw Error('WORKFLOW_REPAIR_BUDGET_EXHAUSTED');
  return Math.min(callDeadline(runDeadline,callMs,now),callDeadline(batchDeadline,remaining,now));
}
export function blockIdentity(planHash:string,chapterId:string,batchId:string,order:number){return inputManifestHash([planHash,chapterId,batchId,order]);}
export function validateProjection(value:unknown,plan:AuthoringPlanV1,chapter:number,batch:number,evidenceRefs?:ReadonlySet<string>):asserts value is DocumentProjectionV1{
  if(!Value.Check(DocumentProjectionV1Schema,value))throw Error('CHAPTER_PROJECTION_INVALID');
  const p=value as DocumentProjectionV1,c=plan.chapters[chapter],b=c?.batches[batch];
  if(!c||!b||p.input_hash!==plan.input_hash||p.plan_hash!==plan.plan_hash||p.chapter_id!==c.chapter_id||p.batch_id!==b.batch_id)throw Error('CHAPTER_SCOPE_VIOLATION');
  if(Buffer.byteLength(JSON.stringify(value))>plan.limits.output_bytes)throw Error('CHAPTER_OUTPUT_TOO_LARGE');
  for(const [i,block] of p.blocks.entries()){
    if(block.order!==i||block.block_id!==blockIdentity(plan.plan_hash,c.chapter_id,b.batch_id,i)||block.evidence.some(r=>!(evidenceRefs?.has(r)??b.context_refs.includes(r))&&!['target','requirements'].includes(r)))throw Error('CHAPTER_SCOPE_VIOLATION');
    if(block.kind==='heading'?(block.heading_level===null||block.style_key!=='heading'):block.heading_level!==null)throw Error('CHAPTER_STRUCTURE_INVALID');
    if(block.kind==='table'){
      if(!block.table_id||block.row_order===null||block.rows.length<2||block.rows.some(r=>r.length!==block.rows[0]!.length)||Buffer.byteLength(JSON.stringify(block.rows))>32768)throw Error('CHAPTER_TABLE_INVALID');
    }else if(block.rows.length||block.table_id!==null||block.row_order!==null)throw Error('CHAPTER_STRUCTURE_INVALID');
    if(!block.evidence.length&&!block.pending.length)throw Error('CHAPTER_EVIDENCE_UNCONFIRMED');
  }
}
export function assembleProjections(plan:AuthoringPlanV1,projections:DocumentProjectionV1[],evidenceRefs?:ReadonlySet<string>){
  verifyPlan(plan);const map=new Map<string,DocumentProjectionV1>();
  for(const p of projections){const k=`${p.chapter_id}/${p.batch_id}`;if(map.has(k))throw Error('CHAPTER_RECEIPT_CONFLICT');map.set(k,p);}
  const blocks:(DocumentProjectionV1['blocks'][number]&{chapter_id:string;batch_id:string})[]=[];const summary:string[]=[];
  for(const [c,chapter] of plan.chapters.entries())for(const [b,batch] of chapter.batches.entries()){
    const p=map.get(`${chapter.chapter_id}/${batch.batch_id}`);if(!p)throw Error('WORKFLOW_INCOMPLETE');validateProjection(p,plan,c,b,evidenceRefs);map.delete(`${chapter.chapter_id}/${batch.batch_id}`);
    blocks.push(...p.blocks.map(block=>({...block,chapter_id:chapter.chapter_id,batch_id:batch.batch_id})));summary.push(...p.summary);
  }
  if(map.size||new Set(blocks.map(b=>b.block_id)).size!==blocks.length)throw Error('CHAPTER_RECEIPT_CONFLICT');
  const projection={version:'whole-document-projection-v1',input_hash:plan.input_hash,workflow_plan_hash:plan.plan_hash,blocks,summary};
  return {...projection,plan_hash:inputManifestHash(projection)};
}
