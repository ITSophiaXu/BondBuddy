import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {raiseAlert} from '@bondbuddy/api/evidence-gate';
import {executionNodeForPool,withExecutionControlPool} from '@bondbuddy/api/execution-capacity';
import {withPerformanceSpan,withPerformanceTrace,flushPerformanceTraces} from '@bondbuddy/api/performance-trace';
import type {ExecutionNodeContext} from '@bondbuddy/contracts';
import type {StageOutcome} from './run-pipeline.js';
import type {Lease} from '@bondbuddy/api/queue';
import type {DurableSpoolManifest,DurableSpoolReceipt} from './durable-spool.js';
export type WorkflowAlertScope={ownerUserId:string;projectId:string;runId:string;jobId:string;leaseToken:string};
export type WorkflowAlert={kind:string;severity:'warning'|'critical';scope:string;detail:Record<string,string|number>;bucketSeconds?:number};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const alertScope=(scope:WorkflowAlertScope)=>({owner_user_id:scope.ownerUserId,project_id:scope.projectId,run_id:scope.runId,job_id:scope.jobId,lease_token_sha256:hash(scope.leaseToken)});
/** Alert persistence is advisory; bounded managed control IO cannot change task safety. */
export async function raiseWorkflowAlert(pool:Pool,alert:WorkflowAlert):Promise<void>{
 try{if(executionNodeForPool(pool))await withExecutionControlPool(pool,control=>raiseAlert(control,alert));else await raiseAlert(pool,alert);}catch{}
}
export function spoolPerformanceAttributes(manifest:DurableSpoolManifest,receipt:DurableSpoolReceipt,current?:ExecutionNodeContext):Record<string,unknown>{
 const i=manifest.identity,e=i.originalExecution;
 return {spool_id:receipt.spoolId,call_id:i.attemptId,logical_call_id:i.logicalCallId,attempt_no:i.attemptNo,
  execution_node_id:e.nodeId,execution_node_epoch:e.epoch,execution_session_id:e.sessionId,
  original_execution_node_epoch:e.epoch,original_execution_session_id:e.sessionId,lease_token_sha256:hash(i.leaseToken),
  ...(current?{host_id:current.identity.instance_id,process_session_id:current.session_id}:{})};
}
export async function withSpoolReceiptTrace<T>(pool:Pool,manifest:DurableSpoolManifest,receipt:DurableSpoolReceipt,work:()=>Promise<T>):Promise<T>{
 const i=manifest.identity,current=executionNodeForPool(pool);
 try{return await withPerformanceTrace(pool,{ownerUserId:i.ownerUserId,projectId:i.projectId,runId:i.runId,jobId:i.jobId,serviceRole:'spool',
  ...(current?{hostId:current.identity.instance_id,processSessionId:current.session_id}:{})},()=>withPerformanceSpan('spool.receipt',spoolPerformanceAttributes(manifest,receipt,current),work));}
 finally{await flushPerformanceTraces(pool,1000);}
}
export async function workflowBudgetGuard(pool:Pool,scope:WorkflowAlertScope,budget:{used_known:number;unknown_calls:string[]},limit:number,attributes:Record<string,string>={}):Promise<StageOutcome|undefined>{
 return withPerformanceSpan('workflow.chapter.budget',attributes,async span=>{
  if(budget.unknown_calls.length){
   await raiseWorkflowAlert(pool,{kind:'workflow_usage_unknown',severity:'critical',scope:scope.jobId,bucketSeconds:300,
    detail:{...alertScope(scope),...attributes,call_id:budget.unknown_calls[0]!,unknown_calls:budget.unknown_calls.length}});
   span.end('paused',{error_code:'WORKFLOW_USAGE_UNKNOWN'});return {kind:'pause',stage:'provider_reconcile',reason:'workflow_usage_unknown'};
  }
  if(budget.used_known>=limit){
   await raiseWorkflowAlert(pool,{kind:'workflow_chapter_budget_exhausted',severity:'warning',scope:scope.jobId,bucketSeconds:300,
    detail:{...alertScope(scope),...attributes,used_known:budget.used_known,token_limit:limit,error_code:'WORKFLOW_TOKEN_BUDGET_EXHAUSTED'}});
   span.end('paused',{error_code:'WORKFLOW_TOKEN_BUDGET_EXHAUSTED'});return {kind:'pause',stage:'credits_exhausted',reason:'workflow_token_budget_exhausted'};
  }
 });
}
export async function withChapterBudget<T>(pool:Pool,scope:WorkflowAlertScope,attributes:Record<string,string>,check:()=>T):Promise<T>{
 return withPerformanceSpan('workflow.chapter.deadline',attributes,async()=>{
  try{return await check();}catch(error){
   const code=error instanceof Error?error.message:'';
   if(['WORKFLOW_RUN_DEADLINE','WORKFLOW_REPAIR_BUDGET_EXHAUSTED'].includes(code))await raiseWorkflowAlert(pool,{kind:'workflow_chapter_budget_exhausted',severity:'warning',scope:scope.jobId,bucketSeconds:300,detail:{...alertScope(scope),...attributes,error_code:code}});
   throw error;
  }
 });
}
export async function reportSpoolHealth(pool:Pool,health:{pending:number;gcPending:number;oldestPendingAt:string|null;oldestGcAt?:string|null;lowDisk:boolean;availableBytes:number},current?:ExecutionNodeContext,now=Date.now()):Promise<number>{
 const timestamps=[health.oldestPendingAt,health.oldestGcAt].filter((v):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))),oldest=timestamps.length?Math.min(...timestamps.map(Date.parse)):null;
 const scope=current?.session_id??'spool',detail:Record<string,string>=current?{execution_instance_id:current.identity.instance_id,execution_node_epoch:current.identity.epoch,execution_session_id:current.session_id}:{};let raised=0;
 if(oldest!==null&&now-oldest>300000&&(health.pending>0||health.gcPending>0)){
  await raiseWorkflowAlert(pool,{kind:'spool_pending_stale',severity:'warning',scope,bucketSeconds:300,detail:{...detail,pending:health.pending,gc_pending:health.gcPending,oldest_age_ms:now-oldest,threshold_ms:300000}});raised++;
 }
 if(health.lowDisk){await raiseWorkflowAlert(pool,{kind:'spool_low_disk',severity:'critical',scope,bucketSeconds:300,detail:{...detail,available_bytes:health.availableBytes,threshold_bytes:256*1024*1024}});raised++;}
 return raised;
}
export async function withWorkflowHandoffPerformance<T>(pool:Pool,lease:Lease,work:(control:Pool)=>Promise<T>):Promise<T>{
 return withExecutionControlPool(pool,async control=>{
  const row=(await control.query('SELECT r.project_id,j.execution_node_id FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id WHERE r.id=$1 AND r.owner_user_id=$2 AND j.id=$3',[lease.runId,lease.owner,lease.jobId])).rows[0];
  if(!row)throw Error('WORKFLOW_RELEASE_SCOPE_MISSING');
  const context=executionNodeForPool(pool);
  return withPerformanceTrace(pool,{ownerUserId:lease.owner,projectId:row.project_id,runId:lease.runId,jobId:lease.jobId,serviceRole:'handoff'},()=>
   withPerformanceSpan('workflow.handoff.release',{lease_token_sha256:hash(lease.token),...(row.execution_node_id?{execution_node_id:row.execution_node_id}:{}),...(context?{execution_node_epoch:context.identity.epoch,execution_session_id:context.session_id}:{})},async span=>{
    const result=await work(control);if(result==='blocked')span.end('paused',{outcome:'blocked'});return result;
   }));
 });
}
