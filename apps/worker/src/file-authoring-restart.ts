import { isDeepStrictEqual } from 'node:util';
import { digest } from '@bondbuddy/api/data';
import type { StageContext } from './run-pipeline.js';

const unsafe=()=>Error('INPUT_REVISION_CONFLICT');
const id=/^[A-Za-z0-9_-]{1,128}$/;
type RestartAttempt={id:string;logical_call_id:string;attempt_no:number;status:string;prompt_snapshot_id:string;
  usage_status:string;conflicting_measurements:number;adapter:string;adapter_version:string;error_code:string|null;
  exit_code:number|null;exit_signal:string|null;checkpoint:any;has_result:boolean;newer_count:number};

/** An owner-confirmed legacy restart pins the current instructions under a new
 * stage, keeping the old prompt and logical-call history intact. This is only a
 * prompt selector: the durable journal still decides whether any call may run. */
export async function fileAuthoringRestartStageName(ctx:StageContext,base:string,logical:string):Promise<string> {
  if(logical!=='file-authoring-v1')return base;
  const audits=ctx.lease.checkpoint.operator_reconciliations as Record<string,Record<string,unknown>>|undefined;
  if(!Object.values(audits??{}).some(a=>a.reason_code==='file_authoring_manual_restart'))return base;
  if(base!=='file_authoring_v1'||ctx.lease.owner!==ctx.run.owner_user_id||ctx.lease.runId!==ctx.run.id)throw unsafe();
  const rows=(await ctx.pool.query(`SELECT a.id,a.logical_call_id,a.attempt_no,a.status,a.prompt_snapshot_id,
    u.usage_status,u.conflicting_measurements,t.adapter,t.adapter_version,t.error_code,t.exit_code,t.exit_signal,j.checkpoint,
    EXISTS(SELECT 1 FROM bb_provider_result_refs WHERE attempt_id=a.id) AS has_result,
    (SELECT count(*)::int FROM bb_model_call_attempts newer WHERE newer.job_id=a.job_id AND newer.id<>a.id
      AND (newer.logical_call_id=a.logical_call_id AND newer.attempt_no>a.attempt_no OR newer.created_at>a.created_at)) AS newer_count
    FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
    JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision AND i.input_hash=r.input_hash
    JOIN bb_model_call_attempts a ON a.job_id=j.id AND a.owner_user_id=j.owner_user_id
    LEFT JOIN bb_call_usage u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
    WHERE j.id=$1 AND j.owner_user_id=$2 AND j.run_id=$3 AND j.state='running' AND j.lease_token=$4 AND j.lease_until>now()
      AND r.state='running' AND r.task_kind='update' AND r.project_id=$5 AND r.input_revision=$6 AND r.input_hash=$7
    ORDER BY a.created_at DESC,a.attempt_no DESC,a.id DESC`,
    [ctx.lease.jobId,ctx.lease.owner,ctx.run.id,ctx.lease.token,ctx.run.project_id,ctx.run.input_revision,ctx.run.input_hash.trim()])).rows as RestartAttempt[];
  const prior=rows.find(a=>a.logical_call_id===logical&&audits?.[a.id]?.reason_code==='file_authoring_manual_restart');
  if(!prior)throw unsafe();
  const audit=audits![prior.id],current=prior.checkpoint?.operator_reconciliations?.[prior.id];
  const request=prior.checkpoint?.user_retry_requests?.[String(audit.request_id)];
  if(!isDeepStrictEqual(audit,current)||audit.actor!==`owner:${ctx.run.owner_user_id}`||audit.decision!=='retry_unknown_usage'
    ||audit.retry_mode!=='restart_materials'||audit.recovery_state!=='queued'||audit.attempt_id!==prior.id||audit.logical_call_id!==logical
    ||audit.owner_user_id!==ctx.run.owner_user_id||audit.project_id!==ctx.run.project_id||audit.run_id!==ctx.run.id||audit.job_id!==ctx.lease.jobId
    ||audit.input_revision!==String(ctx.run.input_revision)||audit.input_hash!==ctx.run.input_hash.trim()
    ||typeof audit.request_id!=='string'||!id.test(audit.request_id)
    ||!request||request.request_id!==audit.request_id||request.attempt_id!==prior.id||request.mode!=='restart_materials'||request.confirmed_restart!==true
    ||prior.status!=='failed'||prior.usage_status!=='unknown'||prior.conflicting_measurements>0||prior.has_result
    ||prior.adapter!=='codex_exec'||prior.adapter_version!=='codex-file-authoring-2'
    ||!['MODEL_TURN_FAILED','MODEL_OUTPUT_TOO_LARGE'].includes(prior.error_code??'')
    ||!(prior.exit_code!==null||/^SIG[A-Z0-9]+$/.test(prior.exit_signal??'')))throw unsafe();
  let stage=`${base}_restart_${digest(prior.id).slice(0,12)}`,authorized:RestartAttempt=prior;
  const hasRecovery=Object.hasOwn(prior.checkpoint?.stages??{},'file_authoring_recovery');
  // Follow each exact restart/resume prompt, not merely the newest completed
  // attempt. A later repair may replace the single workspace checkpoint after
  // the first pass has already finished through an authorized automatic retry.
  for(let n=0;n<=rows.length;n++){
    const pinned=prior.checkpoint?.stages?.[`${stage}_prompt`]?.snapshot_id;
    if(pinned!==undefined&&ctx.checkpoint[`${stage}_prompt`]?.snapshot_id!==pinned)throw unsafe();
    const next:RestartAttempt|undefined=rows.find(a=>a.logical_call_id===logical&&a.attempt_no===authorized.attempt_no+1);
    if(!next){
      // Only the original explicit confirmation can start new work here. An
      // automatic retry without its saved workspace belongs to the recovery gate.
      if(authorized===prior&&prior.newer_count===0&&!hasRecovery)return stage;
      throw unsafe();
    }
    if(typeof pinned!=='string'||next.prompt_snapshot_id!==pinned)throw unsafe();
    if(next.status==='completed'&&next.has_result&&!rows.some(a=>a.logical_call_id===logical&&a.attempt_no>next.attempt_no))return stage;
    const retry:Record<string,unknown>|undefined=audits?.[next.id],persisted=prior.checkpoint?.operator_reconciliations?.[next.id];
    const reason:string|null=next.error_code==='MODEL_OUTPUT_TOO_LARGE'?'file_authoring_output_limit_auto_retry':
      next.error_code==='MODEL_PROVIDER_PAYLOAD_TOO_LARGE'?'file_authoring_payload_auto_retry':null;
    if(reason&&retry?.reason_code===reason){
      const ownerRequest=prior.checkpoint?.user_retry_requests?.[String(retry.request_id)];
      const ownerRestore=retry.actor===`owner:${ctx.run.owner_user_id}`&&retry.retry_mode==='restore_checkpoint'
        &&retry.owner_user_id===ctx.run.owner_user_id&&retry.project_id===ctx.run.project_id&&retry.run_id===ctx.run.id&&retry.job_id===ctx.lease.jobId
        &&retry.input_revision===String(ctx.run.input_revision)&&retry.input_hash===ctx.run.input_hash.trim()
        &&typeof retry.request_id==='string'&&id.test(retry.request_id)&&ownerRequest?.request_id===retry.request_id
        &&ownerRequest.attempt_id===next.id&&ownerRequest.mode==='restore_checkpoint'&&typeof ownerRequest.confirmed_restart==='boolean';
      if(!isDeepStrictEqual(retry,persisted)||retry.attempt_id!==next.id||retry.logical_call_id!==logical||retry.decision!=='retry_unknown_usage'
        ||!['queued','user_paused','credits_exhausted'].includes(String(retry.recovery_state))
        ||!(retry.actor==='worker_file_authoring_recovery'||ownerRestore)||next.status!=='failed'||next.usage_status!=='unknown'
        ||next.conflicting_measurements>0||next.has_result||next.adapter!=='codex_exec'||next.adapter_version!=='codex-file-authoring-2'
        ||!(next.exit_code!==null||/^SIG[A-Z0-9]+$/.test(next.exit_signal??'')))throw unsafe();
      authorized=next;stage=`${base}_resume_${digest(next.id).slice(0,12)}`;continue;
    }
    if(next.status==='pending_reconcile'&&authorized.newer_count===1&&rows[0].id===next.id&&!hasRecovery)return stage;
    throw unsafe();
  }
  throw unsafe();
}
