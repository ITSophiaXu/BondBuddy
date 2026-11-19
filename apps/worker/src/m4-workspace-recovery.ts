import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {isFileAuthoringDeadline} from '@bondbuddy/contracts';
import {recordModelAttemptRuntime} from '@bondbuddy/api/provider-results';
import {CodexOutputValidationError,type ContainedCallInput} from './codex-adapter.js';
import {captureExitedWorkspace,collectionDiagnostic,readWorkspaceEvidence,writeWorkspaceEvidence,type WorkspaceEvidence} from './model-workspace-evidence.js';
import {recoverFileAuthoringInput,restoreFileAuthoringWork} from './file-authoring-recovery.js';
import {checkedM4File} from './m4-file-workspace.js';
import type {StageContext} from './run-pipeline.js';

export const M4_FULL_SOURCE_READING_INSTRUCTIONS = '当 task.input.document_type 为 workpaper 时，reviewed_span_ids 必须包含 source-spans.json 中全部已实际通读的非空段落，不能只记录命中关键词或用于正文的段落；used_span_ids 和 excluded 都不能替代审阅记录。先实际读取遗漏段落，再记录其 id，不得仅复制全部 id 冒充阅读。已审阅但与本项无关的段落才可排除；无法核实的图片或原件事实如实保留具体缺口，不能声称已核实。';

export const M4_VERIFIED_LINKS_INSTRUCTIONS = '底稿最后一次编辑、扩展表格和排版保存后，重新读取最终 output/document.docx 的实际段落，按 document.xml 中全部 w:p（包括表格）零起算更新 output/file-links.json。可用 python -B -m bondbuddy_file_authoring.project_files inspect output/document.docx scratch/target-spans-final.json 获取宿主相同的段落文本。每条 source_quote 必须在指定来源段落中逐字且唯一出现，target_quote 必须在指定最终目标段落中逐字且唯一出现；旧段落编号或旧版引文不能沿用。逐项检查 workpaper-coverage.json 的每个 used_span_ids 均至少有一条通过两端核对的关联，相关完整表格仍须逐单元格入表关联。引文失配应核对真实正文、引用文本或段落编号，不得通过自动更换目标位置、删去相关 used 段落、改列 excluded 或伪造关联规避校验。';

export function m4CollectionRepairFeedback(diagnostic:ReturnType<typeof collectionDiagnostic>){
 return '已有 scratch/ 和 output/ 文件已恢复。只修复收集阶段指出的问题，保留已经完成的正文和材料提取；不得重建整个任务。检查规则：'+JSON.stringify(diagnostic)+
  '。读取 input.json 和对应 schema，补齐缺少的文件、正确字段及全文覆盖记录。不能用聊天说明代替文件；不能编造缺少的事实。'+
  (diagnostic.rule==='all_nonempty_source_spans'?M4_FULL_SOURCE_READING_INSTRUCTIONS:'')+
  (diagnostic.code==='WORKPAPER_CONTENT_LINKS_MISSING'?'本次错误定位 output/file-links.json；source_span_ids 是尚无有效正文关联的来源ID样本，source_span_count 为总数。不能只修改 workpaper-coverage.json。'+M4_VERIFIED_LINKS_INSTRUCTIONS:'');
}

type Workspace=NonNullable<ContainedCallInput['fileWorkspace']>;
/** Documents and shared/group plans use the same private exit evidence boundary. */
export function recoverableM4Workspace(ctx:StageContext,logicalCallId:string,base:Pick<Workspace,'prepare'|'collect'>,
 options:{verify?:(cwd:string)=>Promise<void>;beforeRestore?:(cwd:string,snapshot:WorkspaceEvidence['snapshot'])=>Promise<void>;repair?:boolean}={}):Workspace {
 let repair:WorkspaceEvidence|null=null;
 const timeout=ctx.lease.checkpoint.m4_timeout_recovery as {version?:string;run_id?:string;input_hash?:string;attempt_id?:string;logical_call_id?:string;evidence_sha256?:string;authorized_at?:string;deadline_at?:string}|undefined;
 const read=(id:string)=>readWorkspaceEvidence(ctx,id,logicalCallId);
 const restore=async(cwd:string,saved:WorkspaceEvidence)=>{
  await recoverFileAuthoringInput(ctx,saved.snapshot,await checkedM4File(cwd,'input.json'));
  await options.beforeRestore?.(cwd,saved.snapshot);
  await restoreFileAuthoringWork(ctx,cwd,saved.snapshot);
 };
 return {
  prepare:async cwd=>{if(timeout&&!repair)throw Error('WORKSPACE_RECOVERY_CONFLICT');await base.prepare(cwd);if(repair)await restore(cwd,repair);},collect:base.collect,
  ...(timeout?{get deadlineAt(){return timeout.deadline_at;}}:{}),
  onExited:async(cwd,intent,evidence)=>{await options.verify?.(cwd);await captureExitedWorkspace(ctx,cwd,intent,evidence);},
  onCollectionFailure:async(_cwd,intent,error)=>{
   const diagnostic=collectionDiagnostic(error);await writeWorkspaceEvidence(ctx,intent,'collection_failure',diagnostic);
   repair=await read(intent.call_id);
   return options.repair!==false&&error instanceof CodexOutputValidationError&&repair?.exit.completed&&repair.exit.observation.usage.status==='measured'
    &&intent.attempt_no===1?m4CollectionRepairFeedback(diagnostic):null;
  },
  ...(options.repair===false?{}:{prepareCollectionRepair:async(prior)=>{
   const saved=await read(prior.call_id);
   if(timeout){
    const audit=(ctx.lease.checkpoint.operator_reconciliations as Record<string,{decision?:string;reason_code?:string;deadline_at?:string}>|undefined)?.[prior.call_id];
    if(timeout.version!=='m4-timeout-recovery-v1'||timeout.run_id!==ctx.run.id||timeout.input_hash!==ctx.run.input_hash.trim()
      ||timeout.attempt_id!==prior.call_id||timeout.logical_call_id!==logicalCallId||logicalCallId!=='m4-document-v1'||prior.attempt_no!==1||!prior.operator_retry
      ||!isFileAuthoringDeadline(timeout.authorized_at)||!isFileAuthoringDeadline(timeout.deadline_at)||Date.parse(timeout.deadline_at!)<=Date.now()
      ||Date.parse(timeout.authorized_at!)>Date.now()||Date.parse(timeout.deadline_at!)-Date.parse(timeout.authorized_at!)>90*60*1000||!saved||inputManifestHash(saved)!==timeout.evidence_sha256
      ||saved.exit.completed||saved.exit.observation.error_code!=='MODEL_TIMEOUT'||saved.exit.observation.usage.status!=='unknown'
      ||!['SIGTERM','SIGKILL'].includes(saved.exit.runtime.exit_signal??'')||audit?.decision!=='retry_unknown_usage'
      ||audit.reason_code!=='m4_timeout_workspace_continuation'||audit.deadline_at!==timeout.deadline_at)throw Error('WORKSPACE_RECOVERY_CONFLICT');
    repair=saved;
    return '上次调用已确认超时退出，已有 scratch/ 和 output/ 完整快照将恢复。本次只接续尚未完成的核对与交付文件，先读取已有工作记录和实际文件，不从头重建。保持原始输入、模板和报价；本次最多90分钟，不能重复延长。'+M4_FULL_SOURCE_READING_INSTRUCTIONS+'按实际分类写全结果与覆盖；generate 时补齐关联及两份Word，其他分类由宿主形成具体说明，不伪造原件或履职记录，再结束调用。';
   }
   const row=(await ctx.pool.query(`SELECT e.payload FROM bb_model_workspace_evidence e
    JOIN bb_provider_call_observations o ON o.attempt_id=e.attempt_id
    WHERE e.attempt_id=$1 AND e.event='collection_failure' AND e.owner_user_id=$2 AND e.run_id=$3
     AND o.outcome='failed' AND o.error_code='MODEL_OUTPUT_SCHEMA_INVALID' AND o.usage_status='measured'`,
    [prior.call_id,ctx.run.owner_user_id,ctx.run.id])).rows[0];
   if(!saved?.exit.completed||saved.exit.observation.usage.status!=='measured'||!row||prior.attempt_no!==1)return null;
   repair=saved;return m4CollectionRepairFeedback(collectionDiagnostic({collectionDiagnostic:row.payload}));
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
