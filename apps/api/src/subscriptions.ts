import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,SUBSCRIPTION_TASK_PRICE_VERSION,schemas,
  type Subscription,type SubscriptionAccount,type SubscriptionCheckoutRequest,type SubscriptionCheckout,type SubscriptionAutoRenew,type SubscriptionAutoRenewRequest} from '@bondbuddy/contracts';
import {date,digest,missing,Problem,transaction,uid} from './data.js';
import {creditBalance,grantCredits,lockCreditAccount} from './billing.js';
import {applyVerifiedPayment,openCheckout,paymentOrder,refreshRecharge,type PaymentOrder,type PaymentProvider,type VerifiedPayment} from './payments.js';

export type MandateRequest={requestId:string;subscriptionId:string;merchantId:string;amountFen:number;currency:'CNY';interval:'month';mandateId:string|null};
/** An adapter may return this only after an authenticated channel query, never a browser redirect. */
export type VerifiedMandate={requestId:string;subscriptionId:string;merchantId:string;amountFen:number;currency:'CNY';mandateId:string|null;state:'pending'|'active'|'cancelled'};
export interface RecurringPaymentProvider {
  createMandate(input:MandateRequest):Promise<{authorizationUrl:string}>;
  queryMandate(input:MandateRequest):Promise<VerifiedMandate>;
  cancelMandate(input:MandateRequest):Promise<VerifiedMandate>;
  /** The order id is the persistent channel idempotency key; a timeout is queried, never charged under a new id. */
  charge(order:PaymentOrder & {mandateId:string}):Promise<VerifiedPayment>;
}
export const supportsAutomaticRenewal=(p:PaymentProvider):boolean=>!!p.recurring&&
  ['createMandate','queryMandate','cancelMandate','charge'].every(k=>typeof (p.recurring as any)[k]==='function');
const invalid=(message:string)=>new Problem(409,'PAYMENT_INVALID',message);
const unavailable=()=>new Problem(503,'PAYMENT_UNAVAILABLE','当前渠道未配置经核验的自动续费能力，可手动开通或续订月度方案。');
const plan=(id:string)=>{const p=SUBSCRIPTION_PLANS.find(p=>p.id===id);if(!p)throw new Problem(422,'VALIDATION_FAILED','未知订阅方案。');return p;};
const adapter=(ps:readonly PaymentProvider[],name:string,merchant?:string)=>{const p=ps.find(p=>p.name===name&&(!merchant||p.merchantId===merchant));if(!p)throw unavailable();return p;};
export const subscriptionDto=(s:any):Subscription=>({id:s.id,plan_id:s.plan_id,
  status:s.status==='active'&&s.current_period_end&&new Date(s.current_period_end).getTime()<=Date.now()?'expired':s.status,
  auto_renew:s.auto_renew,mandate_status:s.mandate_status,current_period_start:s.current_period_start?date(s.current_period_start):null,
  current_period_end:s.current_period_end?date(s.current_period_end):null,task_price_version:s.task_price_version});
async function subscriptionEvent(c:PoolClient,s:any,type:string,payload:object={}){
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'subscription',$3,$4,$5)`,[uid(),s.owner_user_id,s.id,type,JSON.stringify({subscription_id:s.id,...payload})]);
}
/** Current paid month pins task tariffs even after renewal cancellation. The credits themselves live for 90 days. */
export async function resolveActiveSubscriptionPrice(c:PoolClient,owner:string):Promise<string|null>{
  const row=(await c.query(`SELECT task_price_version FROM bb_subscription_periods WHERE owner_user_id=$1 AND status='active'
    AND starts_at<=now() AND ends_at>now() ORDER BY starts_at DESC,id DESC LIMIT 1`,[owner])).rows[0];
  return row?.task_price_version??null;
}
export async function subscriptionAccount(pool:Pool,owner:string):Promise<SubscriptionAccount>{
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const s=(await c.query('SELECT * FROM bb_subscriptions WHERE owner_user_id=$1',[owner])).rows[0];
    const balance=await creditBalance(c,owner);
    const b=(await c.query(`SELECT
      COALESCE(sum(remaining-frozen) FILTER(WHERE source='subscription' AND (expires_at IS NULL OR expires_at>now())),0)::text subscription,
      COALESCE(sum(remaining-frozen) FILTER(WHERE source='purchase' AND (expires_at IS NULL OR expires_at>now())),0)::text topup
      FROM bb_credit_lots WHERE owner_user_id=$1`,[owner])).rows[0];
    const periods=(await c.query(`SELECT p.*,l.remaining,l.frozen,(l.expires_at>now()) unexpired FROM bb_subscription_periods p
      LEFT JOIN bb_credit_lots l ON l.id=p.lot_id AND l.owner_user_id=p.owner_user_id WHERE p.owner_user_id=$1 ORDER BY p.cycle_index DESC LIMIT 50`,[owner])).rows;
    return {subscription:s?subscriptionDto(s):null,available_points:balance.available,held_points:balance.frozen,
      subscription_available_points:Number(b.subscription),topup_available_points:Number(b.topup),other_available_points:balance.available-Number(b.subscription)-Number(b.topup),
      periods:periods.map(p=>({id:p.id,order_id:p.order_id,plan_id:p.plan_id,status:p.status,amount_fen:Number(p.amount_fen),points:Number(p.points),
        available_points:p.unexpired?Number(p.remaining??0)-Number(p.frozen??0):0,held_points:Number(p.frozen??0),
        starts_at:p.starts_at?date(p.starts_at):null,ends_at:p.ends_at?date(p.ends_at):null,credits_expires_at:p.credits_expires_at?date(p.credits_expires_at):null,
        refundable_until:p.starts_at?new Date(new Date(p.starts_at).getTime()+7*86400000).toISOString():null}))};
  });
}
async function insertPeriod(c:PoolClient,s:any,p:ReturnType<typeof plan>,provider:PaymentProvider,requestId:string,hash:string,automatic:boolean){
  const cycle=Number((await c.query('SELECT COALESCE(max(cycle_index),0)+1 n FROM bb_subscription_periods WHERE subscription_id=$1',[s.id])).rows[0].n);
  const order=(await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CNY',$10,now()+interval '30 minutes','subscription') RETURNING *`,
    [uid().replaceAll('-',''),s.owner_user_id,requestId,hash,provider.name,`subscription_${p.id}`,SUBSCRIPTION_CATALOG_VERSION,p.amount_fen,p.points,provider.merchantId])).rows[0];
  const period=(await c.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,automatic)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [uid(),s.owner_user_id,s.id,cycle,order.id,p.id,SUBSCRIPTION_CATALOG_VERSION,p.amount_fen,p.points,SUBSCRIPTION_TASK_PRICE_VERSION,automatic])).rows[0];
  await subscriptionEvent(c,s,'subscription.payment_requested',{period_id:period.id,order_id:order.id,automatic});
  return {order,period};
}
export async function createSubscriptionCheckout(pool:Pool,owner:string,input:SubscriptionCheckoutRequest,providers:readonly PaymentProvider[],subscriptionId?:string):Promise<SubscriptionCheckout>{
  const p=plan(input.plan_id),provider=adapter(providers,input.provider);
  const hash=digest(JSON.stringify(['subscription',subscriptionId??null,input.plan_id,input.provider]));
  // Recover a checkout that never reached the channel before its deadline. Do
  // not free the pending-period fence on local time or a query exception alone.
  const pending=(await pool.query(`SELECT o.id,o.expires_at FROM bb_subscription_periods p JOIN bb_recharge_orders o ON o.id=p.order_id
    WHERE p.owner_user_id=$1 AND p.status='pending'`,[owner])).rows[0];
  if(pending&&new Date(pending.expires_at).getTime()<=Date.now())
    try{await refreshRecharge(pool,owner,pending.id,providers);}catch{/* Unknown stays pending and the transaction below rejects another purchase. */}
  const result=await transaction(pool,async c=>{
    await lockCreditAccount(c,owner);
    const previous=(await c.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
    if(previous){
      if(previous.request_hash.trim()!==hash||previous.order_kind!=='subscription')throw new Problem(409,'IDEMPOTENCY_CONFLICT','付款请求键已用于另一笔订单。');
      const old=(await c.query(`SELECT s.* FROM bb_subscriptions s JOIN bb_subscription_periods p ON p.subscription_id=s.id WHERE p.order_id=$1 AND s.owner_user_id=$2`,[previous.id,owner])).rows[0];
      return {subscription:old,order:previous};
    }
    let s=(await c.query('SELECT * FROM bb_subscriptions WHERE owner_user_id=$1 FOR UPDATE',[owner])).rows[0];
    if(subscriptionId&&s?.id!==subscriptionId)throw missing();
    if(s){
      if(s.current_period_end&&new Date(s.current_period_end).getTime()>Date.now())throw invalid('当前订阅周期尚未结束；额度不足可直接充值，下周期再调整方案。');
      if((await c.query("SELECT 1 FROM bb_subscription_periods WHERE subscription_id=$1 AND status='pending'",[s.id])).rowCount)throw invalid('已有订阅付款待核对，请继续原订单，避免重复付款。');
      if(s.mandate_status==='active'||s.mandate_status==='pending'||s.mandate_status==='cancel_pending')throw invalid('请先关闭并核实原自动续费授权，再手动开通下一周期。');
      s=(await c.query(`UPDATE bb_subscriptions SET plan_id=$2,provider=$3,merchant_id=$4,status='pending',auto_renew=false,auto_renew_requested=false,
        task_price_version=$5,updated_at=now() WHERE id=$1 RETURNING *`,[s.id,p.id,provider.name,provider.merchantId,SUBSCRIPTION_TASK_PRICE_VERSION])).rows[0];
    }else{
      s=(await c.query(`INSERT INTO bb_subscriptions(id,owner_user_id,plan_id,provider,merchant_id,task_price_version)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uid(),owner,p.id,provider.name,provider.merchantId,SUBSCRIPTION_TASK_PRICE_VERSION])).rows[0];
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
  const dates=(await c.query("SELECT now() starts_at,now()+interval '1 month' ends_at,now()+interval '90 days' expires_at")).rows[0];
  const lotId=await grantCredits(c,{owner:order.owner_user_id,source:'subscription',key:`recharge:${order.id}`,points:Number(order.points),expiresAt:date(dates.expires_at),actor,reason:`verified_subscription:${period.id}`});
  await c.query("UPDATE bb_subscription_periods SET status='active',lot_id=$2,starts_at=$3,ends_at=$4,credits_expires_at=$5 WHERE id=$1",[period.id,lotId,dates.starts_at,dates.ends_at,dates.expires_at]);
  const s=(await c.query(`UPDATE bb_subscriptions SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'active' END,
    plan_id=$2,current_period_start=$3,current_period_end=$4,task_price_version=$5,updated_at=now() WHERE id=$1 RETURNING *`,
    [period.subscription_id,period.plan_id,dates.starts_at,dates.ends_at,period.task_price_version])).rows[0];
  await subscriptionEvent(c,s,'subscription.period_activated',{period_id:period.id,order_id:order.id,lot_id:lotId});
  return lotId;
}
export async function markSubscriptionPaymentFailed(c:PoolClient,orderId:string){
  const p=(await c.query("UPDATE bb_subscription_periods SET status='failed' WHERE order_id=$1 AND status='pending' RETURNING *",[orderId])).rows[0];
  if(p)await c.query("UPDATE bb_subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'past_due' END,auto_renew=false,updated_at=now() WHERE id=$1",[p.subscription_id]);
}
async function recordAction(c:PoolClient,s:any,requestId:string,operation:string,value:unknown){
  const hash=digest(JSON.stringify([s.id,operation,value]));
  const previous=(await c.query('SELECT * FROM bb_subscription_actions WHERE owner_user_id=$1 AND request_id=$2',[s.owner_user_id,requestId])).rows[0];
  if(previous){if(previous.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','订阅操作键已用于另一项变更。');return false;}
  await c.query('INSERT INTO bb_subscription_actions(owner_user_id,request_id,operation,request_hash,subscription_id) VALUES($1,$2,$3,$4,$5)',[s.owner_user_id,requestId,operation,hash,s.id]);return true;
}
function mandateRequest(s:any):MandateRequest{return{requestId:s.mandate_request_id,subscriptionId:s.id,merchantId:s.merchant_id,amountFen:plan(s.plan_id).amount_fen,currency:'CNY',interval:'month',mandateId:s.mandate_ref};}
async function applyMandate(pool:Pool,owner:string,id:string,receipt:VerifiedMandate):Promise<any>{
  return transaction(pool,async c=>{
    await lockCreditAccount(c,owner);
    const s=(await c.query('SELECT * FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,owner])).rows[0];if(!s)throw missing();
    if(receipt.requestId!==s.mandate_request_id||receipt.subscriptionId!==id||receipt.merchantId!==s.merchant_id||receipt.currency!=='CNY'||receipt.amountFen!==plan(s.plan_id).amount_fen||
      !['pending','active','cancelled'].includes(receipt.state)||receipt.state==='active'&&(!receipt.mandateId||receipt.mandateId.length>128)||s.mandate_ref&&receipt.mandateId&&s.mandate_ref!==receipt.mandateId)throw invalid('自动续费授权回执不匹配。');
    const status=receipt.state==='active'&&!s.auto_renew_requested?'cancel_pending':receipt.state;
    const updated=(await c.query(`UPDATE bb_subscriptions SET mandate_ref=COALESCE(mandate_ref,$2),mandate_status=$3,
      auto_renew=($3='active' AND auto_renew_requested AND status='active'),updated_at=now() WHERE id=$1 RETURNING *`,[id,receipt.mandateId,status])).rows[0];
    await subscriptionEvent(c,updated,'subscription.mandate_verified',{state:status});return updated;
  });
}
export async function refreshSubscriptionMandate(pool:Pool,owner:string,id:string,providers:readonly PaymentProvider[]):Promise<SubscriptionAutoRenew>{
  let s=(await pool.query('SELECT * FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2',[id,owner])).rows[0];if(!s)throw missing();
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
    await lockCreditAccount(c,owner);
    let s=(await c.query('SELECT * FROM bb_subscriptions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,owner])).rows[0];if(!s)throw missing();
    const provider=adapter(providers,s.provider,s.merchant_id);if(!supportsAutomaticRenewal(provider))throw unavailable();
    if(!await recordAction(c,s,input.request_id,'auto_renew',input.enabled))return{s,provider,create:false};
    if(input.enabled){
      if(!s.current_period_end||new Date(s.current_period_end).getTime()<=Date.now())throw invalid('请先开通有效订阅周期，再授权自动续费。');
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
    let response:{authorizationUrl:string};try{response=await result.provider.recurring!.createMandate(mandateRequest(result.s));}catch{return{subscription:subscriptionDto(result.s),authorization_url:null};}
    if(!/^https:\/\//.test(response.authorizationUrl)||response.authorizationUrl.length>4096)throw unavailable();
    await pool.query("UPDATE bb_subscriptions SET mandate_url=$3 WHERE id=$1 AND mandate_request_id=$2 AND auto_renew_requested",[id,result.s.mandate_request_id,response.authorizationUrl]);
    return{subscription:subscriptionDto(result.s),authorization_url:response.authorizationUrl};
  }
  return refreshSubscriptionMandate(pool,owner,id,providers);
}
export async function cancelSubscription(pool:Pool,owner:string,id:string,requestId:string,providers:readonly PaymentProvider[]):Promise<Subscription>{
  const s=await transaction(pool,async c=>{
    await lockCreditAccount(c,owner);
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
export async function processDueSubscriptionRenewals(pool:Pool,providers:readonly PaymentProvider[],limit=50){
  const eligible=providers.filter(supportsAutomaticRenewal);if(!eligible.length)return{checked:0};
  const ids=(await pool.query("SELECT id,owner_user_id FROM bb_subscriptions WHERE auto_renew AND status='active' AND current_period_end<=now() ORDER BY current_period_end,id LIMIT $1",[Math.max(1,Math.min(limit,100))])).rows;
  for(const target of ids){
    const claimed=await transaction(pool,async c=>{
      await lockCreditAccount(c,target.owner_user_id);
      const s=(await c.query('SELECT * FROM bb_subscriptions WHERE id=$1 FOR UPDATE',[target.id])).rows[0];
      const provider=eligible.find(p=>p.name===s.provider&&p.merchantId===s.merchant_id);
      if(!provider||!s.auto_renew||s.status!=='active'||new Date(s.current_period_end).getTime()>Date.now()||s.mandate_status!=='active'||!s.mandate_ref)return null;
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
    });
    if(!claimed)continue;
    try{
      const receipt=claimed.create?await claimed.provider.recurring!.charge({...paymentOrder(claimed.order),mandateId:claimed.mandateId}):await claimed.provider.query(paymentOrder(claimed.order));
      await applyVerifiedPayment(pool,claimed.provider,receipt);
    }catch{
      // Unknown payment or a mismatched receipt leaves the same intent pending for query/reconciliation.
      // Do not manufacture a failed payment or a second charge.
    }
  }
  return{checked:ids.length};
}
export function installSubscriptions(app:FastifyInstance,pool:Pool,owner:(r:FastifyRequest)=>Promise<string>,enabled:boolean,providers:readonly PaymentProvider[]){
  app.get('/api/v1/subscriptions/catalog',{schema:{response:{200:schemas.SubscriptionCatalogResponse}}},async r=>{
    await owner(r);return{enabled:enabled&&providers.length>0,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,
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
  if(enabled&&providers.some(supportsAutomaticRenewal)){
    let busy=false;
    const timer=setInterval(()=>{if(busy)return;busy=true;void processDueSubscriptionRenewals(pool,providers).catch(e=>app.log.error({err:e},'Subscription renewal reconciliation failed')).finally(()=>{busy=false;});},60000);
    timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);});
  }
}
