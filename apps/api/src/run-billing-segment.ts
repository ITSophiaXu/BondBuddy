import type { Pool, PoolClient } from 'pg';
import { Problem } from './data.js';
import { assertRunExecution, type RunExecutionIdentity } from './run-execution.js';

type Db = Pool | PoolClient;
export type RunBillingSegment = {
  id: string; owner: string; projectId: string; runId: string;
  reservationId: string; sourceQuoteId: string; points: number; billingPolicy: string;
  execution: RunExecutionIdentity;
};
const unavailable = () => new Problem(503, 'BILLING_NOT_READY', '任务的收费记录暂时无法核对，请稍后重试。');

/** Resolve the current exact execution's immutable liability. Never infer a fee
 * from the run's original pointer when a binding is missing or inconsistent.
 * Mutating callers hold run -> job locks before calling this reader. */
export async function readRunBillingSegment(db: Db, run: any, expected?: RunExecutionIdentity): Promise<RunBillingSegment | null> {
  const identity = await assertRunExecution(db, run, expected);
  const adoption=identity.executionVersion===2?(await db.query(`SELECT * FROM bb_run_supplement_adoptions
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$4
      AND input_revision=$5 AND input_hash=$6`,
  [run.owner_user_id,run.project_id,run.id,identity.executionVersion,identity.inputRevision,identity.inputHash])).rows[0]:null;
  const rows = (await db.query(`SELECT s.*,b.assignment_kind,b.adoption_id AS assignment_adoption_id,c.owner_user_id AS reservation_owner,c.run_id AS reservation_run,
      c.quote_id AS reservation_quote,c.points AS reservation_points,c.billing_policy AS reservation_policy,
      origin.input_revision AS segment_input_revision,origin.input_hash AS segment_input_hash
    FROM bb_run_execution_billing_bindings b
    JOIN bb_run_billing_segments s ON s.id=b.billing_segment_id AND s.owner_user_id=b.owner_user_id
      AND s.project_id=b.project_id AND s.run_id=b.run_id
    JOIN bb_credit_reservations c ON c.id=s.reservation_id AND c.owner_user_id=s.owner_user_id AND c.run_id=s.run_id
    JOIN bb_run_execution_versions origin ON origin.owner_user_id=s.owner_user_id AND origin.project_id=s.project_id
      AND origin.run_id=s.run_id AND origin.execution_version=s.origin_execution_version
    WHERE b.owner_user_id=$1 AND b.project_id=$2 AND b.run_id=$3 AND b.execution_version=$4
      AND b.input_revision=$5 AND b.input_hash=$6`,
  [run.owner_user_id,run.project_id,run.id,identity.executionVersion,identity.inputRevision,identity.inputHash])).rows;
  if (!rows.length) {
    // A paid successor can have a free original run. Only its explicit immutable
    // unbilled assignment can authorize the absence of a current liability.
    if(identity.executionVersion===2&&run.channel==='production'){
      if(!adoption||adoption.assignment_kind!=='unbilled'||Number(adoption.total_points)!==0
        ||adoption.target_billing_segment_id!==null||adoption.source_billing_segment_id!==null
        ||run.reservation_id)throw unavailable();
      return null;
    }
    if (run.reservation_id || ['fixed_credits','metered_credits'].includes(run.billing_mode)) throw unavailable();
    return null;
  }
  const row=rows[0],points=Number(row.points);
  if (rows.length!==1 || row.id!==row.reservation_id
    || row.origin_input_revision!==row.segment_input_revision||row.origin_input_hash?.trim()!==row.segment_input_hash?.trim()
    || row.source_quote_id!==row.reservation_quote || row.billing_policy!==row.reservation_policy
    || points!==Number(row.reservation_points) || !Number.isSafeInteger(points) || points<1
    || !['on_delivery','authoring_progress_v1','authoring_balance_v2'].includes(row.billing_policy)) throw unavailable();
  if(identity.executionVersion===1){
    if(row.reservation_id!==run.reservation_id||!['fixed_credits','metered_credits'].includes(run.billing_mode)
      ||row.assignment_kind!=='original'||row.segment_number!==1||row.origin_execution_version!==1||row.adoption_id!==null||row.assignment_adoption_id!==null
      ||row.origin_input_revision!==identity.inputRevision||row.origin_input_hash.trim()!==identity.inputHash)throw unavailable();
  }else if(identity.executionVersion===2){
    if(run.channel!=='production'||!adoption||adoption.target_billing_segment_id!==row.id
      ||adoption.assignment_kind!==row.assignment_kind||row.assignment_adoption_id!==adoption.id||adoption.source_execution_version!==1
      ||adoption.source_input_revision!==run.input_revision||adoption.source_input_hash?.trim()!==run.input_hash.trim())throw unavailable();
    if(row.assignment_kind==='carry'){
      if(Number(adoption.total_points)!==0||adoption.source_billing_segment_id!==row.id||row.id!==run.reservation_id
        ||row.segment_number!==1||row.origin_execution_version!==1||row.adoption_id!==null)throw unavailable();
    }else if(row.assignment_kind==='rework'){
      if(Number(adoption.total_points)!==points||row.id===run.reservation_id||row.segment_number!==2
        ||row.origin_execution_version!==2||row.origin_input_revision!==identity.inputRevision
        ||row.origin_input_hash.trim()!==identity.inputHash||row.source_quote_id!==adoption.quote_id||row.adoption_id!==adoption.id)throw unavailable();
    }else throw unavailable();
  }else throw unavailable();
  return {id:row.id,owner:run.owner_user_id,projectId:run.project_id,runId:run.id,reservationId:row.reservation_id,
    sourceQuoteId:row.source_quote_id,points,billingPolicy:row.billing_policy,execution:identity};
}
