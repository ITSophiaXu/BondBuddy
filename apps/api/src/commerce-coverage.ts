import type {PoolClient} from 'pg';
import {calculateOutcomePrice,OUTCOME_RATE_CARD,type OutcomeOwnedCoverage,type OutcomePricingInput,type OutcomePricingItemResult} from '@bondbuddy/contracts';
import {digest,Problem} from './data.js';
import {bindAutomaticScopeRun} from './automatic-pricing.js';

const changed=()=>new Problem(409,'QUOTE_CHANGED','已购覆盖或本次业务范围已变化，请重新确认报价。');
const stable=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const coverageId=(scope:string,key:string)=>'coverage:'+digest(JSON.stringify([scope,key]));
type StoredResult=OutcomePricingItemResult&{owned_coverage_ids:string[];complete_group?:boolean};
type Candidate={row:any;item:StoredResult};

/** Discounted and zero-price receipts remain dependent on the exact receipts they reused. */
export async function readOwnedCommerceCoverage(c:PoolClient,owner:string,coverageKeys:string[]):Promise<OutcomeOwnedCoverage[]>{
  const keys=[...new Set(coverageKeys)];
  if(!keys.length)return [];
  if(keys.some(k=>typeof k!=='string'||!k.trim()||k.length>500))throw new Problem(422,'VALIDATION_FAILED','Invalid business coverage keys');
  const rows=(await c.query(`SELECT b.*,s.amount_fen,s.work_plan,s.pricing_items AS scope_pricing_items,r.state,
    (r.project_id=s.project_id AND b.plan=s.work_plan AND b.pricing_items=s.pricing_items AND s.published_at IS NOT NULL
     AND EXISTS(SELECT 1 FROM bb_commerce_scope_source_quotes(b.owner_user_id,b.scope_quote_id,b.run_id))) AS exact_source,
    EXISTS(SELECT 1 FROM bb_credit_reservations res
     JOIN bb_commerce_scope_source_quotes(b.owner_user_id,b.scope_quote_id,b.run_id) q ON q.quote_id=res.quote_id
     WHERE res.id=r.reservation_id AND res.owner_user_id=b.owner_user_id AND res.run_id=r.id
      AND res.state='settled' AND res.points=s.amount_fen AND res.charged_points=s.amount_fen) AS paid,
    EXISTS(SELECT 1 FROM bb_credit_events e JOIN bb_credit_lots l ON l.owner_user_id=e.owner_user_id AND l.id=e.lot_id
     WHERE e.owner_user_id=b.owner_user_id AND e.run_id=b.run_id AND e.kind='correction'
      AND e.reservation_id=r.reservation_id
      AND left(l.source_key,length('settlement-correction:'||r.reservation_id||':'))='settlement-correction:'||r.reservation_id||':') AS corrected
   FROM bb_commerce_scope_runs b JOIN bb_scope_quotations s ON s.owner_user_id=b.owner_user_id AND s.id=b.scope_quote_id
   JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.id=b.run_id
   WHERE b.owner_user_id=$1 AND r.state='succeeded' AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.pricing_items) item WHERE item->>'coverage_key'=ANY($2::text[]))
   ORDER BY b.bound_at,b.scope_quote_id`,[owner,keys])).rows;
  const candidates=new Map<string,Candidate>();
  for(const row of rows)for(const item of row.pricing_items as StoredResult[]){
    if(keys.includes(item.coverage_key))candidates.set(coverageId(row.scope_quote_id,item.key),{row,item});
  }
  const resolved=new Map<string,OutcomeOwnedCoverage|null>(),visiting=new Set<string>();
  function resolve(id:string):OutcomeOwnedCoverage|null{
    if(resolved.has(id))return resolved.get(id)!;
    const found=candidates.get(id);
    if(!found||visiting.has(id))return null;
    const {row,item}=found;
    if(row.state!=='succeeded'||!row.exact_source||row.corrected||Number(row.amount_fen)>0&&!row.paid){resolved.set(id,null);return null;}
    visiting.add(id);
    const needsParents=Number(row.amount_fen)===0||item.family==='included'||item.due_fen===0||item.owned_coverage_ids?.length>0;
    let parents:OutcomeOwnedCoverage[]=[];
    if(needsParents){
      if(!Array.isArray(item.owned_coverage_ids)||!item.owned_coverage_ids.length){visiting.delete(id);resolved.set(id,null);return null;}
      const sources=item.owned_coverage_ids.map(resolve);
      if(sources.some(p=>!p||p.coverage_key!==item.coverage_key)){visiting.delete(id);resolved.set(id,null);return null;}
      parents=sources as OutcomeOwnedCoverage[];
    }
    let result:OutcomeOwnedCoverage|null=null;
    if(item.family==='included'){
      if(parents.every(p=>p.price_key==='period'||p.price_key==='financial_group')){
        const complete=parents.some(p=>p.complete_group||p.price_key==='financial_group');
        result={id,coverage_key:item.coverage_key,price_key:complete?'financial_group':'period',period_keys:[...new Set(parents.flatMap(p=>p.period_keys??[]))],...(complete?{complete_group:true}:{})};
      }else{
        const best=parents.reduce((a,b)=>OUTCOME_RATE_CARD[a.price_key]>=OUTCOME_RATE_CARD[b.price_key]?a:b);
        result={...best,id};
      }
    }else if(item.price_key&&Object.hasOwn(OUTCOME_RATE_CARD,item.price_key)){
      const periods=item.period_keys;
      if(item.family!=='financial_group'||item.complete_group||item.price_key==='financial_group'||periods?.length){
        result={id,coverage_key:item.coverage_key,price_key:item.price_key,...(periods?{period_keys:[...periods]}:{}),...(item.complete_group?{complete_group:true}:{})};
      }
    }
    visiting.delete(id);resolved.set(id,result);return result;
  }
  return [...candidates.keys()].map(resolve).filter((v):v is OutcomeOwnedCoverage=>v!==null);
}

/** Call after the exact family quote and reservation (if positive) have been persisted. */
export async function bindCommerceScopeRun(c:PoolClient,owner:string,scopeQuoteId:string,runId:string):Promise<void>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['commerce-coverage:'+owner]);
  const scope=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,scopeQuoteId])).rows[0];
  if(!scope)throw changed();
  if(scope.automatic_price){await bindAutomaticScopeRun(c,owner,scope,runId);return;}
  if(scope.work_plan===null)return; // Historical reviewed quotes do not manufacture new entitlements.
  const existing=(await c.query('SELECT * FROM bb_commerce_scope_runs WHERE run_id=$1',[runId])).rows[0];
  if(existing){if(existing.owner_user_id===owner&&existing.scope_quote_id===scopeQuoteId&&existing.run_id===runId)return;throw new Problem(409,'IDEMPOTENCY_CONFLICT','该业务报价已经绑定另一任务。');}
  const consumed=(await c.query(`SELECT 1 FROM bb_commerce_scope_runs b
   JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.id=b.run_id
   LEFT JOIN bb_credit_reservations res ON res.owner_user_id=r.owner_user_id AND res.id=r.reservation_id AND res.run_id=r.id
   WHERE b.owner_user_id=$1 AND b.scope_quote_id=$2 AND
    (r.state NOT IN ('failed','cancelled','rejected') OR r.reservation_id IS NOT NULL AND res.state IS DISTINCT FROM 'released') LIMIT 1`,[owner,scopeQuoteId])).rows[0];
  if(consumed)throw new Problem(409,'IDEMPOTENCY_CONFLICT','该业务报价已有执行中或成功的任务，或原尝试费用尚未释放。');
  const plan=scope.work_plan as OutcomePricingInput;
  if(!Array.isArray(plan.items)||!plan.items.length||Object.hasOwn(plan,'owned_coverage'))throw changed();
  const active=(await c.query(`SELECT b.scope_quote_id FROM bb_commerce_scope_runs b JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.id=b.run_id
   WHERE b.owner_user_id=$1 AND r.state NOT IN ('succeeded','failed','cancelled','rejected','test_completed') AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(b.pricing_items) item WHERE item->>'coverage_key'=ANY($2::text[])) LIMIT 1`,[owner,plan.items.map(i=>i.coverage_key)])).rows[0];
  if(active)throw new Problem(409,'QUOTE_CHANGED','相同业务范围已有执行中的任务，请先查看该任务。');
  const owned=await readOwnedCommerceCoverage(c,owner,plan.items.map(i=>i.coverage_key));
  let priced;
  try{priced=calculateOutcomePrice({...plan,owned_coverage:owned});}catch{throw changed();}
  if(priced.status!=='ready'||priced.price_version!==scope.price_version||priced.amount_fen!==Number(scope.amount_fen)||stable(priced.pricing_items)!==stable(scope.pricing_items))throw changed();
  await c.query('INSERT INTO bb_commerce_scope_runs(owner_user_id,scope_quote_id,run_id,plan,pricing_items) VALUES($1,$2,$3,$4,$5)',[owner,scopeQuoteId,runId,scope.work_plan,JSON.stringify(priced.pricing_items)]);
}
