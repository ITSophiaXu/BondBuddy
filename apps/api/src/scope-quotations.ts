import type {Pool,PoolClient} from 'pg';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Value} from '@sinclair/typebox/value';
import {OUTCOME_PRICE_VERSION,ScopeLineSchema,OutcomeWorkPlanSchema,calculateOutcomePrice,type OutcomeWorkPlan,type OutcomePriceVersion,type ScopeLine,type CommercePriceMetadata,type ScopeQuoteStatus} from '@bondbuddy/contracts';
import {digest,missing,Problem,project,transaction,uid} from './data.js';
import {readOwnedCommerceCoverage} from './commerce-coverage.js';
import {isAutomaticPriceVersion} from '@bondbuddy/contracts';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {loadAutomaticTaskTariff} from './automatic-tariff-repository.js';
import {resolveAutomaticTaskPrice,assertAutomaticPriceSources,assertAutomaticScopeAvailable} from './automatic-pricing.js';

export type ScopePrice={scope_quote_id:string;quote_status:ScopeQuoteStatus;amount_fen:number;scope_lines:ScopeLine[];scope_expires_at:string|null;price_version:OutcomePriceVersion};
const iso=(v:unknown)=>v?new Date(v as string).toISOString():null;
const dto=(r:any):ScopePrice=>({scope_quote_id:r.id,quote_status:r.status==='quoted'?'ready':r.status==='pending'?'pending_scope':r.status,amount_fen:Number(r.amount_fen??0),scope_lines:r.lines??[],scope_expires_at:iso(r.expires_at),price_version:r.price_version});
const quotationDto=(r:any)=>({id:r.id,project_id:r.project_id,action:r.action,input_hash:r.input_hash.trim(),price_version:r.price_version,quote_status:dto(r).quote_status,amount_fen:Number(r.amount_fen??0),scope_lines:r.lines??[],reason:r.reason,created_at:iso(r.created_at)!,published_at:iso(r.published_at),expires_at:iso(r.expires_at),closed_at:iso(r.closed_at),decline_reason:r.decline_reason,closure_reason:r.closure_reason,revision:r.revision,previous_quote_id:r.previous_quote_id});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function scopePriceMetadata(price:ScopePrice):CommercePriceMetadata{return{pricing_mode:'outcome_cny_v1',currency:'CNY',amount_fen:price.amount_fen,price_version:price.price_version,scope_quote_id:price.scope_quote_id,quote_status:price.quote_status,scope_lines:price.scope_lines,scope_expires_at:price.scope_expires_at,...(isAutomaticPriceVersion(price.price_version)?{auto_charge:true}:{})};}
/** Hash only work scope. Never include a price, quotation id, timestamps or model retry count. */
export const workScopeHash=(snapshot:unknown)=>digest(canonical(snapshot));
const scopeLock=(c:PoolClient,owner:string,projectId:string,action:string,hash:string)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonical(['scope',owner,projectId,action,hash])]);
/** Serialize contractual coverage before checking quotes and reserving funds. */
const coverageLock=(c:PoolClient,owner:string)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['commerce-coverage:'+owner]);
function validatePlan(plan:unknown):asserts plan is OutcomeWorkPlan{
  if(!Value.Check(OutcomeWorkPlanSchema,plan)||plan.scope_status!=='confirmed'||!plan.items.length)throw new Problem(422,'VALIDATION_FAILED','A nonempty confirmed business work plan is required');
}
async function pricePlan(c:PoolClient,owner:string,plan:OutcomeWorkPlan){
  const owned=await readOwnedCommerceCoverage(c,owner,plan.items.map(i=>i.coverage_key));
  try{return calculateOutcomePrice({...plan,owned_coverage:owned});}catch{throw new Problem(422,'VALIDATION_FAILED','Business work plan is inconsistent with valid owned coverage');}
}
async function assertCurrentCoverage(c:PoolClient,row:any){
  if(row.automatic_price){await assertAutomaticPriceSources(c,row.owner_user_id,row.automatic_price,row.snapshot);await assertAutomaticScopeAvailable(c,row.owner_user_id,row.id);return;}
  if(!row.work_plan)return;
  const priced=await pricePlan(c,row.owner_user_id,row.work_plan);
  if(priced.status!=='ready'||priced.amount_fen!==Number(row.amount_fen)||priced.price_version!==row.price_version||canonical(priced.pricing_items)!==canonical(row.pricing_items))throw new Problem(409,'QUOTE_CHANGED','已购覆盖已变化，请关闭旧报价并重新报价。');
  const keys=row.work_plan.items.map((i:any)=>i.coverage_key);
  const active=(await c.query(`SELECT b.scope_quote_id FROM bb_commerce_scope_runs b JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.id=b.run_id
    WHERE b.owner_user_id=$1 AND r.state NOT IN ('succeeded','failed','cancelled','rejected','test_completed') AND EXISTS(
     SELECT 1 FROM jsonb_array_elements(b.pricing_items) item WHERE item->>'coverage_key'=ANY($2::text[])) LIMIT 1`,[row.owner_user_id,keys])).rows[0];
  if(active)throw new Problem(409,'QUOTE_CHANGED','相同业务范围已有执行中的任务，请先查看该任务。');
}
async function publishPlan(c:PoolClient,row:any,plan:OutcomeWorkPlan,actor:string,reason:string){
  const priced=await pricePlan(c,row.owner_user_id,plan);
  if(priced.status!=='ready')throw new Problem(422,'VALIDATION_FAILED',priced.reason);
  const saved=(await c.query(`UPDATE bb_scope_quotations SET status='quoted',lines=$2,amount_fen=$3,approved_by=$4,reason=$5,
    published_at=clock_timestamp(),expires_at=clock_timestamp()+interval '7 days',price_version=$6,work_plan=$7,pricing_items=$8 WHERE id=$1 RETURNING *`,[row.id,JSON.stringify(priced.scope_lines),priced.amount_fen,actor,reason,priced.price_version,JSON.stringify(plan),JSON.stringify(priced.pricing_items)])).rows[0];
  await event(c,saved,'quoted',{amount_fen:priced.amount_fen,price_version:priced.price_version,expires_at:iso(saved.expires_at)});return dto(saved);
}
async function event(c:PoolClient,r:any,name:string,extra:Record<string,unknown>={}){
  await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)",[uid(),r.owner_user_id,r.project_id,'commerce.scope_'+name,{scope_quote_id:r.id,revision:r.revision,input_hash:r.input_hash.trim(),...extra}]);
}
async function expire(c:PoolClient,owner:string,id?:string){
  const rows=(await c.query(`UPDATE bb_scope_quotations SET status='expired',closed_at=clock_timestamp(),closure_reason='报价有效期已届满，请重新报价后确认新购买。' WHERE owner_user_id=$1 AND ($2::text IS NULL OR id=$2) AND status='quoted' AND expires_at<=clock_timestamp() RETURNING *`,[owner,id??null])).rows;
  for(const r of rows)await event(c,r,'expired');
}
export async function resolveApprovedScope(c:PoolClient,owner:string,projectId:string,action:string,inputHash:string):Promise<ScopePrice|null>{
  const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND project_id=$2 AND action=$3 AND input_hash=$4 ORDER BY revision DESC LIMIT 1',[owner,projectId,action,inputHash])).rows[0];
  if(!row)return null;await expire(c,owner,row.id);return dto((await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[row.id])).rows[0]);
}
/** Called only by trusted workflow quote preparation with its exact immutable scope snapshot. */
export async function requestScope(c:PoolClient,owner:string,projectId:string,action:string,inputHash:string,snapshot:unknown,workPlan?:OutcomeWorkPlan):Promise<ScopePrice>{
  if(!/^[a-f0-9]{64}$/.test(inputHash)||!/^[a-z][a-z0-9_]{0,63}$/.test(action))throw new Problem(422,'VALIDATION_FAILED','Invalid work scope');
  if(workPlan)validatePlan(workPlan);
  await project(c,owner,projectId);await coverageLock(c,owner);await scopeLock(c,owner,projectId,action,inputHash);
  if(automaticBillingEnabled(c))return requestAutomaticScope(c,owner,projectId,action,inputHash,snapshot);
  const old=await resolveApprovedScope(c,owner,projectId,action,inputHash);
  if(old){
    if(workPlan&&old.quote_status==='pending_scope'){
      const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 FOR UPDATE',[old.scope_quote_id])).rows[0];
      return publishPlan(c,row,workPlan,'service:standard-scope','按已确认标准业务范围与有效已购合同计价。');
    }
    return old;
  }
  const inserted=(await c.query(`INSERT INTO bb_scope_quotations(id,owner_user_id,project_id,action,input_hash,snapshot,price_version)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[uid(),owner,projectId,action,inputHash,snapshot,OUTCOME_PRICE_VERSION])).rows[0];
  const row=inserted;await event(c,row,'requested',{action});
  return workPlan?publishPlan(c,row,workPlan,'service:standard-scope','按已确认标准业务范围与有效已购合同计价。'):dto(row);
}

async function requestAutomaticScope(c:PoolClient,owner:string,projectId:string,action:string,inputHash:string,snapshot:unknown):Promise<ScopePrice>{
  const old=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND project_id=$2 AND action=$3 AND input_hash=$4 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[owner,projectId,action,inputHash])).rows[0];
  if(old?.automatic_price&&old.status==='quoted'&&new Date(old.expires_at).getTime()>Date.now()){
    const attempted=(await c.query('SELECT 1 FROM bb_automatic_scope_runs WHERE owner_user_id=$1 AND scope_quote_id=$2 LIMIT 1',[owner,old.id])).rowCount;
    if(!attempted)return dto(old);
  }
  if(old?.published_at){
    // Already accepted/executing contracts retain their original terms even after the mode changes.
    const bound=(await c.query(`SELECT 1 FROM bb_scope_acceptances WHERE owner_user_id=$1 AND scope_quote_id=$2
      UNION ALL SELECT 1 FROM (
        SELECT owner_user_id,run_id,scope_quote_id FROM bb_commerce_scope_runs
        UNION ALL SELECT owner_user_id,run_id,scope_quote_id FROM bb_automatic_scope_runs
      ) b JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.id=b.run_id
      LEFT JOIN bb_credit_reservations h ON h.owner_user_id=r.owner_user_id AND h.id=r.reservation_id
      WHERE b.owner_user_id=$1 AND b.scope_quote_id=$2
        AND (r.state NOT IN ('failed','cancelled','rejected') OR (r.reservation_id IS NOT NULL AND h.state IS DISTINCT FROM 'released'))
      LIMIT 1`,[owner,old.id])).rowCount;
    if(bound)return dto(old);
  }
  const priceVersion=await resolveAutomaticTaskPriceVersion(c,owner);
  const price=resolveAutomaticTaskPrice(action,snapshot,priceVersion,await loadAutomaticTaskTariff(c,priceVersion));
  await assertAutomaticPriceSources(c,owner,price,snapshot);
  if(old&&['pending','quoted'].includes(old.status))await c.query("UPDATE bb_scope_quotations SET status='unavailable',closed_at=clock_timestamp(),closure_reason='未受理范围由当前自动计费规则替换。' WHERE id=$1",[old.id]);
  const row=(await c.query(`INSERT INTO bb_scope_quotations(id,owner_user_id,project_id,action,input_hash,snapshot,price_version,revision,previous_quote_id,
    status,lines,amount_fen,approved_by,reason,published_at,expires_at,automatic_price)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'quoted',$10,$11,'service:automatic-tariff','已锁定用户委托范围；成功交付后自动扣费。',clock_timestamp(),clock_timestamp()+interval '7 days',$12) RETURNING *`,
    [uid(),owner,projectId,action,inputHash,snapshot,priceVersion,old?old.revision+1:1,old?.id??null,JSON.stringify(price.lines),price.points,JSON.stringify(price)])).rows[0];
  await event(c,row,'quoted',{auto_charge:true,points:price.points,price_version:row.price_version});
  return dto(row);
}
export async function assertScopeQuote(c:PoolClient,id:string|undefined,owner:string,projectId:string,action:string,inputHash:string,amountFen:number):Promise<ScopePrice>{
  if(!id)throw new Problem(409,'QUOTE_REQUIRED','请先获取本次实际处理范围的报价。');
  await coverageLock(c,owner);
  const row=(await c.query('SELECT *,expires_at>clock_timestamp() AS valid FROM bb_scope_quotations WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND action=$4 AND input_hash=$5 FOR UPDATE',[id,owner,projectId,action,inputHash])).rows[0];
  if(!row||row.status!=='quoted'||!row.valid||Number(row.amount_fen)!==amountFen)throw new Problem(409,'QUOTE_CHANGED','本次范围报价未就绪、已关闭或已过期，请重新获取报价后确认。');
  await assertCurrentCoverage(c,row);return dto(row);
}
export function validateScopeLines(lines:unknown):{lines:ScopeLine[];total:number}{
  if(!Array.isArray(lines)||!lines.length||lines.length>200||lines.some(l=>!Value.Check(ScopeLineSchema,l)))throw new Problem(422,'VALIDATION_FAILED','Work items with scope evidence are required');
  const keys=new Set<string>();let total=0;
  for(const l of lines as ScopeLine[]){if(keys.has(l.key)||!l.label.trim()||!l.unit.trim()||l.evidence.some(x=>!x.trim())||!Number.isSafeInteger(l.quantity*l.unit_price_fen)||l.amount_fen!==l.quantity*l.unit_price_fen)throw new Problem(422,'VALIDATION_FAILED','Work items must be unique and amounts must match quantity × unit price');keys.add(l.key);total+=l.amount_fen;}
  if(!Number.isSafeInteger(total)||total<1||total>100000000)throw new Problem(422,'VALIDATION_FAILED','Scope total is outside the supported range');return{lines:lines as ScopeLine[],total};
}
/** Trusted operations command. No browser endpoint can approve or change a price. */
export async function publishScopeQuote(pool:Pool,input:{id:string;expected_input_hash:string;lines:unknown;actor:string;reason:string;expires_at?:string}){
  const {lines,total}=validateScopeLines(input.lines);
  if(!input.actor?.trim()||!input.reason?.trim()||input.actor.length>200||input.reason.length>2000||input.expires_at!==undefined&&(!/Z$/.test(input.expires_at)||!Number.isFinite(Date.parse(input.expires_at))))throw new Problem(422,'VALIDATION_FAILED','Reviewer, scope explanation and optional UTC expiry required');
  return transaction(pool,async c=>{
    const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 FOR UPDATE',[input.id])).rows[0];if(!row)throw missing();
    if(row.work_plan)throw new Problem(409,'QUOTE_CHANGED','标准业务范围必须由标准计价器计算，不能手工覆盖金额。');
    if(row.input_hash.trim()!==input.expected_input_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Review the exact requested input snapshot before quoting');
    if(row.published_at){
      if(canonical(row.lines)!==canonical(lines)||Number(row.amount_fen)!==total||row.reason!==input.reason||row.approved_by!==input.actor||input.expires_at!==undefined&&iso(row.expires_at)!==iso(input.expires_at))throw new Problem(409,'IDEMPOTENCY_CONFLICT','Published scope price is immutable');return dto(row);
    }
    if(row.status!=='pending')throw new Problem(409,'QUOTE_CHANGED','Closed scope requires a new quotation revision');
    const saved=(await c.query("UPDATE bb_scope_quotations SET status='quoted',lines=$2,amount_fen=$3,approved_by=$4,reason=$5,published_at=clock_timestamp(),expires_at=COALESCE($6::timestamptz,clock_timestamp()+interval '7 days') WHERE id=$1 RETURNING *",[input.id,JSON.stringify(lines),total,input.actor,input.reason,input.expires_at??null])).rows[0];
    await event(c,saved,'quoted',{amount_fen:total,expires_at:iso(saved.expires_at)});
    return dto(saved);
  });
}
/** Trusted classification only: the server resolves ownership and calculates every amount. */
export async function publishStandardScopeQuote(pool:Pool,input:{id:string;expected_input_hash:string;work_plan:unknown;actor:string;reason:string}){
  validatePlan(input.work_plan);const plan=input.work_plan;
  if(!input.actor?.trim()||input.actor.length>200||!input.reason?.trim()||input.reason.length>2000)throw new Problem(422,'VALIDATION_FAILED','Reviewer and business-scope explanation required');
  return transaction(pool,async c=>{
    const identity=(await c.query('SELECT owner_user_id FROM bb_scope_quotations WHERE id=$1',[input.id])).rows[0];if(!identity)throw missing();
    await coverageLock(c,identity.owner_user_id);
    const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
    if(row.input_hash.trim()!==input.expected_input_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Review the exact requested input snapshot before classification');
    if(row.published_at){
      if(canonical(row.work_plan)!==canonical(plan)||row.reason!==input.reason||row.approved_by!==input.actor)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Published business scope and price are immutable');return dto(row);
    }
    if(row.status!=='pending')throw new Problem(409,'QUOTE_CHANGED','Closed scope requires a new quotation revision');
    return publishPlan(c,row,plan,input.actor,input.reason);
  });
}
export async function readScopeQuotations(db:Pool,owner:string){
  return transaction(db,async c=>{await expire(c,owner);return {items:(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[owner])).rows.map(quotationDto)};});
}
export async function readScopeQuotation(db:Pool,owner:string,id:string){return transaction(db,async c=>{await expire(c,owner,id);const r=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND id=$2',[owner,id])).rows[0];if(!r)throw missing();return {quotation:quotationDto(r)};});}
export type ScopeAcceptanceContext='file_generation_batch'|'file_update_batch'|'file_check_batch';
/** Internal only. The DB checks the persisted owned batch item and exact approved manifest. */
export async function acceptScopeBatch(c:PoolClient,owner:string,scopeId:string,context:ScopeAcceptanceContext,contextId:string,index:number,manifest:unknown){
  await coverageLock(c,owner);
  const current=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[scopeId,owner])).rows[0];if(!current)throw missing();await assertCurrentCoverage(c,current);
  const id=uid();await c.query('INSERT INTO bb_scope_acceptances(id,owner_user_id,scope_quote_id,context,context_id,item_index,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,scopeId,context,contextId,index,manifest]);
  const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 AND owner_user_id=$2',[scopeId,owner])).rows[0];await event(c,row,'accepted',{acceptance_id:id,context,context_id:contextId,item_index:index});return id;
}
/** A frozen batch acceptance, never an allow-expired flag, authorizes later delivery. */
export async function assertAcceptedScope(c:PoolClient,acceptanceId:string,id:string|undefined,owner:string,projectId:string,action:string,inputHash:string,amountFen:number,manifest:unknown):Promise<ScopePrice>{
  await coverageLock(c,owner);
  const row=(await c.query(`SELECT s.*,a.context,a.context_id,a.item_index,a.manifest AS accepted_manifest FROM bb_scope_acceptances a JOIN bb_scope_quotations s ON s.id=a.scope_quote_id AND s.owner_user_id=a.owner_user_id
    WHERE a.id=$1 AND a.owner_user_id=$2 AND s.id=$3 AND s.project_id=$4 AND s.action=$5 AND s.input_hash=$6 AND s.amount_fen=$7 FOR UPDATE OF s`,[acceptanceId,owner,id??null,projectId,action,inputHash,amountFen])).rows[0];
  if(!row||canonical(row.accepted_manifest)!==canonical(manifest))throw new Problem(409,'QUOTE_CHANGED','已接受的批次范围与本次任务不一致。');
  if(row.context==='file_check_batch'){
    const item=(await c.query(`SELECT i.* FROM bb_project_file_check_batch_items i JOIN bb_project_file_check_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
      WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.ordinal=$3 AND b.project_id=$4`,[owner,row.context_id,row.item_index,projectId])).rows[0];
    if(!item||item.scope_quote_id!==id||String(item.points)!==String(amountFen)||canonical(item.manifest)!==canonical(manifest))throw new Problem(409,'QUOTE_CHANGED','原逐份检查接受凭据不可用。');
  }else{
    const table=row.context==='file_generation_batch'?'bb_project_file_batches':'bb_project_file_update_batches';
    const b=(await c.query(`SELECT items,state FROM ${table} WHERE owner_user_id=$1 AND id=$2`,[owner,row.context_id])).rows[0],item=b?.items[row.item_index];
    if(!item||b.state==='cancelled'||item.scope_acceptance_id!==acceptanceId||item.scope_quote_id!==id||item.points!==amountFen||canonical(item.manifest)!==canonical(manifest))throw new Problem(409,'QUOTE_CHANGED','原批次接受凭据不可用。');
  }
  await assertCurrentCoverage(c,row);return {...dto(row),quote_status:'ready'};
}
export async function markScopeUnavailable(pool:Pool,input:{id:string;expected_input_hash:string;actor:string;reason:string}){
  if(!input.actor?.trim()||input.actor.length>200||!input.reason?.trim()||input.reason.length>2000)throw new Problem(422,'VALIDATION_FAILED','Operator and unavailability reason required');
  return transaction(pool,async c=>{
    const r=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 FOR UPDATE',[input.id])).rows[0];if(!r)throw missing();
    if(r.input_hash.trim()!==input.expected_input_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Inspect exact scope first');
    if(r.status==='unavailable'&&r.closure_reason===input.reason)return dto(r);
    if(!['pending','quoted'].includes(r.status))throw new Problem(409,'QUOTE_CHANGED','Scope already closed');
    const saved=(await c.query("UPDATE bb_scope_quotations SET status='unavailable',closed_at=clock_timestamp(),closure_reason=$2 WHERE id=$1 RETURNING *",[r.id,input.reason])).rows[0];
    await event(c,saved,'unavailable',{actor:input.actor,reason:input.reason});return dto(saved);
  });
}
async function mutateScope(pool:Pool,owner:string,id:string,requestId:string,action:'decline'|'requote',reason=''){
  if(!requestId||requestId.length>128||action==='decline'&&(!reason.trim()||reason.length>1000))throw new Problem(422,'VALIDATION_FAILED','Request id and a nonempty decline reason are required');
  return transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonical(['scope-request',owner,requestId])]);
    const hash=workScopeHash({id,action,reason}),receipt=(await c.query('SELECT * FROM bb_scope_quotation_requests WHERE owner_user_id=$1 AND request_id=$2',[owner,requestId])).rows[0];
    if(receipt){if(receipt.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','This request id was used for another scope action');await expire(c,owner,receipt.result_quote_id);return {quotation:quotationDto((await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND id=$2',[owner,receipt.result_quote_id])).rows[0])};}
    let row=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND id=$2',[owner,id])).rows[0];if(!row)throw missing();
    await scopeLock(c,owner,row.project_id,row.action,row.input_hash.trim());await expire(c,owner,id);
    row=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,id])).rows[0];let result:any;
    if(action==='decline'){
      if(row.status!=='quoted')throw new Problem(409,'QUOTE_CHANGED','Only a valid published quotation can be declined');
      result=(await c.query("UPDATE bb_scope_quotations SET status='declined',closed_at=clock_timestamp(),decline_reason=$2,closure_reason=$2 WHERE id=$1 RETURNING *",[id,reason])).rows[0];await event(c,result,'declined',{reason});
    }else{
      if(!['declined','expired','unavailable'].includes(row.status))throw new Problem(409,'QUOTE_CHANGED','Close the prior quotation before requesting a revision');
      const later=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND previous_quote_id=$2',[owner,id])).rows[0];
      if(automaticBillingEnabled(c)){
        if(row.action==='integrity_round'&&(!row.snapshot?.round_id||!row.snapshot?.scope_measurement))
          throw new Problem(422,'SCOPE_UNSUPPORTED','请返回诚信核查页准备新一轮核查，再按当前适用官网范围报价。');
        const renewed=await requestAutomaticScope(c,owner,row.project_id,row.action,row.input_hash.trim(),row.snapshot);
        result=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[renewed.scope_quote_id])).rows[0];
      }else{
        result=later??(await c.query('INSERT INTO bb_scope_quotations(id,owner_user_id,project_id,action,input_hash,snapshot,revision,previous_quote_id,price_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[uid(),owner,row.project_id,row.action,row.input_hash,row.snapshot,row.revision+1,id,OUTCOME_PRICE_VERSION])).rows[0];
        if(!later)await event(c,result,'requested',{action:row.action,previous_quote_id:id});
      }
    }
    await c.query('INSERT INTO bb_scope_quotation_requests(owner_user_id,request_id,request_hash,action,scope_quote_id,result_quote_id) VALUES($1,$2,$3,$4,$5,$6)',[owner,requestId,hash,action,id,result.id]);return {quotation:quotationDto(result)};
  });
}
export const declineScopeQuotation=(p:Pool,owner:string,id:string,b:{request_id:string;reason:string})=>mutateScope(p,owner,id,b.request_id,'decline',b.reason);
export const requoteScopeQuotation=(p:Pool,owner:string,id:string,b:{request_id:string})=>mutateScope(p,owner,id,b.request_id,'requote');
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
  const {Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{
    const [command,file]=process.argv.slice(2);
    if(command==='publish'||command==='classify')throw new Problem(409,'QUOTE_CHANGED','旧范围报价发布已退役，请通过现行价格管理发布完整自动价表；历史合同可继续查询和执行。');
    else if(command==='unavailable'&&file)process.stdout.write(JSON.stringify(await markScopeUnavailable(pool,JSON.parse(readFileSync(file,'utf8'))))+'\n');
    else if(command==='inspect'&&file){const row=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[file])).rows[0];if(!row)throw missing();process.stdout.write(JSON.stringify(row,null,2)+'\n');}
    else throw Error('Use inspect QUOTATION_ID or unavailable FILE. Legacy quotation publication is retired. Keep private scope in the authorised operational environment.');
  }finally{await pool.end();}
}
