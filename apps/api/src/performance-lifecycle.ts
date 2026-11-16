import type {Pool} from 'pg';
import {transaction} from './data.js';
import type {LogRetentionPolicy} from './log-ops.js';
/** Span details expire; immutable session counters and an explicit purge receipt remain. */
export async function purgePerformanceSpans(pool:Pool,policy:LogRetentionPolicy):Promise<{sessions:number;spans:number}> {
 const now=policy.now?.()??new Date(),days=policy.contentRetentionDays,deletedDays=policy.deletedProjectPurgeDays,batch=policy.batchSize??100;
 const version=policy.policyVersion??'log_retention_v1';
 if(!Number.isInteger(days)||days<1||!Number.isInteger(batch)||batch<1||batch>10000||!Number.isFinite(now.getTime())||
   deletedDays!==undefined&&(!Number.isInteger(deletedDays)||deletedDays<0)||!/^[A-Za-z0-9_.:-]{1,128}$/.test(version))throw new Error('Invalid performance retention policy');
 const cutoff=new Date(now.getTime()-days*86400000),deletedCutoff=deletedDays===undefined?null:new Date(now.getTime()-deletedDays*86400000);
 return transaction(pool,async c=>{
  // Serialize with the existing legal-hold set/release operations.
  await c.query('SELECT pg_advisory_xact_lock(79,69)');
  const rows=(await c.query(`SELECT s.session_id,
   CASE WHEN u.status='closed' OR p.deleted_at<$4 OR scope_project.deleted_at<$4 THEN 'user_deleted' ELSE 'retention_expired' END reason
   FROM bb_performance_sessions s JOIN bb_runs r ON r.owner_user_id=s.owner_user_id AND r.id=s.run_id
   JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
   JOIN bb_projects scope_project ON scope_project.owner_user_id=p.owner_user_id AND scope_project.id=coalesce(p.execution_scope_project_id,p.id)
   JOIN bb_users u ON u.id=s.owner_user_id
   WHERE s.purged_at IS NULL AND r.state IN ('succeeded','test_completed','failed','cancelled','rejected')
   AND (s.started_at<$1 OR u.status='closed' OR p.deleted_at<$4 OR scope_project.deleted_at<$4)
   AND ($3::text[] IS NULL OR s.owner_user_id=ANY($3))
   AND NOT EXISTS(SELECT 1 FROM bb_log_archive_legal_holds h WHERE h.released_at IS NULL AND h.segment_id IS NULL
    AND (h.user_id IS NULL OR h.user_id=s.owner_user_id)
    AND (h.from_at IS NULL OR h.from_at<=greatest(s.ended_at,s.last_flush_at,s.started_at,(SELECT max(p.ended_at) FROM bb_performance_spans p WHERE p.session_id=s.session_id)))
    AND (h.to_at IS NULL OR h.to_at>=least(s.started_at,(SELECT min(p.started_at) FROM bb_performance_spans p WHERE p.session_id=s.session_id))))
   ORDER BY s.started_at,s.session_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,[cutoff,batch,policy.ownerScope??null,deletedCutoff])).rows;
  let spans=0;
  for(const row of rows){
   const deleted=await c.query('DELETE FROM bb_performance_spans WHERE session_id=$1',[row.session_id]),count=deleted.rowCount??0;
   await c.query('UPDATE bb_performance_sessions SET purged_at=$2,purged_span_count=$3,purge_reason=$4,purge_policy_version=$5,complete=false WHERE session_id=$1',[row.session_id,now,count,row.reason,version]);
   spans+=count;
  }
  return {sessions:rows.length,spans};
 });
}
