import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Static } from '@sinclair/typebox';
import { RECHARGE_PACKS, RECHARGE_PACK_VERSION, OUTCOME_PRICE_VERSION, schemas, type CommerceTopup } from '@bondbuddy/contracts';
import { date, digest, missing, Problem, project, transaction, uid } from './data.js';
import { grantCredits } from './billing.js';

type OrderRequest=Static<typeof schemas.RechargeOrderRequest>;
export type PaymentOrder={id:string;merchant_id:string;amount_fen:number;currency:'CNY';expires_at:string};
/** Only a channel adapter after signature/decryption or authenticated query may produce this receipt. */
export type VerifiedPayment={orderId:string;merchantId:string;amountFen:number;currency:string;transactionId:string|null;state:'pending'|'paid'|'failed'|'expired'};
export interface PaymentProvider {
  readonly name:OrderRequest['provider']; readonly merchantId:string;
  create(order:PaymentOrder):Promise<{checkoutUrl:string}>;
  query(order:PaymentOrder):Promise<VerifiedPayment>;
  verifyCallback(headers:FastifyRequest['headers'],rawBody:string):Promise<VerifiedPayment>;
  acknowledgement:object;
}
export function paymentOrder(row:any):PaymentOrder{return {id:row.id,merchant_id:row.merchant_id,amount_fen:Number(row.amount_fen),currency:row.currency,expires_at:date(row.expires_at)};}
export function rechargeDto(row:any):Static<typeof schemas.RechargeOrderResponse>{return {order_id:row.id,provider:row.provider,state:row.state,
  amount_fen:Number(row.amount_fen),points:Number(row.points),currency:row.currency,checkout_url:row.checkout_url,
  project_id:row.project_id,expires_at:date(row.expires_at),credited_at:row.credited_at?date(row.credited_at):null};}
const unavailable=()=>new Problem(503,'PAYMENT_UNAVAILABLE','Payment channel is not configured');
function adapter(providers:readonly PaymentProvider[],name:string,merchantId?:string){
  const p=providers.find(p=>p.name===name&&(!merchantId||p.merchantId===merchantId));if(!p)throw unavailable();return p;
}
export async function applyVerifiedPayment(pool:Pool,provider:PaymentProvider,receipt:VerifiedPayment){
  return transaction(pool,async c=>{
    const order=(await c.query('SELECT * FROM bb_recharge_orders WHERE id=$1 FOR UPDATE',[receipt.orderId])).rows[0];
    if(!order)throw missing();
    if(order.provider!==provider.name||order.merchant_id!==provider.merchantId||receipt.merchantId!==order.merchant_id||
      receipt.currency!==order.currency||receipt.amountFen!==Number(order.amount_fen)||
      !Number.isSafeInteger(receipt.amountFen)||!['pending','paid','expired','failed'].includes(receipt.state)||receipt.state==='paid'&&(!receipt.transactionId||receipt.transactionId.length>128))
      throw new Problem(422,'PAYMENT_INVALID','Verified payment does not match the locked order');
    if(order.provider_txn_id&&receipt.transactionId&&order.provider_txn_id!==receipt.transactionId)
      throw new Problem(409,'PAYMENT_INVALID','Payment transaction conflicts with the order');
    if(receipt.state==='paid'){
      // Payment success and credit issuance commit together. A callback/query retry
      // after a database failure recovers the same order, without another payment.
      await grantCredits(c,{owner:order.owner_user_id,source:'purchase',key:`recharge:${order.id}`,points:Number(order.points),expiresAt:null,actor:`payment:${provider.name}`,reason:`verified_order:${order.id}`});
      await c.query("UPDATE bb_recharge_orders SET state='paid',provider_txn_id=$2,credited_at=COALESCE(credited_at,now()) WHERE id=$1",[order.id,receipt.transactionId]);
    }else if(order.state!=='paid'&&receipt.state!=='pending'){
      await c.query('UPDATE bb_recharge_orders SET state=$2 WHERE id=$1',[order.id,receipt.state]);
    }
    return rechargeDto((await c.query('SELECT * FROM bb_recharge_orders WHERE id=$1',[order.id])).rows[0]);
  });
}
export async function createRecharge(pool:Pool,owner:string,input:OrderRequest,providers:readonly PaymentProvider[]){
  const p=adapter(providers,input.provider),pack=RECHARGE_PACKS.find(p=>p.id===input.pack_id);
  if(!pack)throw new Problem(422,'VALIDATION_FAILED','Unknown recharge pack');
  const hash=digest(JSON.stringify([input.provider,input.pack_id,input.project_id??null]));
  const order=await transaction(pool,async c=>{
    if(input.project_id)await project(c,owner,input.project_id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`recharge:${owner}:${input.request_id}`]);
    const old=(await c.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
    if(old){if(old.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Recharge key already used');return old;}
    return (await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,project_id,merchant_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CNY',$10,$11,now()+interval '30 minutes') RETURNING *`,
      [uid().replaceAll('-',''),owner,input.request_id,hash,p.name,pack.id,RECHARGE_PACK_VERSION,pack.amount_fen,pack.points,input.project_id??null,p.merchantId])).rows[0];
  });
  return openCheckout(pool,owner,order,providers);
}
/** Exact-amount service balance; purchased minor units equal cash paid, without a pack minimum or bonus. */
export async function createServiceTopup(pool:Pool,owner:string,input:CommerceTopup,providers:readonly PaymentProvider[]){
  if(!Number.isSafeInteger(input.amount_fen)||input.amount_fen<1||input.amount_fen>1000000)throw new Problem(422,'VALIDATION_FAILED','Invalid CNY amount');
  const p=adapter(providers,input.provider),hash=digest(JSON.stringify(['service_balance',input.provider,input.amount_fen,input.project_id??null]));
  const order=await transaction(pool,async c=>{
    if(input.project_id)await project(c,owner,input.project_id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`recharge:${owner}:${input.request_id}`]);
    const old=(await c.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
    if(old){if(old.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Payment key already used');return old;}
    return (await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,project_id,merchant_id,expires_at)
      VALUES($1,$2,$3,$4,$5,'service_balance',$6,$7,$7,'CNY',$8,$9,now()+interval '30 minutes') RETURNING *`,
      [uid().replaceAll('-',''),owner,input.request_id,hash,p.name,OUTCOME_PRICE_VERSION,input.amount_fen,input.project_id??null,p.merchantId])).rows[0];
  });
  return openCheckout(pool,owner,order,providers);
}
async function openCheckout(pool:Pool,owner:string,order:any,providers:readonly PaymentProvider[]):Promise<Static<typeof schemas.RechargeOrderResponse>>{
  if(order.state!=='pending'||order.checkout_url)return rechargeDto(order);
  if(new Date(order.expires_at).getTime()<=Date.now())return refreshRecharge(pool,owner,order.id,providers);
  const originalProvider=adapter(providers,order.provider,order.merchant_id);
  let checkoutUrl:string;
  try{({checkoutUrl}=await originalProvider.create(paymentOrder(order)));}catch{throw unavailable();}
  if(checkoutUrl.length>4096||!(/^https:\/\//.test(checkoutUrl)||/^weixin:\/\/wxpay\/bizpayurl\?/.test(checkoutUrl)))throw unavailable();
  const saved=await pool.query("UPDATE bb_recharge_orders SET checkout_url=COALESCE(checkout_url,$3) WHERE id=$1 AND owner_user_id=$2 RETURNING *",[order.id,owner,checkoutUrl]);
  return rechargeDto(saved.rows[0]);
}
export async function refreshRecharge(pool:Pool,owner:string,id:string,providers:readonly PaymentProvider[]):Promise<Static<typeof schemas.RechargeOrderResponse>>{
  const order=(await pool.query('SELECT * FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2',[id,owner])).rows[0];
  if(!order)throw missing();if(order.state==='paid')return rechargeDto(order);
  const p=adapter(providers,order.provider,order.merchant_id);
  let receipt:VerifiedPayment;try{receipt=await p.query(paymentOrder(order));}catch{throw unavailable();}
  if(receipt.orderId!==order.id)throw new Problem(422,'PAYMENT_INVALID','Provider returned another order');
  const updated=await applyVerifiedPayment(pool,p,receipt);
  // Recover the same payment intent after a create timeout, rather than asking for another payment.
  if(updated.state==='pending'&&!updated.checkout_url&&new Date(order.expires_at).getTime()>Date.now())return openCheckout(pool,owner,order,providers);
  return updated;
}
export function installPayments(app:FastifyInstance,pool:Pool,owner:(r:FastifyRequest)=>Promise<string>,enabled:boolean,providers:readonly PaymentProvider[]){
  app.get('/api/v1/credits/recharge-config',{schema:{response:{200:schemas.RechargeConfigResponse}}},async r=>{
    await owner(r);return {enabled:enabled&&providers.length>0,providers:enabled?providers.map(p=>p.name):[],packs:RECHARGE_PACKS,pack_version:RECHARGE_PACK_VERSION};
  });
  app.post('/api/v1/credits/recharge-orders',{schema:{body:schemas.RechargeOrderRequest,response:{201:schemas.RechargeOrderResponse}}},async(r,reply)=>{
    const user=await owner(r);if(!enabled)throw unavailable();
    return reply.code(201).send(await createRecharge(pool,user,r.body as OrderRequest,providers));
  });
  app.get('/api/v1/credits/recharge-orders/:order_id',{schema:{response:{200:schemas.RechargeOrderResponse}}},async r=>{
    const user=await owner(r),id=(r.params as {order_id:string}).order_id;
    const row=(await pool.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1 AND id=$2',[user,id])).rows[0];if(!row)throw missing();return rechargeDto(row);
  });
  app.post('/api/v1/credits/recharge-orders/:order_id/refresh',{schema:{body:{type:'object',additionalProperties:false},response:{200:schemas.RechargeOrderResponse}}},async r=>
    refreshRecharge(pool,await owner(r),(r.params as {order_id:string}).order_id,providers));
  // Callbacks remain available when new sales are disabled, so real already-paid
  // orders can still receive their credits. No sandbox-pay endpoint is installed.
  app.register(async child=>{
    child.removeContentTypeParser('application/json');
    child.addContentTypeParser('application/json',{parseAs:'string',bodyLimit:65536},(_r,body,done)=>done(null,body));
    child.post('/api/v1/payments/:provider/callback',{bodyLimit:65536},async r=>{
      const p=adapter(providers,(r.params as {provider:string}).provider);
      let receipt:VerifiedPayment;try{receipt=await p.verifyCallback(r.headers,r.body as string);}catch{throw new Problem(401,'PAYMENT_INVALID','Payment signature verification failed');}
      await applyVerifiedPayment(pool,p,receipt);return p.acknowledgement;
    });
  });
}
