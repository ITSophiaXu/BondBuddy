import {SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,schemas,int64,serializeInt64,type SubscriptionChangeQuote,type SubscriptionChangeQuoteRequest,type SubscriptionChangeCheckoutRequest} from '@bondbuddy/contracts';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {date,digest,missing,Problem,transaction,uid} from './data.js';
import {lockCreditAccount,grantCredits} from './billing.js';
import {assertChannelWritable} from './billing-safety.js';
import {currentAutomaticPriceVersion} from './automatic-tariff-repository.js';
import {openCheckout,type PaymentProvider} from './payments.js';
import {cancelSubscription,subscriptionDto} from './subscriptions.js';
import {ZERO,ratio,add,divide,type ExactRatio} from './commerce-economics-math.js';

type Component={source_order_id:string;point_numerator:string;point_denominator:string};
type Source={lot_id:string;points:string;expires_at:string|null;cash_basis_fen:string;cash_basis_points:string;cash_origin_lot_id:string;components:Component[]};
const invalid=(message:string)=>new Problem(409,'PAYMENT_INVALID',message);
const evidence=()=>new Problem(503,'DATA_UNAVAILABLE','原订阅积分的实付来源仍需核对，原权益已保留，请稍后再转换。');
const stale=()=>new Problem(409,'SUBSCRIPTION_CHANGE_QUOTE_STALE','可抵扣积分已变化，请刷新付款摘要。该付款请求已终结，不会再创建订单。');
const canonical=(value:unknown)=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const same=(a:ExactRatio,b:ExactRatio)=>a.numerator*b.denominator===b.numerator*a.denominator;
const bounded=(value:ExactRatio)=>{int64(value.numerator);int64(value.denominator);return value;};
const ratioOf=(n:unknown,d:unknown)=>ratio(int64(n),int64(d));
const quoteDto=(q:any):SubscriptionChangeQuote=>({quote_id:q.id,source_period_id:q.source_period_id,source_plan_id:q.source_plan_id,target_plan_id:q.target_plan_id,billing_cycle:q.billing_cycle,
 face_amount_fen:serializeInt64(q.face_amount_fen),credit_offset_fen:serializeInt64(q.credit_offset_fen),pay_now_fen:serializeInt64(q.pay_now_fen),transfer_points:serializeInt64(q.transfer_points),
 excluded_held_points:serializeInt64(q.excluded_held_points),monthly_points:serializeInt64(q.monthly_points),total_points:serializeInt64(q.total_points),release_count:q.billing_cycle==='annual'?12:1,expires_at:date(q.expires_at)});
async function context(c:PoolClient,owner:string,targetId:string,cycle:string){
 const subscription=(await c.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE owner_user_id=$1 FOR UPDATE',[owner])).rows[0];
 if(!subscription)throw invalid('请先开通月付订阅。');
 const period=(await c.query("SELECT * FROM bb_subscription_periods WHERE subscription_id=$1 AND status='active' AND starts_at=$2 AND ends_at=$3",[subscription.id,subscription.current_period_start,subscription.current_period_end])).rows[0];
 const current=SUBSCRIPTION_PLANS.findIndex(p=>p.id===period?.plan_id),target=SUBSCRIPTION_PLANS.findIndex(p=>p.id===targetId);
 if(!period||period.billing_cycle!=='monthly'||new Date(period.ends_at)<=new Date(subscription.observed_at)||target<0||
  !(cycle==='monthly'&&target>current||cycle==='annual'&&target>=current))throw invalid('当前月付可升更高月付档，或转同档及更高档年付；当前方案与权益保留。');
 if((await c.query("SELECT 1 FROM bb_subscription_periods WHERE subscription_id=$1 AND status='pending'",[subscription.id])).rowCount)throw invalid('已有订阅付款待核对，请继续原订单。');
 if((await c.query("SELECT 1 FROM bb_payment_refunds WHERE order_id=$1 AND state IN ('requested','processing')",[period.order_id])).rowCount)throw invalid('原订阅退款仍在核对，请先完成原退款。');
 const rows=(await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND source='subscription'
  AND (id=$2 OR cash_origin_lot_id=$2) AND (expires_at IS NULL OR expires_at>now()) ORDER BY id FOR UPDATE`,[owner,period.lot_id])).rows;
 let held=0n,total=ZERO;const sources:Source[]=[];
 for(const row of rows){
  held+=int64(row.frozen);const available=int64(row.remaining)-int64(row.frozen);if(available<=0n)continue;
  if(row.cash_basis_fen===null||row.cash_basis_points===null||!row.cash_origin_lot_id)throw evidence();
  const scalar=ratioOf(row.cash_basis_fen,row.cash_basis_points);let components:Component[]=[];
  if(row.cash_order_id)components=[{source_order_id:row.cash_order_id,point_numerator:scalar.numerator.toString(),point_denominator:scalar.denominator.toString()}];
  else{
   const funding=(await c.query(`SELECT f.source_order_id,l.point_numerator::text,l.point_denominator::text FROM bb_subscription_lot_funding l
    JOIN bb_subscription_funding_sources f ON f.id=l.funding_source_id AND f.owner_user_id=l.owner_user_id WHERE l.lot_id=$1 AND l.owner_user_id=$2 ORDER BY f.id`,[row.id,owner])).rows;
   const grouped=new Map<string,ExactRatio>();for(const f of funding)grouped.set(f.source_order_id,add(grouped.get(f.source_order_id)??ZERO,ratioOf(f.point_numerator,f.point_denominator)));
   components=[...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([source_order_id,v])=>({source_order_id,point_numerator:v.numerator.toString(),point_denominator:v.denominator.toString()}));
   if(!components.length||!same(components.reduce((sum,f)=>add(sum,ratioOf(f.point_numerator,f.point_denominator)),ZERO),scalar))throw evidence();
  }
  for(const component of components){
   const proof=(await c.query(`SELECT o.amount_fen::text,p.cash_amount_fen::text FROM bb_recharge_orders o JOIN bb_payment_cash_proofs p ON p.order_id=o.id AND p.owner_user_id=o.owner_user_id
    WHERE o.id=$1 AND o.owner_user_id=$2 AND o.state='paid'`,[component.source_order_id,owner])).rows[0];
   if(!proof||int64(proof.amount_fen)!==int64(proof.cash_amount_fen))throw evidence();
  }
  if(row.cash_order_id){const original=(await c.query('SELECT amount_fen,points FROM bb_recharge_orders WHERE id=$1',[row.cash_order_id])).rows[0];
   if(!original||!same(scalar,ratioOf(original.amount_fen,original.points)))throw evidence();}
  sources.push({lot_id:row.id,points:available.toString(),expires_at:row.expires_at?date(row.expires_at):null,cash_basis_fen:String(row.cash_basis_fen),cash_basis_points:String(row.cash_basis_points),cash_origin_lot_id:row.cash_origin_lot_id,components});
  total=add(total,ratio(scalar.numerator*available,scalar.denominator));
 }
 return{subscription,period,sources,held,total:bounded(total),target:SUBSCRIPTION_PLANS[target]};
}
export async function createSubscriptionChangeQuote(pool:Pool,owner:string,input:SubscriptionChangeQuoteRequest){
 const fingerprint=digest(JSON.stringify([input.plan_id,input.billing_cycle]));
 return transaction(pool,async c=>{
  await lockCreditAccount(c,owner);
  const prior=(await c.query('SELECT * FROM bb_subscription_change_quotes WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
  if(prior){if(prior.request_hash!==fingerprint)throw new Problem(409,'IDEMPOTENCY_CONFLICT','报价请求键已用于其他方案。');return{quote:quoteDto(prior)};}
  const state=await context(c,owner,input.plan_id,input.billing_cycle),annual=input.billing_cycle==='annual',face=BigInt(annual?state.target.annual_amount_fen:state.target.amount_fen),points=BigInt(state.target.points)*(annual?12n:1n);
  const offset=(state.total.numerator+state.total.denominator-1n)/state.total.denominator,cash=face-offset;
  if(cash<=0n)throw evidence();
  const consideration=bounded(divide(add(ratio(cash),state.total),ratio(points)));
  const row=(await c.query(`INSERT INTO bb_subscription_change_quotes(id,owner_user_id,request_id,request_hash,subscription_id,source_period_id,source_plan_id,target_plan_id,billing_cycle,
   face_amount_fen,credit_offset_fen,pay_now_fen,transfer_points,excluded_held_points,monthly_points,total_points,transfer_numerator,transfer_denominator,consideration_numerator,consideration_denominator,source_snapshot,task_price_version,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now()+interval '10 minutes') RETURNING *`,
   [uid(),owner,input.request_id,fingerprint,state.subscription.id,state.period.id,state.period.plan_id,input.plan_id,input.billing_cycle,face.toString(),offset.toString(),cash.toString(),state.sources.reduce((n,s)=>n+int64(s.points),0n).toString(),state.held.toString(),state.target.points,points.toString(),
    state.total.numerator.toString(),state.total.denominator.toString(),consideration.numerator.toString(),consideration.denominator.toString(),JSON.stringify(state.sources),await currentAutomaticPriceVersion(c)])).rows[0];
  return{quote:quoteDto(row)};
 });
}
async function changeEvent(c:PoolClient,owner:string,change:string,lot:string,points:string,kind:'hold'|'settle'|'release'){
 await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason)
  VALUES($1,$2,$3,$4,$5,$6,'subscription-change',$7)`,[uid(),owner,`subscription-change:${change}:${kind}:${lot}`,'subscription_change_'+kind,points,lot,'Preserve original paid rights during subscription change']);
}
export async function createSubscriptionChangeCheckout(pool:Pool,owner:string,input:SubscriptionChangeCheckoutRequest,providers:readonly PaymentProvider[]){
 const hash=digest(JSON.stringify(['subscription-change',input.quote_id,input.provider]));
 const prior=(await pool.query('SELECT o.*,ch.id change_id FROM bb_recharge_orders o LEFT JOIN bb_subscription_changes ch ON ch.order_id=o.id WHERE o.owner_user_id=$1 AND o.request_id=$2',[owner,input.request_id])).rows[0];
 if(prior){if(prior.request_hash.trim()!==hash||!prior.change_id)throw new Problem(409,'IDEMPOTENCY_CONFLICT','付款请求键已用于另一笔订单。');
  const s=(await pool.query('SELECT * FROM bb_subscriptions WHERE owner_user_id=$1',[owner])).rows[0];return{subscription:subscriptionDto(s),order:await openCheckout(pool,owner,prior,providers),change_id:prior.change_id};}
 const quote=(await pool.query('SELECT * FROM bb_subscription_change_quotes WHERE id=$1 AND owner_user_id=$2',[input.quote_id,owner])).rows[0];if(!quote)throw missing();
 const rejected=(await pool.query('SELECT request_hash FROM bb_subscription_change_rejections WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
 if(rejected){if(rejected.request_hash!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','付款请求键已用于另一项变更。');throw stale();}
 const s=(await pool.query('SELECT * FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2',[quote.subscription_id,owner])).rows[0];if(!s)throw missing();
 if(new Date(quote.expires_at).getTime()>Date.now()&&['pending','active','cancel_pending'].includes(s.mandate_status)){
  const stopped=await cancelSubscription(pool,owner,s.id,'change-cancel:'+input.request_id,providers);
  if(!['none','cancelled'].includes(stopped.mandate_status))throw new Problem(409,'SUBSCRIPTION_CHANGE_MANDATE_PENDING','原自动续费仍在解除核对中，请稍后重试同一付款请求。');
 }
 const provider=providers.find(p=>p.name===input.provider);if(!provider)throw new Problem(503,'PAYMENT_UNAVAILABLE','当前付款渠道暂不可用。');
 const made=await transaction(pool,async c=>{
  await assertChannelWritable(c,provider.name,provider.merchantId);await lockCreditAccount(c,owner);
  const rejected=(await c.query('SELECT request_hash FROM bb_subscription_change_rejections WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
  if(rejected){if(rejected.request_hash!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','付款请求键已用于另一项变更。');return{rejected:true as const};}
  const duplicate=(await c.query('SELECT o.*,ch.id change_id FROM bb_recharge_orders o LEFT JOIN bb_subscription_changes ch ON ch.order_id=o.id WHERE o.owner_user_id=$1 AND o.request_id=$2',[owner,input.request_id])).rows[0];
  if(duplicate){if(duplicate.request_hash.trim()!==hash||!duplicate.change_id)throw new Problem(409,'IDEMPOTENCY_CONFLICT','付款请求键已用于另一笔订单。');return{order:duplicate,change_id:duplicate.change_id};}
  const reject=async()=>{await c.query('INSERT INTO bb_subscription_change_rejections(owner_user_id,request_id,request_hash,quote_id) VALUES($1,$2,$3,$4)',[owner,input.request_id,hash,quote.id]);return{rejected:true as const};};
  if(new Date(quote.expires_at).getTime()<=Date.now())return reject();
  let current:Awaited<ReturnType<typeof context>>;
  try{current=await context(c,owner,quote.target_plan_id,quote.billing_cycle);}catch(error){if(error instanceof Problem&&error.code==='PAYMENT_INVALID')return reject();throw error;}
  if(current.period.id!==quote.source_period_id||canonical(current.sources)!==canonical(quote.source_snapshot))return reject();
  if(!['none','cancelled'].includes(current.subscription.mandate_status))throw new Problem(409,'SUBSCRIPTION_CHANGE_MANDATE_PENDING','原自动续费仍在解除核对中，请稍后重试同一付款请求。');
  const order=(await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CNY',$10,now()+interval '30 minutes','subscription') RETURNING *`,[uid().replaceAll('-',''),owner,input.request_id,hash,provider.name,`subscription_${quote.target_plan_id}_${quote.billing_cycle}_change`,SUBSCRIPTION_CATALOG_VERSION,quote.pay_now_fen,quote.total_points,provider.merchantId])).rows[0];
  const period=uid(),change=uid(),cycle=(await c.query('SELECT COALESCE(max(cycle_index),0)+1 n FROM bb_subscription_periods WHERE subscription_id=$1',[quote.subscription_id])).rows[0].n;
  await c.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,billing_cycle,funding_kind,face_amount_fen,consideration_numerator,consideration_denominator)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'mixed',$12,$13,$14)`,[period,owner,quote.subscription_id,cycle,order.id,quote.target_plan_id,SUBSCRIPTION_CATALOG_VERSION,quote.pay_now_fen,quote.total_points,quote.task_price_version,quote.billing_cycle,quote.face_amount_fen,quote.consideration_numerator,quote.consideration_denominator]);
  await c.query("INSERT INTO bb_subscription_changes(id,owner_user_id,quote_id,source_period_id,target_period_id,order_id,state) VALUES($1,$2,$3,$4,$5,$6,'held')",[change,owner,quote.id,quote.source_period_id,period,order.id]);
  for(const source of current.sources){
   await c.query('INSERT INTO bb_subscription_change_allocations(change_id,owner_user_id,lot_id,points) VALUES($1,$2,$3,$4)',[change,owner,source.lot_id,source.points]);
   const held=await c.query('UPDATE bb_credit_lots SET frozen=frozen+$3 WHERE id=$1 AND owner_user_id=$2 AND remaining-frozen>=$3 RETURNING id',[source.lot_id,owner,source.points]);if(!held.rowCount)throw evidence();
   await changeEvent(c,owner,change,source.lot_id,source.points,'hold');
  }
  const funding=async(kind:'new_cash'|'transfer',sourceOrder:string,sourceLot:string|null,amount:ExactRatio)=>{
   const value=bounded(amount),perPoint=bounded(divide(value,ratio(int64(quote.total_points))));
   await c.query(`INSERT INTO bb_subscription_funding_sources(id,period_id,owner_user_id,kind,source_order_id,source_lot_id,amount_numerator,amount_denominator,point_numerator,point_denominator)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[uid(),period,owner,kind,sourceOrder,sourceLot,value.numerator.toString(),value.denominator.toString(),perPoint.numerator.toString(),perPoint.denominator.toString()]);
  };
  await funding('new_cash',order.id,null,ratio(int64(quote.pay_now_fen)));
  for(const source of current.sources)for(const component of source.components)await funding('transfer',component.source_order_id,source.lot_id,ratio(int64(component.point_numerator)*int64(source.points),int64(component.point_denominator)));
  await c.query('UPDATE bb_subscriptions SET auto_renew=false,auto_renew_requested=false WHERE id=$1',[quote.subscription_id]);
  return{order,change_id:change};
 });
 if('rejected' in made)throw stale();
 const current=(await pool.query('SELECT * FROM bb_subscriptions WHERE owner_user_id=$1',[owner])).rows[0];
 return{subscription:subscriptionDto(current),order:await openCheckout(pool,owner,made.order,providers),change_id:made.change_id};
}
/** The verified-payment transaction owns the wallet lock and original order. */
export async function applySubscriptionChange(c:PoolClient,orderId:string){
 const change=(await c.query('SELECT * FROM bb_subscription_changes WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];if(!change)return false;
 if(change.state==='applied')return true;if(change.state!=='held')throw evidence();
 await c.query("UPDATE bb_subscription_changes SET state='applied',applied_at=now() WHERE id=$1",[change.id]);
 const allocations=(await c.query('SELECT * FROM bb_subscription_change_allocations WHERE change_id=$1 ORDER BY lot_id',[change.id])).rows;
 for(const allocation of allocations){
  const moved=await c.query('UPDATE bb_credit_lots SET frozen=frozen-$2,remaining=remaining-$2 WHERE id=$1 AND frozen>=$2 AND remaining>=$2 RETURNING id',[allocation.lot_id,allocation.points]);if(!moved.rowCount)throw evidence();
  await changeEvent(c,change.owner_user_id,change.id,allocation.lot_id,allocation.points,'settle');
 }
 await c.query("UPDATE bb_subscription_periods SET status='superseded' WHERE id=$1 AND status='active'",[change.source_period_id]);
 return true;
}
export async function failSubscriptionChange(c:PoolClient,orderId:string){
 const change=(await c.query('SELECT * FROM bb_subscription_changes WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];if(!change)return false;
 if(change.state!=='held')return true;
 await c.query("UPDATE bb_subscription_changes SET state='failed',finalized_at=now() WHERE id=$1",[change.id]);
 for(const allocation of (await c.query('SELECT * FROM bb_subscription_change_allocations WHERE change_id=$1 ORDER BY lot_id',[change.id])).rows){
  const freed=await c.query('UPDATE bb_credit_lots SET frozen=frozen-$2 WHERE id=$1 AND frozen>=$2 RETURNING id',[allocation.lot_id,allocation.points]);if(!freed.rowCount)throw evidence();
  await changeEvent(c,change.owner_user_id,change.id,allocation.lot_id,allocation.points,'release');
 }
 return true;
}
export async function restoreSubscriptionChange(c:PoolClient,orderId:string){
 const change=(await c.query('SELECT * FROM bb_subscription_changes WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];if(!change||change.state==='refunded')return;
 if(change.state!=='applied')throw evidence();
 await c.query("UPDATE bb_subscription_changes SET state='refunded',finalized_at=now() WHERE id=$1",[change.id]);
 const sources=(await c.query(`SELECT a.*,l.expires_at FROM bb_subscription_change_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id WHERE change_id=$1 ORDER BY a.lot_id`,[change.id])).rows;
 const restoredAt=new Date((await c.query("SELECT date_trunc('milliseconds',now()) value")).rows[0].value).getTime();
 for(const source of sources){
  const expiry=source.expires_at&&new Date(source.expires_at).getTime()<=restoredAt?new Date(restoredAt+7*86400000):source.expires_at;
  await grantCredits(c,{owner:change.owner_user_id,source:'subscription',key:`subscription-change-restore:${change.id}:${source.lot_id}`,points:source.points,expiresAt:expiry?date(expiry):null,actor:'subscription-change-refund',reason:'Restore transferred original rights without another cash refund'});
 }
}
export function installSubscriptionChanges(app:FastifyInstance,pool:Pool,owner:(r:FastifyRequest)=>Promise<string>,enabled:boolean,providers:readonly PaymentProvider[]){
 app.post('/api/v1/subscriptions/change-quotes',{schema:{body:schemas.SubscriptionChangeQuoteRequest,response:{201:schemas.SubscriptionChangeQuoteResponse}}},async(r,reply)=>{
  const user=await owner(r);if(!enabled)throw new Problem(503,'PAYMENT_UNAVAILABLE','订阅购买暂未开放。');return reply.code(201).send(await createSubscriptionChangeQuote(pool,user,r.body as SubscriptionChangeQuoteRequest));
 });
 app.post('/api/v1/subscriptions/change-checkouts',{schema:{body:schemas.SubscriptionChangeCheckoutRequest,response:{201:schemas.SubscriptionChangeCheckoutResponse}}},async(r,reply)=>{
  const user=await owner(r);if(!enabled)throw new Problem(503,'PAYMENT_UNAVAILABLE','订阅购买暂未开放。');return reply.code(201).send(await createSubscriptionChangeCheckout(pool,user,r.body as SubscriptionChangeCheckoutRequest,providers));
 });
}
