import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { grantCredits, lockCreditAccount, publishPrices } from './billing.js';
import { missing, Problem, transaction } from './data.js';

/** Correct an erroneous settled charge by an appended credit, never changing history. */
export async function correctSettlement(pool:Pool,input:{runId:string;reservationId?:string;actor:string;reason:string}){
  if(!input.actor?.trim()||!input.reason?.trim()||input.reservationId!==undefined&&
    (typeof input.reservationId!=='string'||input.reservationId.length<1||input.reservationId.length>128))
    throw new Problem(422,'VALIDATION_FAILED','Actor, correction reason and a valid reservation selection required');
  return transaction(pool,async c=>{
    const run=(await c.query('SELECT owner_user_id FROM bb_runs WHERE id=$1',[input.runId])).rows[0];if(!run)throw missing();
    await lockCreditAccount(c,run.owner_user_id);
    // Select under the same account lock as fee creation. A run-only request
    // remains compatible only while it identifies exactly one reservation.
    const rows=(await c.query(`SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2
      AND ($3::text IS NULL OR id=$3) ORDER BY id FOR UPDATE`,[run.owner_user_id,input.runId,input.reservationId??null])).rows;
    if(!rows.length)throw missing();
    if(rows.length!==1)throw new Problem(409,'VALIDATION_FAILED','Specify the reservation to correct for this task');
    const r=rows[0];
    if(r.state!=='settled')throw new Problem(409,'VALIDATION_FAILED','Only an existing settled charge can be corrected');
    const allocations=(await c.query('SELECT COALESCE(a.charged_points,a.points) AS points,l.id,l.source,l.expires_at FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id WHERE a.reservation_id=$1 AND COALESCE(a.charged_points,a.points)>0 ORDER BY l.id',[r.id])).rows;
    const lots:string[]=[];
    for(const a of allocations){
      const key=`settlement-correction:${r.id}:${a.id}`;
      const existing=(await c.query('SELECT expires_at FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2',[r.owner_user_id,key])).rows[0];
      const expiry=existing?existing.expires_at:a.expires_at&&new Date(a.expires_at).getTime()<=Date.now()?new Date(Date.now()+7*86400000):a.expires_at;
      lots.push(await grantCredits(c,{owner:r.owner_user_id,source:a.source==='purchase'?'purchase':'correction',key,points:Number(a.points),expiresAt:expiry?new Date(expiry).toISOString():null,
        actor:input.actor,reason:input.reason,reservationId:r.id,runId:r.run_id}));
    }
    return lots;
  });
}
export async function auditCredits(pool:Pool){
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const lotDrift=(await c.query(`WITH allocations AS (
      SELECT a.*,r.state,r.billing_policy,EXISTS(SELECT 1 FROM bb_credit_lots compensation
        WHERE compensation.source_key='failure:'||r.id||':'||a.lot_id AND compensation.owner_user_id=r.owner_user_id) AS compensated
      FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id)
      SELECT l.id,l.owner_user_id,l.remaining::text,l.frozen::text,
        COALESCE(sum(a.points) FILTER(WHERE a.state='held' AND a.billing_policy<>'authoring_balance_v2'),0)::text AS expected_frozen,
        (l.original_points-COALESCE(sum(CASE WHEN a.compensated THEN a.points ELSE COALESCE(a.charged_points,CASE WHEN a.state='settled' THEN a.points ELSE 0 END) END),0))::text AS expected_remaining
      FROM bb_credit_lots l LEFT JOIN allocations a ON a.lot_id=l.id
      GROUP BY l.id HAVING l.frozen<>COALESCE(sum(a.points) FILTER(WHERE a.state='held' AND a.billing_policy<>'authoring_balance_v2'),0)
      OR l.remaining<>l.original_points-COALESCE(sum(CASE WHEN a.compensated THEN a.points ELSE COALESCE(a.charged_points,CASE WHEN a.state='settled' THEN a.points ELSE 0 END) END),0)`)).rows;
    const reservationDrift=(await c.query(`SELECT r.id,r.run_id,r.state,r.points::text FROM bb_credit_reservations r
      LEFT JOIN bb_runs run ON run.id=r.run_id
      LEFT JOIN bb_run_billing_segments s ON s.reservation_id=r.id
      LEFT JOIN bb_run_execution_versions origin ON origin.owner_user_id=r.owner_user_id AND origin.run_id=r.run_id AND origin.execution_version=1
      LEFT JOIN bb_run_execution_billing_bindings b ON b.owner_user_id=r.owner_user_id AND b.run_id=r.run_id AND b.execution_version=1
      LEFT JOIN bb_run_billing_progress m ON m.billing_segment_id=s.id
      LEFT JOIN bb_authoring_progress legacy ON legacy.owner_user_id=r.owner_user_id AND legacy.run_id=r.run_id
      LEFT JOIN LATERAL (SELECT count(*) AS matches,min(price.points) AS points FROM (
        SELECT owner_user_id,id,points FROM bb_credit_quotes
        UNION ALL SELECT owner_user_id,id,reserve_points AS points FROM bb_m4_quotes
        UNION ALL SELECT owner_user_id,id,points FROM bb_project_file_update_quotes
        UNION ALL SELECT owner_user_id,id,points FROM bb_integrity_quotes
        UNION ALL SELECT owner_user_id,id,points FROM bb_project_qa_quotes
      ) price WHERE price.owner_user_id=r.owner_user_id AND price.id=r.quote_id) source ON true
      WHERE source.matches<>1 OR r.points IS DISTINCT FROM source.points
      OR r.owner_user_id IS DISTINCT FROM run.owner_user_id OR run.reservation_id IS DISTINCT FROM r.id
      OR s.id IS DISTINCT FROM r.id OR s.reservation_id IS DISTINCT FROM r.id
      OR s.owner_user_id IS DISTINCT FROM r.owner_user_id OR s.project_id IS DISTINCT FROM run.project_id OR s.run_id IS DISTINCT FROM r.run_id
      OR s.segment_number IS DISTINCT FROM 1 OR s.origin_execution_version IS DISTINCT FROM 1
      OR s.origin_input_revision IS DISTINCT FROM run.input_revision OR s.origin_input_hash IS DISTINCT FROM run.input_hash
      OR s.source_quote_id IS DISTINCT FROM r.quote_id OR s.billing_policy IS DISTINCT FROM r.billing_policy
      OR s.points IS DISTINCT FROM r.points OR s.created_at IS DISTINCT FROM r.created_at
      OR origin.project_id IS DISTINCT FROM s.project_id OR origin.input_revision IS DISTINCT FROM s.origin_input_revision
      OR origin.input_hash IS DISTINCT FROM s.origin_input_hash
      OR b.project_id IS DISTINCT FROM s.project_id OR b.input_revision IS DISTINCT FROM s.origin_input_revision
      OR b.input_hash IS DISTINCT FROM s.origin_input_hash OR b.billing_segment_id IS DISTINCT FROM s.id
      OR b.assignment_kind IS DISTINCT FROM 'original' OR b.created_at IS DISTINCT FROM s.created_at
      OR m.billing_segment_id IS DISTINCT FROM s.id OR m.owner_user_id IS DISTINCT FROM s.owner_user_id
      OR m.project_id IS DISTINCT FROM s.project_id OR m.run_id IS DISTINCT FROM s.run_id
      OR ROW(legacy.active_ms,legacy.work_bps,legacy.accrued_points,legacy.clock_at,legacy.lease_until,legacy.last_activity_at)
        IS DISTINCT FROM ROW(m.active_ms,m.work_bps,m.accrued_points,m.clock_at,m.lease_until,m.last_activity_at)
      OR (r.billing_policy<>'authoring_balance_v2' AND (r.points<>(SELECT COALESCE(sum(points),0) FROM bb_credit_allocations WHERE reservation_id=r.id)
      OR NOT EXISTS(SELECT 1 FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='reserve' AND e.points=r.points)
      OR (r.state<>'held' AND (r.points<>(SELECT COALESCE(sum(e.points),0) FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind IN ('settle','release')) OR COALESCE(r.charged_points,CASE WHEN r.state='settled' THEN r.points ELSE 0 END)<>(SELECT COALESCE(sum(e.points),0) FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='settle')))))
      OR (r.billing_policy='authoring_balance_v2' AND (
        COALESCE(r.charged_points,0)<>(SELECT COALESCE(sum(points),0) FROM bb_credit_allocations WHERE reservation_id=r.id)
        OR COALESCE(r.charged_points,0)<>(SELECT COALESCE(sum(points),0) FROM bb_credit_events WHERE reservation_id=r.id AND kind='settle')
        OR EXISTS(SELECT 1 FROM bb_credit_events WHERE reservation_id=r.id AND kind IN ('reserve','release'))))`)).rows;
    const paymentDrift=(await c.query(`SELECT o.id,o.state FROM bb_recharge_orders o LEFT JOIN bb_credit_lots l
      ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
      WHERE (o.state='paid' AND (l.id IS NULL OR l.original_points<>o.points OR l.source<>'purchase' OR l.expires_at IS NOT NULL))
      OR (o.state<>'paid' AND l.id IS NOT NULL)`)).rows;
    const heldTasks=(await c.query(`SELECT r.run_id,r.points::text,run.state,run.stage,r.created_at FROM bb_credit_reservations r
      JOIN bb_runs run ON run.id=r.run_id WHERE r.state='held' AND r.created_at<now()-interval '24 hours'`)).rows;
    return {consistent:![lotDrift,reservationDrift,paymentDrift].some(v=>v.length),lotDrift,reservationDrift,paymentDrift,heldTasks};
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{
    if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
    const [command,file]=process.argv.slice(2),input=file?JSON.parse(readFileSync(file,'utf8')):null;
    if(command==='prices')await publishPrices(pool,input);
    else if(command==='correct-settlement')process.stdout.write(JSON.stringify({credit_lot_id:await correctSettlement(pool,input)})+'\n');
    else if(command==='audit'){
      const report=await auditCredits(pool);process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.consistent)process.exitCode=1;
    }else if(command==='import-verified-right'){
      if(!input?.source_receipt||!['purchase','existing_grant'].includes(input.source))throw Error('Verified source receipt and original right type required; never import demo balances');
      await transaction(pool,c=>grantCredits(c,{...input,key:`legacy:${input.source_receipt}`,reason:`preserve_verified_right:${input.source_receipt}; ${input.reason}`}));
    }else throw Error('Use prices FILE, audit, correct-settlement FILE or import-verified-right FILE');
    if(command!=='audit')process.stdout.write('Applied idempotently; no run was started.\n');
  }finally{await pool.end();}
}
