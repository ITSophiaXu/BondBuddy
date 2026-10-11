import type {Pool, PoolClient} from 'pg';
import type {AuthoringProgress} from '@bondbuddy/contracts';
import {date} from './data.js';
import {creditBalance} from './billing.js';
import {debitAuthoringCredits,DYNAMIC_AUTHORING_POLICY} from './authoring-credit-debit.js';

/** Billing progress is not a claimed document completion percentage. */
export function accruedAuthoringPoints(points:number,activeMs:number,workBps:number):number {
  if(!Number.isSafeInteger(points)||points<0||!Number.isFinite(activeMs)||activeMs<0||!Number.isFinite(workBps)||workBps<0)throw Error('Invalid authoring meter');
  const bps=Math.min(9500,Math.min(2500,workBps)+7000*activeMs/(activeMs+30*60*1000));
  return Math.min(points,Math.floor(points*bps/10000));
}
export function measuredActiveMs(m:{active_ms:number|string;clock_at:Date|string;lease_until:Date|string|null},now:Date):number {
  const delta=m.lease_until?Math.max(0,Math.min(now.getTime(),new Date(m.lease_until).getTime())-new Date(m.clock_at).getTime()):0;
  return Math.floor(Number(m.active_ms)+delta);
}
const milestones:Record<string,number>={input_lock:100,materials_ready:400,model_generation:2000,word_delivery_pair:2500};
/** Caller holds the run lock. Intervals are bounded by the last confirmed worker lease.
 * Persist before terminal UPDATE so SQL settlement uses the same amount as the UI. */
export async function syncAuthoringProgress(c:PoolClient,r:any,next?:{state:string;stage:string|null;reason:string}) {
  if(!['update','generation'].includes(r.task_kind))return;
  const j=(await c.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2',[r.id,r.owner_user_id])).rows[0];
  if(!j||String(j.subtype).startsWith('m4_'))return;
  await c.query('INSERT INTO bb_authoring_progress(run_id,owner_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.id,r.owner_user_id]);
  const m=(await c.query('SELECT *,clock_timestamp() AS sampled_at FROM bb_authoring_progress WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[r.id,r.owner_user_id])).rows[0];
  const active=measuredActiveMs(m,new Date(m.sampled_at));
  // Completing an in-flight operation after pause cannot increase the frozen bill.
  const work=Math.max(m.work_bps,!j.user_pause_requested&&!j.credit_pause_requested&&(next?.reason==='checkpoint_saved'||next?.reason==='stage_completed')?(milestones[next.stage??'']??0):0);
  const reservation=r.reservation_id?(await c.query('SELECT points,billing_policy FROM bb_credit_reservations WHERE id=$1 AND owner_user_id=$2',[r.reservation_id,r.owner_user_id])).rows[0]:null;
  const price=Number(reservation?.points??0),calculated=accruedAuthoringPoints(price,active,work);
  // An exhausted sample may cross the zero point. Discard that unfunded excess;
  // topping up must not collect it while the saved task is still queued.
  const amount=reservation?.billing_policy===DYNAMIC_AUTHORING_POLICY
    ? Math.min(price,Number(m.accrued_points)+Math.max(0,calculated-accruedAuthoringPoints(price,Number(m.active_ms),Number(m.work_bps))))
    : Math.max(Number(m.accrued_points),calculated);
  const debit=reservation?.billing_policy===DYNAMIC_AUTHORING_POLICY
    ? await debitAuthoringCredits(c,r,j.credit_pause_requested?Number(m.accrued_points):amount) : null;
  const exhausted=!!debit && debit.available===0 && debit.charged<debit.ceiling;
  // Freeze the meter immediately; the worker saves its current operation before releasing its lease.
  if(exhausted && !j.credit_pause_requested && !['failed','cancelled','rejected'].includes(next?.state??r.state))
    await c.query('UPDATE bb_jobs SET credit_pause_requested=true WHERE id=$1',[j.id]);
  const running=(next?.state??r.state)==='running'&&j.state==='running'&&!j.user_pause_requested&&!j.credit_pause_requested&&!exhausted;
  await c.query('UPDATE bb_authoring_progress SET active_ms=$2,work_bps=$3,accrued_points=$4,clock_at=$6,lease_until=$5 WHERE run_id=$1',
    [r.id,active,work,debit?.charged??amount,running?j.lease_until:null,m.sampled_at]);
}
export async function readAuthoringProgress(db:Pool|PoolClient,owner:string,runId:string):Promise<AuthoringProgress|undefined>{
  const row=(await db.query(`SELECT r.state,j.state AS job_state,j.created_at AS queued_at,j.user_pause_requested,j.credit_pause_requested,
    m.active_ms,m.work_bps,m.accrued_points,m.clock_at,m.lease_until,m.last_activity_at,
    c.billing_policy,c.points,c.state AS charge_state,c.charged_points,now() AS sampled_at,
    CASE WHEN r.state='queued' THEN (SELECT count(*)::int FROM bb_jobs ahead
      WHERE ahead.job_type=j.job_type AND ahead.state='queued' AND (ahead.created_at,ahead.id)<(j.created_at,j.id)) ELSE NULL END AS queue_ahead
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
    LEFT JOIN bb_authoring_progress m ON m.run_id=r.id AND m.owner_user_id=r.owner_user_id
    LEFT JOIN bb_credit_reservations c ON c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id
    WHERE r.id=$1 AND r.owner_user_id=$2 AND r.task_kind IN ('update','generation') AND j.subtype NOT LIKE 'm4_%'`,[runId,owner])).rows[0];
  if(!row)return undefined;
  const active=row.clock_at?measuredActiveMs(row,new Date(row.sampled_at)):0,points=Number(row.points??0);
  const terminal=['succeeded','test_completed','failed','cancelled','rejected'].includes(row.state);
  const charged=row.billing_policy===DYNAMIC_AUTHORING_POLICY&&['failed','rejected'].includes(row.state)?0:Number(row.charged_points??(row.charge_state==='settled'?points:0));
  const dynamic=row.billing_policy===DYNAMIC_AUTHORING_POLICY;
  return {...(dynamic?{credit_exhausted:row.credit_pause_requested,available_points:(await creditBalance(db,owner)).available}:{}),policy:row.billing_policy??'on_delivery',active_ms:active,
    accrued_points:terminal||dynamic?charged:Math.max(Number(row.accrued_points??0),accruedAuthoringPoints(points,active,Number(row.work_bps??0))),
    charged_points:charged,released_points:!dynamic&&row.charge_state&&row.charge_state!=='held'?points-charged:0,
    pause_requested:row.user_pause_requested,queued_at:date(row.queued_at),sampled_at:date(row.sampled_at),
    last_activity_at:row.last_activity_at?date(row.last_activity_at):null,queue_ahead:row.queue_ahead,
    clock_running:!terminal&&row.state==='running'&&!row.user_pause_requested&&!row.credit_pause_requested&&!!row.lease_until&&new Date(row.lease_until)>new Date(row.sampled_at)};
}
