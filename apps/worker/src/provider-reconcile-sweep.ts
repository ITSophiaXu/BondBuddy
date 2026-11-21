import type { Pool } from 'pg';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { providerReconciliationCandidates, reconcilePausedCall, recoverUnifiedTimeout, recoverFileAuthoringPayload,
  recordProviderReconcileUnknown, resumePausedRun, type RunKind } from '@bondbuddy/api/queue';
import { reconcilePausedProviderCall, type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { raiseAlert } from '@bondbuddy/api/evidence-gate';

export type PendingAttempt = { owner_user_id:string; project_id:string; run_id:string; job_id:string; logical_call_id:string;
  attempt_no:number; call_id:string; model_id:string|null; prompt_snapshot_ref:string|null; observed:boolean };
export type ReconcileAnswer = {outcome:'unknown'} | {outcome:'confirmed_not_sent'} |
  {outcome:'completed';observation:ProviderCallObservation;validate:(value:unknown)=>boolean};
export interface ProviderCallReconciler { name:string; query(attempt:PendingAttempt):Promise<ReconcileAnswer> }
/** No provider lookup exists. Unknown usage stays unknown even when the task fails. */
export const codexNoLookupReconciler:ProviderCallReconciler={name:'codex_no_lookup',query:async()=>({outcome:'unknown'})};
type Options={pool:Pool;blobs?:PrivateBlobs;reconciler?:ProviderCallReconciler;log?:(event:Record<string,unknown>)=>void};

export async function reconcileProviderRun(options:Options,owner:string,runId:string,jobId:string) {
  const {pool,blobs,log=()=>{},reconciler=codexNoLookupReconciler}=options;
  const scope=(await pool.query(`SELECT p.archived_at,p.deleted_at FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id
    JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
    WHERE r.id=$1 AND r.owner_user_id=$2 AND j.id=$3 AND r.state IN ('paused','settlement_pending')
      AND r.stage='provider_reconcile' AND j.state='paused' AND j.stage='provider_reconcile'`,[runId,owner,jobId])).rows[0];
  if(!scope)return false;
  if(scope.archived_at||scope.deleted_at)return recordProviderReconcileUnknown(pool,owner,runId,jobId,reconciler.name);
  const attempts=(await pool.query(`SELECT a.owner_user_id,r.project_id,r.id AS run_id,a.job_id,a.logical_call_id,a.attempt_no,
      a.id AS call_id,a.model_id,a.prompt_snapshot_id AS prompt_snapshot_ref,
      EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=a.id) AS observed
    FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id JOIN bb_runs r ON r.id=j.run_id
    WHERE a.owner_user_id=$1 AND a.job_id=$2 AND r.id=$3 AND a.status='pending_reconcile'
      AND r.state IN ('paused','settlement_pending') AND r.stage='provider_reconcile'
      AND j.state='paused' AND j.stage='provider_reconcile'
    ORDER BY a.logical_call_id,a.attempt_no`,[owner,jobId,runId])).rows as PendingAttempt[];
  const recoverOrFinish=async()=>await recoverFileAuthoringPayload(pool,owner,runId,jobId)||
    await recoverUnifiedTimeout(pool,owner,runId,jobId)||await recordProviderReconcileUnknown(pool,owner,runId,jobId,reconciler.name);
  for(const attempt of attempts){
    let answer:ReconcileAnswer;
    try{answer=await reconciler.query(attempt);}catch(error){
      if(await recordProviderReconcileUnknown(pool,owner,runId,jobId,'lookup_error'))return true;
      throw error;
    }
    log({kind:'reconcile',run_id:runId,logical_call_id:attempt.logical_call_id,attempt_no:attempt.attempt_no,reconciler:reconciler.name,outcome:answer.outcome});
    if(answer.outcome==='unknown')return recoverOrFinish();
    if(answer.outcome==='confirmed_not_sent')await reconcilePausedCall(pool,owner,runId,attempt.logical_call_id,attempt.attempt_no,'confirmed_not_sent');
    else {
      if(!blobs)throw Error('Provider result reconciliation requires private storage');
      await reconcilePausedProviderCall(pool,blobs,answer.observation,answer.validate);
    }
  }
  // Failed/completed attempts with incomplete evidence can also block resume.
  // They must reach the same deadline rather than disappear from this pass.
  return await resumePausedRun(pool,owner,runId,'provider_reconciled',blobs?{blobs}:undefined)||await recoverOrFinish();
}

/** No model slots, provider calls or blob reads for the default no-lookup path.
 * The always-on ops process uses this same bounded state machine at scale zero. */
export class ProviderReconciliationSweep {
  private cursor?:string;
  constructor(private readonly options:Options&{runKinds?:readonly RunKind[]}){}
  async run(){
    const rows=await providerReconciliationCandidates(this.options.pool,20,this.options.runKinds,this.cursor);
    this.cursor=rows.length===20?rows.at(-1)!.job_id:undefined;
    let progressed=0,errors=0;
    for(const row of rows){
      try{if(await reconcileProviderRun(this.options,row.owner_user_id,row.run_id,row.job_id))progressed++;}
      catch{
        errors++;
        this.options.log?.({kind:'reconcile',run_id:row.run_id,outcome:'error'});
      }
    }
    return {scanned:rows.length,progressed,errors};
  }
}

/** Report the capability that can execute these runs. A parser heartbeat cannot
 * hide a missing authoring service; healthy scale-zero recovery needs no executor. */
export async function providerReconciliationHealth(pool:Pool,maxAgeSeconds=90){
  const row=(await pool.query(`WITH pending AS (
    SELECT r.id,CASE WHEN j.job_type='platform_probe' THEN 'probe' WHEN r.task_kind='review' THEN 'review' ELSE 'authoring' END capability,
      COALESCE((SELECT e.occurred_at FROM bb_run_events e WHERE e.run_id=r.id AND e.state='paused'
        AND e.stage='provider_reconcile' AND e.type='run.state_changed' ORDER BY e.seq DESC LIMIT 1),r.updated_at) started_at
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.state='paused' AND r.stage='provider_reconcile'
      AND j.state='paused' AND j.stage='provider_reconcile'
  ) SELECT count(*)::int paused_count,COALESCE(GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-min(started_at))::int),0) oldest_paused_age_seconds,
    CASE WHEN (SELECT managed_nodes FROM bb_execution_capacity_policy WHERE singleton) THEN
      EXISTS(SELECT 1 FROM bb_execution_node_sessions s JOIN bb_execution_nodes n ON n.id=s.node_id AND n.epoch=s.epoch
        WHERE s.state='active' AND s.ready AND n.state IN ('ready','draining') AND s.heartbeat_at>clock_timestamp()-make_interval(secs=>$1))
      AND NOT EXISTS(SELECT 1 FROM pending p WHERE NOT EXISTS(SELECT 1 FROM bb_execution_node_sessions s
        JOIN bb_execution_nodes n ON n.id=s.node_id AND n.epoch=s.epoch
        CROSS JOIN LATERAL jsonb_array_elements(n.expected_services) svc
        WHERE s.state='active' AND s.ready AND n.state IN ('ready','draining') AND s.service_id=svc->>'service_id'
          AND svc->'capabilities' ? p.capability AND s.heartbeat_at>clock_timestamp()-make_interval(secs=>$1)))
    ELSE EXISTS(SELECT 1 FROM bb_worker_heartbeats WHERE stopped_at IS NULL AND 'run'=ANY(kinds)
      AND last_seen_at>clock_timestamp()-make_interval(secs=>$1)) END worker_alive
    FROM pending`,[maxAgeSeconds])).rows[0];
  const detail={paused_count:Number(row.paused_count),oldest_paused_age_seconds:Number(row.oldest_paused_age_seconds),worker_alive:row.worker_alive?1:0};
  if(detail.paused_count&&detail.oldest_paused_age_seconds>maxAgeSeconds&&!detail.worker_alive)
    await raiseAlert(pool,{kind:'worker_heartbeat_stale',severity:'critical',scope:'provider_reconcile',detail});
  if(detail.oldest_paused_age_seconds>=3600)
    await raiseAlert(pool,{kind:'queue_backlog_stale',severity:'critical',scope:'provider_reconcile',detail});
  return detail;
}
