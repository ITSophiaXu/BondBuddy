import {ReviewDecisionSchema,ReviewEditorExecutionSchema,ReviewExportRequestSchema,type ReviewDecision,type ReviewEditorExecution,type ReviewExportRequest} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';

export type ReviewEditorCacheStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type ReviewEditorCacheValue={sha256:string;decisions:ReviewDecision[];pending?:ReviewExportRequest};
export type ReviewEditorCacheRead=
  | {status:'empty'|'invalid'|'unavailable';value?:undefined}
  | {status:'valid';value:ReviewEditorCacheValue};
const version='review-editor-cache-v1';
// Both the saved choices and pending request may contain 2,000 maximum-length
// texts. JSON can escape every character into six code units; normal browser
// storage quotas are much lower and are handled as an unavailable write.
const maxRawLength=300000000;
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,required:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>=>record(value)&&
  required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
function validIssues(value:readonly string[]):boolean{
  return Array.isArray(value)&&value.length<=2000&&value.every(validId)&&new Set(value).size===value.length;
}
const copyDecision=({id,decision,manual_text}:ReviewDecision):ReviewDecision=>({id,decision,manual_text});
const copyExecution=({execution_version,input_revision,input_hash}:ReviewEditorExecution):ReviewEditorExecution=>({execution_version,input_revision,input_hash});
const sameExecution=(a:ReviewEditorExecution,b:ReviewEditorExecution)=>a.execution_version===b.execution_version&&a.input_revision===b.input_revision&&a.input_hash===b.input_hash;
const sameDecisions=(a:readonly ReviewDecision[],b:readonly ReviewDecision[])=>a.length===b.length&&a.every((item,i)=>item.id===b[i].id&&item.decision===b[i].decision&&item.manual_text===b[i].manual_text);
function clone(value:ReviewEditorCacheValue):ReviewEditorCacheValue{
  return {sha256:value.sha256,decisions:value.decisions.map(copyDecision),...(value.pending?{pending:{
    request_id:value.pending.request_id,source_run_id:value.pending.source_run_id,expected_editor_sha256:value.pending.expected_editor_sha256,
    ...(value.pending.source_execution?{source_execution:copyExecution(value.pending.source_execution)}:{}),
    decisions:value.pending.decisions.map(copyDecision),
  }}:{})};
}
function frozen(value:ReviewEditorCacheValue):ReviewEditorCacheValue{
  const result=clone(value);
  for(const item of result.decisions)Object.freeze(item);Object.freeze(result.decisions);
  if(result.pending){for(const item of result.pending.decisions)Object.freeze(item);Object.freeze(result.pending.decisions);if(result.pending.source_execution)Object.freeze(result.pending.source_execution);Object.freeze(result.pending);}
  return Object.freeze(result);
}
function validValue(value:unknown,sha256:string,issueIds:readonly string[],run:string,execution?:ReviewEditorExecution,allowUndefinedPending=false):value is ReviewEditorCacheValue{
  if(!exact(value,['sha256','decisions'],['pending'])||value.sha256!==sha256||!Array.isArray(value.decisions)||value.decisions.length!==issueIds.length)return false;
  const ids=new Set(issueIds);
  if(!value.decisions.every(item=>Value.Check(ReviewDecisionSchema,item)&&validId(item.id)&&ids.has(item.id))||new Set(value.decisions.map(item=>item.id)).size!==issueIds.length)return false;
  if(Object.hasOwn(value,'pending')&&!(allowUndefinedPending&&value.pending===undefined)){
    if(!Value.Check(ReviewExportRequestSchema,value.pending)||!validId(value.pending.request_id)||value.pending.source_run_id!==run||
      value.pending.expected_editor_sha256!==sha256||!sameDecisions(value.decisions,value.pending.decisions))return false;
    if(Object.hasOwn(value.pending,'source_execution')){
      if(!Value.Check(ReviewEditorExecutionSchema,value.pending.source_execution)||!execution||!sameExecution(value.pending.source_execution,execution))return false;
    }else if(execution&&execution.execution_version!==1)return false;
  }
  return true;
}

/** Local recovery only: reading a saved request never submits or clears it. */
export class ReviewEditorCache{
  private storage?:ReviewEditorCacheStorage;
  private key?:string;
  private legacyUnambiguous=false;
  private execution?:ReviewEditorExecution;
  constructor(private owner:string,private project:string,private run:string,storage?:ReviewEditorCacheStorage,execution?:ReviewEditorExecution){
    if(![owner,project,run].every(validId)||(execution!==undefined&&!Value.Check(ReviewEditorExecutionSchema,execution)))return;
    this.execution=execution?copyExecution(execution):undefined;
    this.key=`bb-review-editor:${owner}:${project}:${run}`;
    // The historical raw key has no delimiter escaping; legacy values lack an
    // identity wrapper and cannot prove ownership for colon-containing IDs.
    this.legacyUnambiguous=![owner,project,run].some(id=>id.includes(':'));
    try{this.storage=storage??globalThis.localStorage;}catch{/* Report unavailable on access. */}
  }
  read(sha256:string,issueIds:readonly string[]):ReviewEditorCacheRead{
    if(!this.key||!validHash(sha256)||!validIssues(issueIds))return {status:'invalid'};
    if(!this.storage)return {status:'unavailable'};
    let raw:string|null;
    try{raw=this.storage.getItem(this.key);}catch{return {status:'unavailable'};}
    if(raw===null)return {status:'empty'};
    if(raw.length>maxRawLength)return {status:'invalid'};
    try{
      const saved:unknown=JSON.parse(raw);let value:unknown;
      // Old recovery records refer only to the original V1. A pinned wrapper
      // also isolates ordinary choices when two executions share editor bytes.
      if(exact(saved,['version','owner','project','run','value'],['execution'])){
        if(saved.version!==version||saved.owner!==this.owner||saved.project!==this.project||saved.run!==this.run)return {status:'invalid'};
        if(Object.hasOwn(saved,'execution')){
          if(!Value.Check(ReviewEditorExecutionSchema,saved.execution)||!this.execution||!sameExecution(saved.execution,this.execution))return {status:'invalid'};
        }else if(this.execution&&this.execution.execution_version!==1)return {status:'invalid'};
        value=saved.value;
      }else{
        if(!this.legacyUnambiguous||(this.execution&&this.execution.execution_version!==1))return {status:'invalid'};value=saved;
      }
      if(!validValue(value,sha256,issueIds,this.run,this.execution))return {status:'invalid'};
      return {status:'valid',value:frozen(value)};
    }catch{return {status:'invalid'};}
  }
  save(value:ReviewEditorCacheValue,issueIds:readonly string[]):boolean{
    if(!this.key||!this.storage)return false;
    try{
      if(!validHash(value?.sha256)||!validIssues(issueIds)||!validValue(value,value.sha256,issueIds,this.run,this.execution,true))return false;
      const snapshot=clone(value),body=JSON.stringify({version,owner:this.owner,project:this.project,run:this.run,...(this.execution?{execution:copyExecution(this.execution)}:{}),value:snapshot});
      if(body.length>maxRawLength)return false;
      this.storage.setItem(this.key,body);
      // Exact readback also proves an old unwrapped value was migrated; merely
      // finding equivalent choices would miss a silently discarded write.
      return this.storage.getItem(this.key)===body;
    }catch{return false;}
  }
  clear():boolean{
    if(!this.key||!this.storage)return false;
    try{this.storage.removeItem(this.key);return this.storage.getItem(this.key)===null;}catch{return false;}
  }
}
