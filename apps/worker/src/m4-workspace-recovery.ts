import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordModelAttemptRuntime} from '@bondbuddy/api/provider-results';
import {CodexOutputValidationError,type ContainedCallInput} from './codex-adapter.js';
import {captureExitedWorkspace,collectionDiagnostic,readWorkspaceEvidence,writeWorkspaceEvidence,type WorkspaceEvidence} from './model-workspace-evidence.js';
import {recoverFileAuthoringInput,restoreFileAuthoringWork} from './file-authoring-recovery.js';
import {checkedM4File} from './m4-file-workspace.js';
import type {StageContext} from './run-pipeline.js';

type Workspace=NonNullable<ContainedCallInput['fileWorkspace']>;
/** Documents and shared/group plans use the same private exit evidence boundary. */
export function recoverableM4Workspace(ctx:StageContext,logicalCallId:string,base:Pick<Workspace,'prepare'|'collect'>,
 options:{verify?:(cwd:string)=>Promise<void>;beforeRestore?:(cwd:string)=>Promise<void>;repair?:boolean}={}):Workspace {
 let repair:WorkspaceEvidence|null=null;
 const read=(id:string)=>readWorkspaceEvidence(ctx,id,logicalCallId);
 const restore=async(cwd:string,saved:WorkspaceEvidence)=>{
  await recoverFileAuthoringInput(ctx,saved.snapshot,await checkedM4File(cwd,'input.json'));
  await options.beforeRestore?.(cwd);
  await restoreFileAuthoringWork(ctx,cwd,saved.snapshot);
 };
 const feedback=(diagnostic:ReturnType<typeof collectionDiagnostic>)=>
  '已有 scratch/ 和 output/ 文件已恢复。只修复收集阶段指出的问题，保留已经完成的正文和材料提取；不得重建整个任务。检查规则：'+JSON.stringify(diagnostic)+
  '。读取 input.json 和对应 schema，补齐缺少的文件、正确字段及全文覆盖记录。不能用聊天说明代替文件；不能编造缺少的事实。';
 return {
  prepare:async cwd=>{await base.prepare(cwd);if(repair)await restore(cwd,repair);},collect:base.collect,
  onExited:async(cwd,intent,evidence)=>{await options.verify?.(cwd);await captureExitedWorkspace(ctx,cwd,intent,evidence);},
  onCollectionFailure:async(_cwd,intent,error)=>{
   const diagnostic=collectionDiagnostic(error);await writeWorkspaceEvidence(ctx,intent,'collection_failure',diagnostic);
   repair=await read(intent.call_id);
   return options.repair!==false&&error instanceof CodexOutputValidationError&&repair?.exit.completed&&repair.exit.observation.usage.status==='measured'
    &&intent.attempt_no===1?feedback(diagnostic):null;
  },
  ...(options.repair===false?{}:{prepareCollectionRepair:async(prior)=>{
   const saved=await read(prior.call_id);
   const row=(await ctx.pool.query(`SELECT e.payload FROM bb_model_workspace_evidence e
    JOIN bb_provider_call_observations o ON o.attempt_id=e.attempt_id
    WHERE e.attempt_id=$1 AND e.event='collection_failure' AND e.owner_user_id=$2 AND e.run_id=$3
     AND o.outcome='failed' AND o.error_code='MODEL_OUTPUT_SCHEMA_INVALID' AND o.usage_status='measured'`,
    [prior.call_id,ctx.run.owner_user_id,ctx.run.id])).rows[0];
   if(!saved?.exit.completed||saved.exit.observation.usage.status!=='measured'||!row||prior.attempt_no!==1)return null;
   repair=saved;return feedback(collectionDiagnostic({collectionDiagnostic:row.payload}));
  }}),
  recoverCollection:async prior=>{
   const saved=await read(prior.call_id);
   if(!saved?.exit.completed||saved.exit.runtime.exit_code!==0||saved.exit.observation.finish_reason!=='stop')return null;
   // A crash before collection can also precede runtime persistence. Fill only a
   // missing record under the new lease; never overwrite the first runtime.
   if(!(await ctx.pool.query('SELECT 1 FROM bb_model_call_attempt_runtime WHERE attempt_id=$1',[prior.call_id])).rowCount)
    await recordModelAttemptRuntime(ctx.pool,ctx.lease,saved.exit.observation,saved.exit.runtime);
   const directory=await mkdtemp(join(tmpdir(),'bb-m4-recollect-'));
   try{await base.prepare(directory);await restore(directory,saved);
    return {value:await base.collect(directory,saved.exit.observation,{text:''}),evidence:saved.exit};}
   finally{await rm(directory,{recursive:true,force:true});}
  }
 };
}
