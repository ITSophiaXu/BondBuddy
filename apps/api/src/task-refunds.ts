import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {Value} from '@sinclair/typebox/value';
import {taskRefundSchemas,type TaskRefundCreate,type TaskRefundDecision,type TaskRefundRecord,type TaskRefundEligibility,type TaskRefundAdminList} from '@bondbuddy/contracts';
import {lockCreditAccount,assertCreditIssuanceFits} from './billing.js';
import {requireBillingPermission} from './billing-permissions.js';
import {transaction,uid,digest,date,Problem,missing} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';

const invalid=()=>new Problem(422,'VALIDATION_FAILED','请选择本任务原已结算条目并填写售后原因。');
const changed=()=>new Problem(409,'IDEMPOTENCY_CONFLICT','原申请或条目状态已变化，请刷新原申请。');
const evidence=()=>new Problem(409,'DATA_UNAVAILABLE','原任务扣费与交付证据需要核实，暂未返还积分。');
const exact=(v:unknown):bigint=>{
  const s=typeof v==='bigint'?String(v):typeof v==='string'?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):'';
  if(!/^(0|[1-9][0-9]*)$/.test(s)||BigInt(s)>9223372036854775807n)throw evidence();return BigInt(s);
};
const sum=(rows:any[],field:string)=>rows.reduce((n,row)=>n+exact(row[field]),0n);
const hash=(run:string,input:TaskRefundCreate|TaskRefundDecision)=>inputManifestHash({run,item_ids:[...input.item_ids].sort(),reason:input.reason.trim()});
type Reservation={id:string;run_id:string;owner_user_id:string;state:string;run_state:string;points:string;charged_points:string|null};

async function reservation(c:PoolClient,owner:string,run:string):Promise<Reservation>{
  const row=(await c.query(`SELECT r.*,b.state run_state FROM bb_credit_reservations r JOIN bb_runs b ON b.id=r.run_id AND b.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.run_id=$2`,[owner,run])).rows[0];if(!row)throw missing();
  await lockCreditAccount(c,owner);
  const locked=(await c.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,row.id])).rows[0];
  return{...row,...locked};
}
async function wholeCorrected(c:PoolClient,r:Reservation){
  return !!(await c.query(`SELECT 1 FROM bb_credit_events e WHERE e.owner_user_id=$1 AND e.reservation_id=$2 AND e.kind='correction'
    AND NOT EXISTS(SELECT 1 FROM bb_task_refund_credits t WHERE t.owner_user_id=e.owner_user_id AND t.return_lot_id=e.lot_id) LIMIT 1`,[r.owner_user_id,r.id])).rowCount;
}
/** Before 0147 there was no per-item lot evidence. Do not manufacture it later. */
async function legacyUnit(c:PoolClient,r:Reservation){
  if((await c.query('SELECT 1 FROM bb_task_refund_units WHERE reservation_id=$1',[r.id])).rowCount)return;
  const charged=exact(r.charged_points??r.points);if(!charged)return;
  const allocations=(await c.query('SELECT lot_id,COALESCE(charged_points,points)::text points FROM bb_credit_allocations WHERE reservation_id=$1 AND COALESCE(charged_points,points)>0',[r.id])).rows;
  if(sum(allocations,'points')!==charged)throw evidence();
  const item='legacy-'+digest(r.id).slice(0,32);
  await c.query(`INSERT INTO bb_task_refund_units(owner_user_id,reservation_id,item_id,run_id,ordinal,source_item_key,label,points,evidence_kind,evidence)
    VALUES($1,$2,$3,$4,0,'legacy-task','历史原任务整体成果（原账单无独立分配）',$5,'legacy_task',$6)`,
    [r.owner_user_id,r.id,item,r.run_id,String(charged),{capture:'historical_whole_task',reason:'No original independent item allocation exists; exact original lot allocations retained.'}]);
  for(const a of allocations)await c.query('INSERT INTO bb_task_refund_unit_slices VALUES($1,$2,$3,$4)',[r.id,item,a.lot_id,a.points]);
}
async function rawUnits(c:PoolClient,r:Reservation){
  return(await c.query(`SELECT u.*,
    EXISTS(SELECT 1 FROM bb_task_refund_returned_items x WHERE x.reservation_id=u.reservation_id AND x.item_id=u.item_id) AS returned,
    EXISTS(SELECT 1 FROM bb_task_refund_request_items i WHERE i.reservation_id=u.reservation_id AND i.item_id=u.item_id
      AND NOT EXISTS(SELECT 1 FROM bb_task_refund_decisions d WHERE d.request_id=i.request_id)) AS pending,
    s.action FROM bb_task_refund_units u LEFT JOIN bb_scope_quotations s ON s.id=u.scope_quote_id AND s.owner_user_id=u.owner_user_id
    WHERE u.reservation_id=$1 ORDER BY u.ordinal`,[r.id])).rows;
}
/** Successful batch delivery is checked against its actual independent results. */
async function deliveredKeys(c:PoolClient,r:Reservation,units:any[]):Promise<Set<string>|null>{
  if(units.some(u=>u.action==='project_qa_answer')){
    const q=(await c.query('SELECT result,result_hash FROM bb_project_qa_runs WHERE owner_user_id=$1 AND run_id=$2 AND operation=$3',[r.owner_user_id,r.run_id,'answer'])).rows[0];
    if(!q?.result||inputManifestHash(q.result)!==q.result_hash?.trim())throw evidence();
    return new Set((q.result.answers??[]).map((a:any)=>a.question_id));
  }
  if(units.some(u=>u.action==='project_file_check')){
    const q=(await c.query('SELECT result,result_hash FROM bb_project_file_operations WHERE owner_user_id=$1 AND run_id=$2 AND operation=$3',[r.owner_user_id,r.run_id,'check'])).rows[0];
    if(!q?.result||inputManifestHash(q.result)!==q.result_hash?.trim())throw evidence();
    return new Set((q.result.files??[]).map((a:any)=>a.file_version_id));
  }
  return null;
}
export async function readTaskRefundRecord(c:PoolClient,id:string,owner?:string):Promise<TaskRefundRecord>{
  const r=(await c.query(`SELECT r.*,d.created_at decided_at,d.reason decision_reason FROM bb_task_refund_requests r
    LEFT JOIN bb_task_refund_decisions d ON d.request_id=r.id WHERE r.id=$1 AND ($2::text IS NULL OR r.owner_user_id=$2)`,[id,owner??null])).rows[0];if(!r)throw missing();
  const items=(await c.query(`SELECT u.item_id,u.label,u.points::text,EXISTS(SELECT 1 FROM bb_task_refund_returned_items x
    WHERE x.request_id=i.request_id AND x.item_id=i.item_id) approved FROM bb_task_refund_request_items i
    JOIN bb_task_refund_units u USING(reservation_id,item_id) WHERE i.request_id=$1 ORDER BY u.ordinal`,[id])).rows;
  const refunded=sum(items.filter(i=>i.approved),'points'),requested=sum(items,'points');
  return{refund_request_id:r.id,request_id:r.request_id,run_id:r.run_id,reason:r.reason,created_at:date(r.created_at),decided_at:r.decided_at?date(r.decided_at):null,
    decision_reason:r.decision_reason??null,state:!r.decided_at?'requested':refunded===0n?'rejected':refunded===requested?'approved':'partially_approved',
    requested_points:String(requested),refunded_points:String(refunded),items};
}
async function eligibility(c:PoolClient,r:Reservation):Promise<TaskRefundEligibility>{
  const settled=r.state==='settled'&&r.run_state==='succeeded',charged=r.state==='settled'?exact(r.charged_points??r.points):0n;
  if(settled)await legacyUnit(c,r);
  const rows=await rawUnits(c,r),old=await wholeCorrected(c,r);
  const returned=await c.query("SELECT COALESCE(sum(points),0)::text n FROM bb_credit_events WHERE owner_user_id=$1 AND reservation_id=$2 AND kind='correction'",[r.owner_user_id,r.id]);
  const requests=await c.query('SELECT id FROM bb_task_refund_requests WHERE owner_user_id=$1 AND run_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200',[r.owner_user_id,r.run_id]);
  let reason='',keys:Set<string>|null=null;
  if(settled)try{keys=await deliveredKeys(c,r,rows);}catch{reason='独立条目的原交付证据需要核实，请联系售后并保留任务编号。';}
  const units=rows.map(u=>{const valid=settled&&!reason&&!old&&!u.returned&&(!keys||keys.has(u.source_item_key));return{
    item_id:u.item_id,source_item_key:u.source_item_key,label:u.label,charged_points:String(exact(u.points)),
    refunded_points:old||u.returned?String(exact(u.points)):'0',available_points:valid&&!u.pending?String(exact(u.points)):'0',pending:u.pending,evidence_kind:u.evidence_kind,
  };});
  const enabled=units.some(u=>exact(u.available_points)>0n);
  const records:TaskRefundRecord[]=[];for(const request of requests.rows)records.push(await readTaskRefundRecord(c,request.id,r.owner_user_id));
  return{run_id:r.run_id,reservation_id:r.id,enabled,reason:reason||(enabled?'选择存在质量问题的原已结算条目；核实通过后返还原来源积分，不发起现金退款。':!settled?'任务成功交付并结算后可申请质量售后。':'已无可申请条目；可查看原申请进度。'),
    charged_points:String(charged),refunded_points:String(exact(returned.rows[0].n)),units,requests:records};
}
export async function taskRefundEligibility(pool:Pool,owner:string,run:string){return transaction(pool,async c=>eligibility(c,await reservation(c,owner,run)));}

export async function createTaskRefund(pool:Pool,owner:string,run:string,input:TaskRefundCreate):Promise<TaskRefundRecord>{
  if(!Value.Check(taskRefundSchemas.TaskRefundCreateRequest,input)||!input.reason.trim())throw invalid();
  return transaction(pool,async c=>{
    const r=await reservation(c,owner,run),fingerprint=hash(run,input);
    const prior=(await c.query('SELECT id,request_hash FROM bb_task_refund_requests WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
    if(prior){if(prior.request_hash.trim()!==fingerprint)throw changed();return readTaskRefundRecord(c,prior.id,owner);}
    const e=await eligibility(c,r),selected=e.units.filter(u=>input.item_ids.includes(u.item_id));
    if(selected.length!==input.item_ids.length||selected.some(u=>exact(u.available_points)===0n))throw changed();
    const id=uid();await c.query(`INSERT INTO bb_task_refund_requests(id,owner_user_id,run_id,reservation_id,request_id,request_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,owner,run,r.id,input.request_id,fingerprint,input.reason.trim()]);
    for(const item of selected)await c.query('INSERT INTO bb_task_refund_request_items VALUES($1,$2,$3)',[id,r.id,item.item_id]);
    return readTaskRefundRecord(c,id,owner);
  });
}

/** Approval, original-source grants and correction events commit as one fact. */
export async function decideTaskRefund(pool:Pool,actor:string,id:string,input:TaskRefundDecision):Promise<TaskRefundRecord>{
  if(!Value.Check(taskRefundSchemas.TaskRefundDecisionRequest,input)||!input.reason.trim())throw invalid();
  return transaction(pool,async c=>{
    const grant=await requireBillingPermission(c,actor,'task_refund_approve');
    const request=(await c.query('SELECT * FROM bb_task_refund_requests WHERE id=$1',[id])).rows[0];if(!request||request.owner_user_id===actor)throw missing();
    const r=await reservation(c,request.owner_user_id,request.run_id),fingerprint=hash(id,input);
    const prior=(await c.query('SELECT * FROM bb_task_refund_decisions WHERE request_id=$1 OR (actor=$2 AND decision_id=$3)',[id,actor,input.request_id])).rows[0];
    if(prior){if(prior.request_id!==id||prior.actor!==actor||prior.decision_id!==input.request_id||prior.request_hash.trim()!==fingerprint)throw changed();return readTaskRefundRecord(c,id);}
    const original=await readTaskRefundRecord(c,id),wanted=new Set(input.item_ids),units=await rawUnits(c,r),keys=wanted.size?await deliveredKeys(c,r,units):null;
    const selected=units.filter(u=>wanted.has(u.item_id));
    if(selected.length!==wanted.size||selected.some(u=>!original.items.some(i=>i.item_id===u.item_id)||u.returned)||selected.length&&(r.state!=='settled'||r.run_state!=='succeeded'||await wholeCorrected(c,r)||selected.some(u=>keys&&!keys.has(u.source_item_key))))throw changed();
    // Check every selected return as one issuance while holding the same account
    // lock as recharges. Overflow leaves the decision and all original rights pending.
    if(selected.length)await assertCreditIssuanceFits(c,r.owner_user_id,sum(selected,'points'));
    await c.query('INSERT INTO bb_task_refund_decisions(request_id,decision_id,actor,permission_grant_id,request_hash,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,input.request_id,actor,grant,fingerprint,input.reason.trim()]);
    for(const unit of selected){
      await c.query('INSERT INTO bb_task_refund_returned_items VALUES($1,$2,$3)',[r.id,unit.item_id,id]);
      const slices=(await c.query(`SELECT s.*,l.source,l.expires_at FROM bb_task_refund_unit_slices s JOIN bb_credit_lots l ON l.id=s.origin_lot_id
        WHERE s.reservation_id=$1 AND s.item_id=$2 ORDER BY l.id FOR UPDATE OF l`,[r.id,unit.item_id])).rows;
      if(sum(slices,'points')!==exact(unit.points))throw evidence();
      for(const slice of slices){
        const credit=uid(),lot=uid(),amount=String(exact(slice.points)),source=slice.source==='purchase'?'purchase':slice.source==='subscription'?'subscription':'correction';
        // Platform quality return: preserve permanent cash rights; an expiring
        // lot receives at least seven usable days, including near-expiry grants.
        const expires=slice.expires_at?new Date(Math.max(new Date(slice.expires_at).getTime(),Date.now()+7*86400000)).toISOString():null;
        await c.query('INSERT INTO bb_task_refund_credits(id,owner_user_id,reservation_id,item_id,origin_lot_id,points,return_lot_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[credit,r.owner_user_id,r.id,unit.item_id,slice.origin_lot_id,amount,lot]);
        await c.query('INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at) VALUES($1,$2,$3,$4,$5,$5,$6)',[lot,r.owner_user_id,source,'task-refund:'+credit,amount,expires]);
        await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,lot_id,run_id,actor,reason)
          VALUES($1,$2,$3,'correction',$4,$5,$6,$7,$8,$9)`,[uid(),r.owner_user_id,'task-refund:'+credit,amount,r.id,lot,r.run_id,actor,input.reason.trim()]);
      }
    }
    return readTaskRefundRecord(c,id);
  });
}
export async function listTaskRefunds(pool:Pool,actor:string,query:{cursor?:string;state?:TaskRefundRecord['state']}={}):Promise<TaskRefundAdminList>{
  return transaction(pool,async c=>{
    await requireBillingPermission(c,actor,'task_refund_approve');
    const cursor=query.cursor?(await c.query('SELECT created_at,id FROM bb_task_refund_requests WHERE id=$1',[query.cursor])).rows[0]:null;
    if(query.cursor&&!cursor)throw invalid();
    const rows=(await c.query(`SELECT r.id FROM bb_task_refund_requests r LEFT JOIN bb_task_refund_decisions d ON d.request_id=r.id
      WHERE ($1::timestamptz IS NULL OR (r.created_at,r.id)<($1::timestamptz,$2::text))
      AND ($3::text IS NULL OR CASE WHEN d.request_id IS NULL THEN 'requested'
       WHEN NOT EXISTS(SELECT 1 FROM bb_task_refund_returned_items x WHERE x.request_id=r.id) THEN 'rejected'
       WHEN (SELECT count(*) FROM bb_task_refund_returned_items x WHERE x.request_id=r.id)=(SELECT count(*) FROM bb_task_refund_request_items x WHERE x.request_id=r.id) THEN 'approved' ELSE 'partially_approved' END=$3)
      ORDER BY r.created_at DESC,r.id DESC LIMIT 101`,[cursor?.created_at??null,cursor?.id??null,query.state??null])).rows;
    const items:TaskRefundRecord[]=[];for(const row of rows.slice(0,100))items.push(await readTaskRefundRecord(c,row.id));
    return{items,next_cursor:rows.length>100?rows[99].id:null};
  });
}
export function installTaskRefunds(app:FastifyInstance,deps:{db:()=>Pool;owner:(request:FastifyRequest)=>Promise<string>}){
  const run=(r:FastifyRequest)=>(r.params as {run_id:string}).run_id,id=(r:FastifyRequest)=>(r.params as {request_id:string}).request_id;
  app.get('/api/v1/tasks/:run_id/refund-eligibility',{schema:{response:{200:taskRefundSchemas.TaskRefundEligibilityResponse}}},async(r,reply)=>{reply.header('cache-control','private, no-store');const owner=await deps.owner(r);return taskRefundEligibility(deps.db(),owner,run(r));});
  app.post('/api/v1/tasks/:run_id/refund-requests',{schema:{body:taskRefundSchemas.TaskRefundCreateRequest,response:{200:taskRefundSchemas.TaskRefundRecordResponse}}},async r=>{const owner=await deps.owner(r);return createTaskRefund(deps.db(),owner,run(r),r.body as TaskRefundCreate);});
  app.get('/api/v1/admin/task-refunds',{schema:{querystring:taskRefundSchemas.TaskRefundAdminQuery,response:{200:taskRefundSchemas.TaskRefundAdminListResponse}}},async(r,reply)=>{reply.header('cache-control','private, no-store');const owner=await deps.owner(r);return listTaskRefunds(deps.db(),owner,r.query as any);});
  app.get('/api/v1/admin/task-refunds/:request_id',{schema:{response:{200:taskRefundSchemas.TaskRefundRecordResponse}}},async(r,reply)=>{reply.header('cache-control','private, no-store');const actor=await deps.owner(r);return transaction(deps.db(),async c=>{await requireBillingPermission(c,actor,'task_refund_approve');return readTaskRefundRecord(c,id(r));});});
  app.post('/api/v1/admin/task-refunds/:request_id/approve',{schema:{body:taskRefundSchemas.TaskRefundDecisionRequest,response:{200:taskRefundSchemas.TaskRefundRecordResponse}}},async r=>{const owner=await deps.owner(r);return decideTaskRefund(deps.db(),owner,id(r),r.body as TaskRefundDecision);});
}
