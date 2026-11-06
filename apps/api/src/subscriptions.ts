import {int64,encodeBillingDto,type BillingWireDto} from '@bondbuddy/contracts';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,schemas,
  type Subscription,type SubscriptionAccount,type SubscriptionCheckoutRequest,type SubscriptionCheckout,type SubscriptionAutoRenew,type SubscriptionAutoRenewRequest} from '@bondbuddy/contracts';
import {date,digest,missing,Problem,transaction,uid} from './data.js';
import {currentAutomaticPriceVersion} from './automatic-tariff-repository.js';
import {creditBalanceExact,grantCredits,lockCreditAccount,lockCreditAccountForControl} from './billing.js';
import {assertChannelWritable,withBillingDispatch} from './billing-safety.js';
import {applyVerifiedPayment,openCheckout,paymentOrder,refreshRecharge,type PaymentOrder,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {installSubscriptionChanges,applySubscriptionChange,failSubscriptionChange} from './subscription-changes.js';

export type MandateRequest={requestId:string;subscriptionId:string;merchantId:string;amountFen:number;currency:'CNY';interval:'month'|'year';mandateId:string|null};
/** An adapter may return this only after an authenticated channel query, never a browser redirect. */
export type VerifiedMandate={requestId:string;subscriptionId:string;merchantId:string;amountFen:number;currency:'CNY';interval?:'month'|'year';mandateId:string|null;state:'pending'|'active'|'cancelled'};
export interface RecurringPaymentProvider {
  createMandate(input:MandateRequest):Promise<{authorizationUrl:string}>;
  queryMandate(input:MandateRequest):Promise<VerifiedMandate>;
  cancelMandate(input:MandateRequest):Promise<VerifiedMandate>;
  /** The order id is the persistent channel idempotency key; a timeout is queried, never charged under a new id. */
  charge(order:PaymentOrder & {mandateId:string}):Promise<VerifiedPayment>;
  /** Optional only with a documented same-order/mandate idempotency guarantee.
   * Recover a dispatch interrupted before sending; never create another intent. */
  recoverSameRequest?(order:PaymentOrder & {mandateId:string}):Promise<VerifiedPayment>;
}
export const supportsAutomaticRenewal=(p:PaymentProvider):boolean=>!!p.recurring&&
  ['createMandate','queryMandate','cancelMandate','charge'].every(k=>typeof (p.recurring as any)[k]==='function');
const invalid=(message:string)=>new Problem(409,'PAYMENT_INVALID',message);
const safePoints=(value:unknown)=>{try{return int64(value);}catch{throw new Problem(503,'DATA_UNAVAILABLE','积分分项仍在核对，请稍后读取。');}};
const unavailable=()=>new Problem(503,'PAYMENT_UNAVAILABLE','当前渠道未配置经核验的自动续费能力，可手动开通或续订月度方案。');
const plan=(id:string)=>{const p=SUBSCRIPTION_PLANS.find(p=>p.id===id);if(!p)throw new Problem(422,'VALIDATION_FAILED','未知订阅方案。');return p;};
const observed=(s:any)=>s.observed_at?new Date(s.observed_at).getTime():Date.now();
const adapter=(ps:readonly PaymentProvider[],name:string,merchant?:string)=>{const p=ps.find(p=>p.name===name&&(!merchant||p.merchantId===merchant));if(!p)throw unavailable();return p;};
export const subscriptionDto=(s:any):Subscription=>({id:s.id,plan_id:s.plan_id,
  status:s.status==='active'&&s.current_period_end&&new Date(s.current_period_end).getTime()<=observed(s)?'expired':s.status,
  auto_renew:s.auto_renew,mandate_status:s.mandate_status,current_period_start:s.current_period_start?date(s.current_period_start):null,
  current_period_end:s.current_period_end?date(s.current_period_end):null,task_price_version:s.task_price_version,billing_cycle:s.billing_cycle??'monthly',
  next_charge_at:s.auto_renew&&s.mandate_status==='active'&&s.current_period_end?date(s.current_period_end):null,
  next_charge_amount_fen:s.auto_renew&&s.mandate_status==='active'?Number(s.billing_amount_fen??plan(s.plan_id).amount_fen):null});
async function subscriptionEvent(c:PoolClient,s:any,type:string,payload:object={}){
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'subscription',$3,$4,$5)`,[uid(),s.owner_user_id,s.id,type,JSON.stringify({subscription_id:s.id,...payload})]);
}
/** Current paid month pins task tariffs even after renewal cancellation. The credits themselves live for 90 days. */
export async function resolveActiveSubscriptionPrice(c:Pool|PoolClient,owner:string):Promise<string|null>{
  const row=(await c.query(`SELECT task_price_version FROM bb_subscription_periods WHERE owner_user_id=$1 AND status='active'
    AND starts_at<=bb_subscription_clock($1) AND ends_at>bb_subscription_clock($1) ORDER BY starts_at DESC,id DESC LIMIT 1`,[owner])).rows[0];
  return row?.task_price_version??null;
}
export async function subscriptionAccount(pool:Pool,owner:string):Promise<BillingWireDto<SubscriptionAccount,'subscriptionAccount'>>{
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const s=(await c.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE owner_user_id=$1',[owner])).rows[0];
    const balance=await creditBalanceExact(c,owner);
    const b=(await c.query(`SELECT
      COALESCE(sum(remaining-frozen) FILTER(WHERE source='subscription' AND (expires_at IS NULL OR expires_at>now())),0)::text subscription,
      COALESCE(sum(remaining-frozen) FILTER(WHERE source='purchase' AND (expires_at IS NULL OR expires_at>now())),0)::text topup,
      (SELECT COALESCE(sum(a.points),0)::text FROM bb_payment_refund_allocations a JOIN bb_payment_refunds r ON r.id=a.refund_id AND r.owner_user_id=a.owner_user_id
        WHERE a.owner_user_id=$1 AND r.state IN ('requested','processing')) refund_held,
      (SELECT COALESCE(sum(a.points),0)::text FROM bb_subscription_change_allocations a JOIN bb_subscription_changes ch ON ch.id=a.change_id
        WHERE a.owner_user_id=$1 AND ch.state='held') change_held
      FROM bb_credit_lots WHERE owner_user_id=$1`,[owner])).rows[0];
    const periods=(await c.query(subscriptionPeriodQuery('p.owner_user_id=$1 ORDER BY p.cycle_index DESC LIMIT 50'),[owner])).rows;
    const refundHeld=safePoints(b.refund_held),changeHeld=safePoints(b.change_held),subscriptionAvailable=safePoints(b.subscription),topupAvailable=safePoints(b.topup);
    return encodeBillingDto('subscriptionAccount',{subscription:s?subscriptionDto(s):null,available_points:balance.available,held_points:balance.frozen,
      task_held_points:safePoints(balance.frozen-refundHeld-changeHeld),refund_held_points:refundHeld,change_held_points:changeHeld,
      subscription_available_points:subscriptionAvailable,topup_available_points:topupAvailable,other_available_points:safePoints(balance.available-subscriptionAvailable-topupAvailable),
      periods:periods.map(p=>({id:p.id,order_id:p.order_id,plan_id:p.plan_id,status:p.status,amount_fen:Number(p.amount_fen),points:Number(p.points),
        face_amount_fen:Number(p.face_amount_fen),funding_kind:p.funding_kind,change_held_points:safePoints(p.change_held),
        billing_cycle:p.billing_cycle,monthly_points:Number(p.monthly_points),release_count:p.billing_cycle==='annual'?12:1,released_count:Number(p.released_count),next_release_at:p.next_release_at?date(p.next_release_at):null,
        available_points:safePoints(p.available??0),held_points:safePoints(p.frozen??0),
        task_held_points:safePoints(int64(p.frozen??0)-safePoints(p.refund_held)-safePoints(p.change_held)),refund_held_points:safePoints(p.refund_held),
        starts_at:p.starts_at?date(p.starts_at):null,ends_at:p.ends_at?date(p.ends_at):null,credits_expires_at:p.credits_expires_at?date(p.credits_expires_at):null,
        refundable_until:p.starts_at?new Date(new Date(p.starts_at).getTime()+7*86400000).toISOString():null}))});
  });
}
/** One original order can own several issued lots; unissued rights are never a balance. */
export function subscriptionPeriodQuery(where:string){return `SELECT p.*,totals.remaining,totals.frozen,totals.available,totals.refund_held,totals.change_held,
  CASE WHEN p.billing_cycle='annual' THEN (SELECT count(*) FROM bb_subscription_credit_releases WHERE period_id=p.id AND state='issued') ELSE CASE WHEN p.lot_id IS NULL THEN 0 ELSE 1 END END released_count,
  (SELECT min(due_at) FROM bb_subscription_credit_releases WHERE period_id=p.id AND state='scheduled') next_release_at
  FROM bb_subscription_periods p LEFT JOIN LATERAL(
   SELECT COALESCE(sum(l.remaining),0)::text remaining,COALESCE(sum(l.frozen),0)::text frozen,
    COALESCE(sum(l.remaining-l.frozen) FILTER(WHERE l.expires_at IS NULL OR l.expires_at>now()),0)::text available,
    COALESCE(sum((SELECT COALESCE(sum(a.points),0) FROM bb_payment_refund_allocations a JOIN bb_payment_refunds r ON r.id=a.refund_id
     WHERE a.lot_id=l.id AND a.owner_user_id=p.owner_user_id AND r.state IN ('requested','processing'))),0)::text refund_held,
    COALESCE(sum((SELECT COALESCE(sum(a.points),0) FROM bb_subscription_change_allocations a JOIN bb_subscription_changes ch ON ch.id=a.change_id
     WHERE a.lot_id=l.id AND a.owner_user_id=p.owner_user_id AND ch.state='held')),0)::text change_held
   FROM bb_credit_lots l WHERE l.owner_user_id=p.owner_user_id AND (l.id=p.lot_id OR l.cash_origin_lot_id=p.lot_id OR l.id IN (SELECT lot_id FROM bb_subscription_credit_releases WHERE period_id=p.id AND state='issued')
    OR l.cash_origin_lot_id IN (SELECT lot_id FROM bb_subscription_credit_releases WHERE period_id=p.id AND state='issued'))
  ) totals ON true WHERE ${where}`;}
async function insertPeriod(c:PoolClient,s:any,p:ReturnType<typeof plan>,provider:PaymentProvider,requestId:string,hash:string,automatic:boolean){
  const taskPriceVersion=await currentAutomaticPriceVersion(c);
  const annual=s.billing_cycle==='annual',amountFen=automatic?Number(s.billing_amount_fen):annual?p.annual_amount_fen:p.amount_fen,points=p.points*(annual?12:1);
  const cycle=Number((await c.query('SELECT COALESCE(max(cycle_index),0)+1 n FROM bb_subscription_periods WHERE subscription_id=$1',[s.id])).rows[0].n);
  const order=(await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CNY',$10,now()+interval '30 minutes','subscription') RETURNING *`,
    [uid().replaceAll('-',''),s.owner_user_id,requestId,hash,provider.name,`subscription_${p.id}${annual?'_annual':''}`,SUBSCRIPTION_CATALOG_VERSION,amountFen,points,provider.merchantId])).rows[0];
  const period=(await c.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,automatic,billing_cycle)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [uid(),s.owner_user_id,s.id,cycle,order.id,p.id,SUBSCRIPTION_CATALOG_VERSION,amountFen,points,taskPriceVersion,automatic,annual?'annual':'monthly'])).rows[0];
  await subscriptionEvent(c,s,'subscription.payment_requested',{period_id:period.id,order_id:order.id,automatic});
  return {order,period};
}
export async function createSubscriptionCheckout(pool:Pool,owner:string,input:SubscriptionCheckoutRequest,providers:readonly PaymentProvider[],subscriptionId?:string):Promise<SubscriptionCheckout>{
  const p=plan(input.plan_id),provider=adapter(providers,input.provider),billingCycle=input.billing_cycle??'monthly';
  if(!['monthly','annual'].includes(billingCycle))throw new Problem(422,'VALIDATION_FAILED','未知订阅周期。');
  const amountFen=billingCycle==='annual'?p.annual_amount_fen:p.amount_fen;
  const hash=digest(JSON.stringify(['subscription',subscriptionId??null,input.plan_id,input.provider,...(billingCycle==='annual'?['annual']:[])]));
  // Recover a checkout that never reached the channel before its deadline. Do
  // not free the pending-period fence on local time or a query exception alone.
  const pending=(await pool.query(`SELECT o.id,o.expires_at FROM bb_subscription_periods p JOIN bb_recharge_orders o ON o.id=p.order_id
    WHERE p.owner_user_id=$1 AND p.status='pending'`,[owner])).rows[0];
  if(pending&&new Date(pending.expires_at).getTime()<=Date.now())
    try{await refreshRecharge(pool,owner,pending.id,providers);}catch{/* Unknown stays pending and the transaction below rejects another purchase. */}
  const result=await transaction(pool,async c=>{
    await assertChannelWritable(c,provider.name,provider.merchantId);
    await lockCreditAccount(c,owner);
    const previous=(await c.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
    if(previous){
      if(previous.request_hash.trim()!==hash||previous.order_kind!=='subscription')throw new Problem(409,'IDEMPOTENCY_CONFLICT','付款请求键已用于另一笔订单。');
      const old=(await c.query(`SELECT s.* FROM bb_subscriptions s JOIN bb_subscription_periods p ON p.subscription_id=s.id WHERE p.order_id=$1 AND s.owner_user_id=$2`,[previous.id,owner])).rows[0];
      return {subscription:old,order:previous};
    }
    let s=(await c.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE owner_user_id=$1 FOR UPDATE',[owner])).rows[0];
    const taskPriceVersion=await currentAutomaticPriceVersion(c);
    if(subscriptionId&&s?.id!==subscriptionId)throw missing();
    if(s){
      if(s.current_period_end&&new Date(s.current_period_end).getTime()>observed(s))throw invalid('当前订阅周期尚未结束；额度不足可直接充值，下周期再调整方案。');
      if((await c.query("SELECT 1 FROM bb_subscription_periods WHERE subscription_id=$1 AND status='pending'",[s.id])).rowCount)throw invalid('已有订阅付款待核对，请继续原订单，避免重复付款。');
      if(s.mandate_status==='active'||s.mandate_status==='pending'||s.mandate_status==='cancel_pending')throw invalid('请先关闭并核实原自动续费授权，再手动开通下一周期。');
      s=(await c.query(`UPDATE bb_subscriptions SET plan_id=$2,provider=$3,merchant_id=$4,status='pending',auto_renew=false,auto_renew_requested=false,
        task_price_version=$5,billing_cycle=$6,billing_amount_fen=$7,updated_at=now() WHERE id=$1 RETURNING *`,[s.id,p.id,provider.name,provider.merchantId,taskPriceVersion,billingCycle,amountFen])).rows[0];
    }else{
      s=(await c.query(`INSERT INTO bb_subscriptions(id,owner_user_id,plan_id,provider,merchant_id,task_price_version,billing_cycle,billing_amount_fen)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[uid(),owner,p.id,provider.name,provider.merchantId,taskPriceVersion,billingCycle,amountFen])).rows[0];
    }
    const made=await insertPeriod(c,s,p,provider,input.request_id,hash,false);return {subscription:s,order:made.order};
  });
  const order=await openCheckout(pool,owner,result.order,providers);
  return {subscription:subscriptionDto(result.subscription),order};
}
/** Called inside the verified-payment transaction, after the account and order are locked. */
export async function activateSubscriptionPayment(c:PoolClient,order:any,actor:string):Promise<string>{
  const period=(await c.query('SELECT * FROM bb_subscription_periods WHERE order_id=$1 AND owner_user_id=$2 FOR UPDATE',[order.id,order.owner_user_id])).rows[0];
  if(!period||Number(period.amount_fen)!==Number(order.amount_fen)||Number(period.points)!==Number(order.points))throw invalid('订阅订单与冻结的周期权益不一致。');
  if(period.lot_id)return period.lot_id;
  const changed=await applySubscriptionChange(c,order.id);
  const dates=(await c.query("SELECT bb_subscription_clock($1) starts_at,bb_subscription_clock($1)+$2*interval '1 month' ends_at,bb_subscription_clock($1)+interval '90 days' expires_at",[order.owner_user_id,period.billing_cycle==='annual'?12:1])).rows[0];
  if(period.billing_cycle==='annual')await c.query(`INSERT INTO bb_subscription_credit_releases(id,owner_user_id,period_id,installment_index,due_at,points,amount_fen)
    SELECT $1||':'||n,$2,$1,n,$3::timestamptz+(n-1)*interval '1 month',$4,floor($5::numeric*n/12)-floor($5::numeric*(n-1)/12) FROM generate_series(1,12) n`,[period.id,order.owner_user_id,dates.starts_at,period.monthly_points,period.amount_fen]);
  const lotId=await grantCredits(c,{owner:order.owner_user_id,source:'subscription',key:`recharge:${order.id}`,points:Number(period.monthly_points),expiresAt:date(dates.expires_at),actor,reason:`verified_subscription:${period.id}`});
  if(period.billing_cycle==='annual')await c.query("UPDATE bb_subscription_credit_releases SET state='issued',lot_id=$2,issued_at=$3,expires_at=$4 WHERE period_id=$1 AND installment_index=1",[period.id,lotId,dates.starts_at,dates.expires_at]);
  await c.query("UPDATE bb_subscription_periods SET status='active',lot_id=$2,starts_at=$3,ends_at=$4,credits_expires_at=$5 WHERE id=$1",[period.id,lotId,dates.starts_at,dates.ends_at,dates.expires_at]);
  if(changed)await c.query(`UPDATE bb_subscriptions SET status='active',provider=$2,merchant_id=$3,billing_cycle=$4,billing_amount_fen=$5,
    auto_renew=false,auto_renew_requested=false,mandate_status='none',mandate_request_id=NULL,mandate_ref=NULL,mandate_url=NULL WHERE id=$1`,
    [period.subscription_id,order.provider,order.merchant_id,period.billing_cycle,period.face_amount_fen]);
  const s=(await c.query(`UPDATE bb_subscriptions SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'active' END,
    plan_id=$2,current_period_start=$3,current_period_end=$4,task_price_version=$5,updated_at=now() WHERE id=$1 RETURNING *`,
    [period.subscription_id,period.plan_id,dates.starts_at,dates.ends_at,period.task_price_version])).rows[0];
  await subscriptionEvent(c,s,'subscription.period_activated',{period_id:period.id,order_id:order.id,lot_id:lotId});
  return lotId;
}
export async function markSubscriptionPaymentFailed(c:PoolClient,orderId:string){
  const changed=await failSubscriptionChange(c,orderId);
  const p=(await c.query("UPDATE bb_subscription_periods SET status='failed' WHERE order_id=$1 AND status='pending' RETURNING *",[orderId])).rows[0];
  if(p&&!changed)await c.query("UPDATE bb_subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'past_due' END,auto_renew=false,updated_at=now() WHERE id=$1",[p.subscription_id]);
}
async function recordAction(c:PoolClient,s:any,requestId:string,operation:string,value:unknown){
  const hash=digest(JSON.stringify([s.id,operation,value]));
  const previous=(await c.query('SELECT * FROM bb_subscription_actions WHERE owner_user_id=$1 AND request_id=$2',[s.owner_user_id,requestId])).rows[0];
  if(previous){if(previous.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','订阅操作键已用于另一项变更。');return false;}
  await c.query('INSERT INTO bb_subscription_actions(owner_user_id,request_id,operation,request_hash,subscription_id) VALUES($1,$2,$3,$4,$5)',[s.owner_user_id,requestId,operation,hash,s.id]);return true;
}
function mandateRequest(s:any):MandateRequest{return{requestId:s.mandate_request_id,subscriptionId:s.id,merchantId:s.merchant_id,amountFen:Number(s.billing_amount_fen),currency:'CNY',interval:s.billing_cycle==='annual'?'year':'month',mandateId:s.mandate_ref};}
async function applyMandate(pool:Pool,owner:string,id:string,receipt:VerifiedMandate):Promise<any>{
  return transaction(pool,async c=>{
    await lockCreditAccountForControl(c,owner);
    const s=(await c.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,owner])).rows[0];if(!s)throw missing();
    if(receipt.requestId!==s.mandate_request_id||receipt.subscriptionId!==id||receipt.merchantId!==s.merchant_id||receipt.currency!=='CNY'||receipt.amountFen!==Number(s.billing_amount_fen)||
      (s.billing_cycle==='annual'?receipt.interval!=='year':receipt.interval!==undefined&&receipt.interval!=='month')||
      !['pending','active','cancelled'].includes(receipt.state)||receipt.state==='active'&&(!receipt.mandateId||receipt.mandateId.length>128)||s.mandate_ref&&receipt.mandateId&&s.mandate_ref!==receipt.mandateId)throw invalid('自动续费授权回执不匹配。');
    const status=receipt.state==='active'&&!s.auto_renew_requested?'cancel_pending':receipt.state;
    const updated=(await c.query(`UPDATE bb_subscriptions SET mandate_ref=COALESCE(mandate_ref,$2),mandate_status=$3,
      auto_renew=($3='active' AND auto_renew_requested AND status='active'),updated_at=now() WHERE id=$1 RETURNING *`,[id,receipt.mandateId,status])).rows[0];
    await subscriptionEvent(c,updated,'subscription.mandate_verified',{state:status});return {...updated,observed_at:s.observed_at};
  });
}
export async function refreshSubscriptionMandate(pool:Pool,owner:string,id:string,providers:readonly PaymentProvider[]):Promise<SubscriptionAutoRenew>{
  let s=(await pool.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2',[id,owner])).rows[0];if(!s)throw missing();
  const provider=adapter(providers,s.provider,s.merchant_id);if(!supportsAutomaticRenewal(provider))throw unavailable();
  if(s.mandate_request_id&&['pending','active','cancel_pending'].includes(s.mandate_status)){
    let receipt:VerifiedMandate;
    try{receipt=await provider.recurring![s.mandate_status==='cancel_pending'?'cancelMandate':'queryMandate'](mandateRequest(s));}
    catch{return{subscription:subscriptionDto(s),authorization_url:s.mandate_url};}
    s=await applyMandate(pool,owner,id,receipt);
  }
  return{subscription:subscriptionDto(s),authorization_url:s.mandate_status==='pending'?s.mandate_url:null};
}
export async function setSubscriptionAutoRenew(pool:Pool,owner:string,id:string,input:SubscriptionAutoRenewRequest,providers:readonly PaymentProvider[]):Promise<SubscriptionAutoRenew>{
  const result=await transaction(pool,async c=>{
    if(input.enabled){
      const channel=(await c.query('SELECT provider,merchant_id FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2',[id,owner])).rows[0];if(!channel)throw missing();
      await assertChannelWritable(c,channel.provider,channel.merchant_id);
      await lockCreditAccount(c,owner);
    }else await lockCreditAccountForControl(c,owner);
    let s=(await c.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,owner])).rows[0];if(!s)throw missing();
    const provider=adapter(providers,s.provider,s.merchant_id);if(!supportsAutomaticRenewal(provider))throw unavailable();
    if(!await recordAction(c,s,input.request_id,'auto_renew',input.enabled))return{s,provider,create:false};
    if(input.enabled){
      if(!s.current_period_end||new Date(s.current_period_end).getTime()<=observed(s))throw invalid('请先开通有效订阅周期，再授权自动续费。');
      if(s.mandate_status==='cancel_pending')throw invalid('原授权仍在取消核对中，请完成原操作后再开启。');
      const create=['none','cancelled'].includes(s.mandate_status);
      s=(await c.query(`UPDATE bb_subscriptions SET status='active',auto_renew_requested=true,
        auto_renew=(mandate_status='active'),mandate_status=CASE WHEN $2 THEN 'pending' ELSE mandate_status END,
        mandate_request_id=CASE WHEN $2 THEN $3 ELSE mandate_request_id END,mandate_ref=CASE WHEN $2 THEN NULL ELSE mandate_ref END,
        mandate_url=CASE WHEN $2 THEN NULL ELSE mandate_url END,updated_at=now() WHERE id=$1 RETURNING *`,[id,create,uid().replaceAll('-','')])).rows[0];
      return{s,provider,create};
    }
    s=(await c.query(`UPDATE bb_subscriptions SET auto_renew=false,auto_renew_requested=false,
      mandate_status=CASE WHEN mandate_status IN ('pending','active') THEN 'cancel_pending' ELSE mandate_status END,updated_at=now() WHERE id=$1 RETURNING *`,[id])).rows[0];
    return{s,provider,create:false};
  });
  if(result.create){
    let response:{authorizationUrl:string};try{response=await withBillingDispatch(pool,owner,result.provider.name,result.provider.merchantId,()=>result.provider.recurring!.createMandate(mandateRequest(result.s)));}catch{return{subscription:subscriptionDto(result.s),authorization_url:null};}
    if(!/^https:\/\//.test(response.authorizationUrl)||response.authorizationUrl.length>4096)throw unavailable();
    await pool.query("UPDATE bb_subscriptions SET mandate_url=$3 WHERE id=$1 AND mandate_request_id=$2 AND auto_renew_requested",[id,result.s.mandate_request_id,response.authorizationUrl]);
    return{subscription:subscriptionDto(result.s),authorization_url:response.authorizationUrl};
  }
  return refreshSubscriptionMandate(pool,owner,id,providers);
}
export async function cancelSubscription(pool:Pool,owner:string,id:string,requestId:string,providers:readonly PaymentProvider[]):Promise<Subscription>{
  const s=await transaction(pool,async c=>{
    await lockCreditAccountForControl(c,owner);
    const row=(await c.query('SELECT * FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,owner])).rows[0];if(!row)throw missing();
    if(!await recordAction(c,row,requestId,'cancel',true))return row;
    const updated=(await c.query(`UPDATE bb_subscriptions SET status='cancelled',auto_renew=false,auto_renew_requested=false,
      mandate_status=CASE WHEN mandate_status IN ('pending','active') THEN 'cancel_pending' ELSE mandate_status END,updated_at=now() WHERE id=$1 RETURNING *`,[id])).rows[0];
    await subscriptionEvent(c,updated,'subscription.cancelled');return updated;
  });
  if(s.mandate_status==='cancel_pending'&&providers.some(p=>p.name===s.provider&&p.merchantId===s.merchant_id&&supportsAutomaticRenewal(p)))
    return(await refreshSubscriptionMandate(pool,owner,id,providers)).subscription;
  return subscriptionDto(s);
}
/** Runs only against providers with an implemented mandate adapter. No lease creates duplicate channel orders. */
export async function processDueSubscriptionRenewals(pool:Pool,providers:readonly PaymentProvider[],limit=50,ownerUserId?:string){
  const eligible=providers.filter(supportsAutomaticRenewal);if(!eligible.length)return{checked:0};
  const ids=(await pool.query("SELECT id,owner_user_id FROM bb_subscriptions WHERE auto_renew AND status='active' AND current_period_end<=bb_subscription_clock(owner_user_id) AND ($2::text IS NULL OR owner_user_id=$2) ORDER BY current_period_end,id LIMIT $1",[Math.max(1,Math.min(limit,100)),ownerUserId??null])).rows;
  for(const target of ids){
    const claimed=await transaction(pool,async c=>{
      const channel=(await c.query('SELECT provider,merchant_id FROM bb_subscriptions WHERE id=$1',[target.id])).rows[0];if(!channel)return null;
      await assertChannelWritable(c,channel.provider,channel.merchant_id);
      await lockCreditAccount(c,target.owner_user_id);
      const s=(await c.query('SELECT *,bb_subscription_clock(owner_user_id) observed_at FROM bb_subscriptions WHERE id=$1 FOR UPDATE',[target.id])).rows[0];
      const provider=eligible.find(p=>p.name===s.provider&&p.merchantId===s.merchant_id);
      if(!provider||!s.auto_renew||s.status!=='active'||new Date(s.current_period_end).getTime()>observed(s)||s.mandate_status!=='active'||!s.mandate_ref)return null;
      let period=(await c.query("SELECT * FROM bb_subscription_periods WHERE subscription_id=$1 AND status='pending' FOR UPDATE",[s.id])).rows[0];
      let order:any;
      if(period){if(!period.automatic)return null;order=(await c.query('SELECT * FROM bb_recharge_orders WHERE id=$1',[period.order_id])).rows[0];}
      else{
        const key=`renew:${s.id}:${date(s.current_period_end)}`;
        ({period,order}=await insertPeriod(c,s,plan(s.plan_id),provider,key,digest(key),true));
      }
      const create=!period.payment_dispatch_started_at;
      if(create)await c.query('UPDATE bb_subscription_periods SET payment_dispatch_started_at=now() WHERE id=$1',[period.id]);
      return{provider,order,mandateId:s.mandate_ref,create};
    }).catch(error=>{if(error instanceof Problem&&error.code==='BILLING_NOT_READY')return null;throw error;});
    if(!claimed)continue;
    try{
      const input={...paymentOrder(claimed.order),mandateId:claimed.mandateId},recurring=claimed.provider.recurring!;
      let receipt:VerifiedPayment|undefined;
      if(claimed.create)receipt=await withBillingDispatch(pool,target.owner_user_id,claimed.provider.name,claimed.provider.merchantId,()=>recurring.charge(input));
      else{
        // The dispatch marker commits before I/O, so a process can stop before
        // the channel ever receives the authorised original request. Query is
        // still read-only; only an explicitly capable adapter may recover it.
        try{receipt=await claimed.provider.query(paymentOrder(claimed.order));}
        catch(error){if(!recurring.recoverSameRequest)throw error;}
        if(receipt&&receipt.orderId!==claimed.order.id)throw invalid('续费渠道查单与原订单不一致。');
        if((!receipt||receipt.state==='pending')&&recurring.recoverSameRequest)
          receipt=await withBillingDispatch(pool,target.owner_user_id,claimed.provider.name,claimed.provider.merchantId,()=>recurring.recoverSameRequest!(input));
      }
      if(!receipt||receipt.orderId!==claimed.order.id)throw invalid('续费渠道回执与原订单不一致。');
      await applyVerifiedPayment(pool,claimed.provider,receipt);
    }catch{
      // Unknown payment or a mismatched receipt leaves the same intent pending for query/reconciliation.
      // Do not manufacture a failed payment or a second charge.
    }
  }
  return{checked:ids.length};
}
/** Replays a durable due installment under the same wallet lock as tasks/refunds.
 * Cancellation of next year's mandate does not withdraw this paid year's rights. */
export async function processDueSubscriptionCreditReleases(pool:Pool,limit=100,ownerUserId?:string){
  const due=(await pool.query(`SELECT r.id,r.owner_user_id FROM bb_subscription_credit_releases r JOIN bb_subscription_periods p ON p.id=r.period_id
    WHERE r.state='scheduled' AND p.status='active' AND r.due_at<=bb_subscription_clock(r.owner_user_id)
    AND ($2::text IS NULL OR r.owner_user_id=$2) AND NOT EXISTS(SELECT 1 FROM bb_payment_refunds WHERE order_id=p.order_id AND state IN ('requested','processing','succeeded'))
    ORDER BY r.due_at,r.id LIMIT $1`,[Math.max(1,Math.min(limit,1000)),ownerUserId??null])).rows;
  let issued=0;
  for(const target of due){
    const result=await transaction(pool,async c=>{
      await lockCreditAccount(c,target.owner_user_id);
      const r=(await c.query(`SELECT r.*,p.order_id,p.status period_status,o.state order_state,bb_subscription_clock(r.owner_user_id) observed_at
        FROM bb_subscription_credit_releases r JOIN bb_subscription_periods p ON p.id=r.period_id JOIN bb_recharge_orders o ON o.id=p.order_id
        WHERE r.id=$1 AND r.owner_user_id=$2 FOR UPDATE OF r`,[target.id,target.owner_user_id])).rows[0];
      if(!r||r.state!=='scheduled'||r.period_status!=='active'||r.order_state!=='paid'||new Date(r.due_at)>new Date(r.observed_at))return false;
      if((await c.query("SELECT 1 FROM bb_payment_refunds WHERE order_id=$1 AND state IN ('requested','processing','succeeded')",[r.order_id])).rowCount)return false;
      const expires=(await c.query("SELECT bb_subscription_clock($1)+interval '90 days' value",[r.owner_user_id])).rows[0].value;
      const lot=await grantCredits(c,{owner:r.owner_user_id,source:'subscription',key:`subscription-release:${r.id}`,points:Number(r.points),expiresAt:date(expires),actor:'subscription-scheduler',reason:`paid_annual_installment:${r.installment_index}`});
      await c.query("UPDATE bb_subscription_credit_releases SET state='issued',lot_id=$2,issued_at=$3,expires_at=$4 WHERE id=$1",[r.id,lot,r.observed_at,expires]);
      await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'subscription_release',$3,'subscription.credits_released',$4)`,[uid(),r.owner_user_id,r.id,{period_id:r.period_id,installment_index:r.installment_index,lot_id:lot}]);
      return true;
    }).catch(error=>{if(error instanceof Problem&&error.code==='BILLING_NOT_READY')return false;throw error;});
    if(result)issued++;
  }
  return{checked:due.length,issued};
}
export function installSubscriptions(app:FastifyInstance,pool:Pool,owner:(r:FastifyRequest)=>Promise<string>,enabled:boolean,providers:readonly PaymentProvider[]){
  installSubscriptionChanges(app,pool,owner,enabled,providers);
  app.get('/api/v1/subscriptions/catalog',{schema:{response:{200:schemas.SubscriptionCatalogResponse}}},async r=>{
    await owner(r);return{enabled,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,
      providers:enabled?providers.map(p=>p.name):[],auto_renew_available:enabled&&providers.some(supportsAutomaticRenewal)};
  });
  app.get('/api/v1/subscriptions/account',{schema:{response:{200:schemas.SubscriptionAccountResponse}}},async r=>subscriptionAccount(pool,await owner(r)));
  app.post('/api/v1/subscriptions',{schema:{body:schemas.SubscriptionCheckoutRequest,response:{201:schemas.SubscriptionCheckoutResponse}}},async(r,reply)=>{
    const user=await owner(r);if(!enabled)throw unavailable();return reply.code(201).send(await createSubscriptionCheckout(pool,user,r.body as SubscriptionCheckoutRequest,providers));
  });
  app.post('/api/v1/subscriptions/:subscription_id/renew',{schema:{body:schemas.SubscriptionCheckoutRequest,response:{201:schemas.SubscriptionCheckoutResponse}}},async(r,reply)=>{
    const user=await owner(r);if(!enabled)throw unavailable();return reply.code(201).send(await createSubscriptionCheckout(pool,user,r.body as SubscriptionCheckoutRequest,providers,(r.params as any).subscription_id));
  });
  app.post('/api/v1/subscriptions/:subscription_id/cancel',{schema:{body:schemas.SubscriptionCancelRequest,response:{200:schemas.SubscriptionResponse}}},async r=>
    cancelSubscription(pool,await owner(r),(r.params as any).subscription_id,(r.body as {request_id:string}).request_id,providers));
  app.post('/api/v1/subscriptions/:subscription_id/auto-renew',{schema:{body:schemas.SubscriptionAutoRenewRequest,response:{200:schemas.SubscriptionAutoRenewResponse}}},async r=>{
    const user=await owner(r);if(!enabled)throw unavailable();return setSubscriptionAutoRenew(pool,user,(r.params as any).subscription_id,r.body as SubscriptionAutoRenewRequest,providers);
  });
  app.post('/api/v1/subscriptions/:subscription_id/auto-renew/refresh',{schema:{body:{type:'object',additionalProperties:false},response:{200:schemas.SubscriptionAutoRenewResponse}}},async r=>
    refreshSubscriptionMandate(pool,await owner(r),(r.params as any).subscription_id,providers));
  if(enabled){
    let busy=false;
    const timer=setInterval(()=>{if(busy)return;busy=true;void (async()=>{await processDueSubscriptionCreditReleases(pool);await processDueSubscriptionRenewals(pool,providers);})().catch(e=>app.log.error({err:e},'Subscription renewal/release reconciliation failed')).finally(()=>{busy=false;});},60000);
    timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);});
  }
}
