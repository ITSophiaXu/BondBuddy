import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {raiseAlert} from '@bondbuddy/api/evidence-gate';
/** Read-only operational diagnosis never grants permission to replay or release. */
export async function checkWorkflowOperationsHealth(pool:Pool,dueGraceSeconds=300):Promise<{due_scan_stale:number;handoff_stale:number}>{
 if(!Number.isSafeInteger(dueGraceSeconds)||dueGraceSeconds<1||dueGraceSeconds>86400)throw Error('WORKFLOW_HEALTH_THRESHOLD_INVALID');
 const due=(await pool.query(`WITH paused AS (
  SELECT j.id job_id,r.id run_id,r.owner_user_id,r.project_id,j.checkpoint,
   COALESCE((SELECT e.occurred_at FROM bb_run_events e WHERE e.run_id=r.id AND e.state='paused' AND e.stage='provider_reconcile' AND e.type='run.state_changed' ORDER BY e.seq DESC LIMIT 1),r.updated_at) paused_at
  FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
  WHERE j.state='paused' AND j.stage='provider_reconcile' AND r.state IN ('paused','settlement_pending') AND r.stage='provider_reconcile'
   AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND NOT (COALESCE(j.checkpoint#>>'{provider_reconcile_manual,disposition}','')='manual_required'
    AND COALESCE(j.checkpoint#>>'{provider_reconcile_manual,reason_code}','')='workflow_protocol_unsupported')
 ), eligible AS (SELECT *,LEAST(paused_at+interval '1 hour',CASE WHEN jsonb_typeof(checkpoint#>'{provider_reconcile_unknown,next_check_ms}')='number'
   THEN to_timestamp((checkpoint#>>'{provider_reconcile_unknown,next_check_ms}')::numeric/1000) ELSE paused_at END) due_at FROM paused)
 SELECT job_id,run_id,owner_user_id,project_id,GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-due_at)::int) overdue_seconds
 FROM eligible WHERE due_at<clock_timestamp()-make_interval(secs=>$1) ORDER BY due_at,job_id LIMIT 100`,[dueGraceSeconds])).rows;
 const handoff=(await pool.query(`SELECT j.id job_id,r.id run_id,r.owner_user_id,r.project_id,j.lease_token,
  GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-j.lease_until)::int) overdue_seconds
  FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
  WHERE j.lease_token IS NOT NULL AND j.lease_until<clock_timestamp()
   AND COALESCE(j.checkpoint#>>'{workflow_v1,pending_disposition,kind}',j.checkpoint#>>'{workflow_pending_disposition_v1,kind}')='handoff'
  ORDER BY j.lease_until,j.id LIMIT 100`)).rows;
 for(const row of due)await raiseAlert(pool,{kind:'provider_due_scan_stale',severity:'critical',scope:row.job_id,bucketSeconds:300,
  detail:{owner_user_id:row.owner_user_id,project_id:row.project_id,run_id:row.run_id,job_id:row.job_id,overdue_seconds:Number(row.overdue_seconds),threshold_seconds:dueGraceSeconds}});
 for(const row of handoff)await raiseAlert(pool,{kind:'workflow_handoff_stale',severity:'critical',scope:row.job_id,bucketSeconds:300,
  detail:{owner_user_id:row.owner_user_id,project_id:row.project_id,run_id:row.run_id,job_id:row.job_id,lease_token_sha256:createHash('sha256').update(row.lease_token).digest('hex'),overdue_seconds:Number(row.overdue_seconds)}});
 return {due_scan_stale:due.length,handoff_stale:handoff.length};
}
