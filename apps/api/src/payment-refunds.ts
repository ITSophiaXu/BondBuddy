import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {schemas,type PaymentRefund,type PaymentRefundRequest,type PaymentRefundEligibility} from '@bondbuddy/contracts';
import {lockCreditAccount} from './billing.js';
import {date,digest,missing,Problem,transaction,uid} from './data.js';
import type {PaymentProvider} from './payments.js';
import {cumulativeRefundFen} from './payment-refund-calculation.js';

export type RefundOrder={id:string;order_id:string;merchant_id:string;provider_transaction_id:string;currency:'CNY';order_amount_fen:number;amount_fen:number};
/** Produced only by an authenticated channel response or a verified/decrypted callback. */
export type VerifiedRefund={refundId:string;orderId:string;merchantId:string;transactionId:string;providerRefundId:string;
  currency:string;orderAmountFen:number;amountFen:number;payerTotalFen:number;payerRefundFen:number;
  state:'processing'|'succeeded'|'failed';failureCode?:string};
export interface PaymentRefundProvider{
  create(order:RefundOrder):Promise<VerifiedRefund>;
  query(order:RefundOrder):Promise<VerifiedRefund>;
  /** Only adapters with a documented identical-request idempotency guarantee may expose this. */
  recoverSameRequest?(order:RefundOrder):Promise<VerifiedRefund>;
  verifyCallback(headers:FastifyRequest['headers'],rawBody:string):Promise<VerifiedRefund>;
}
const unavailable=()=>new Problem(503,'PAYMENT_UNAVAILABLE','原支付渠道暂未开放自动退款，请联系支持核实原单。');
const invalid=()=>new Problem(422,'PAYMENT_INVALID','Refund receipt does not match the locked original payment');
const terminal=(state:string)=>state==='succeeded'||state==='failed';
function refundProvider(providers:readonly PaymentProvider[],row:any){
  const provider=providers.find(p=>p.name===row.provider&&p.merchantId===row.merchant_id&&p.refunds);
  if(!provider?.refunds)throw unavailable();return provider;
}
export const refundDto=(r:any):PaymentRefund=>({refund_id:r.id,order_id:r.order_id,currency:'CNY',amount_fen:Number(r.amount_fen),credit_points:Number(r.credit_points),state:r.state,
  created_at:date(r.created_at),updated_at:date(r.updated_at),completed_at:r.completed_at?date(r.completed_at):null,failure_code:r.failure_code??null});
const refundOrder=(r:any):RefundOrder=>({id:r.id,order_id:r.order_id,merchant_id:r.merchant_id,provider_transaction_id:r.provider_txn_id,
  currency:r.currency,order_amount_fen:Number(r.order_amount_fen),amount_fen:Number(r.amount_fen)});
async function event(c:PoolClient,row:any,kind:'requested'|'dispatch'|'processing'|'succeeded'|'failed'){
  const key=`refund:${row.id}:${kind}`;
  const inserted=await c.query(`INSERT INTO bb_payment_refund_events(id,refund_id,owner_user_id,lot_id,event_key,kind,amount_fen,cash_refunded_fen)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_key) DO NOTHING RETURNING id`,[uid(),row.id,row.owner_user_id,row.lot_id,key,kind,row.amount_fen,kind==='succeeded'?row.amount_fen:0]);
  if(inserted.rowCount){
    if(['requested','succeeded','failed'].includes(kind)){
      const allocations=(await c.query('SELECT lot_id,points FROM bb_payment_refund_allocations WHERE refund_id=$1 ORDER BY lot_id',[row.id])).rows;
      for(const allocation of allocations)await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason)
        VALUES($1,$2,$3,$4,$5,$6,'payment-refund',$7)`,[uid(),row.owner_user_id,`refund-credit:${row.id}:${kind}${allocation.lot_id===row.lot_id?'':':'+allocation.lot_id}`,
        kind==='requested'?'refund_hold':kind==='succeeded'?'refund_settle':'refund_release',allocation.points,allocation.lot_id,`original_order:${row.order_id}`]);
    }
    await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'payment_refund',$3,$4,$5)`,[uid(),row.owner_user_id,row.id,`payment_refund.${kind}`,JSON.stringify({refund_id:row.id,order_id:row.order_id,currency:'CNY',amount_fen:Number(row.amount_fen),credit_points:Number(row.credit_points)})]);
  }
}

/** Records independent payer cash evidence; nominal total still controls legitimate payment crediting. */
export async function recordPaymentCashProof(c:PoolClient,order:any,lotId:string,cash:{amountFen:number;currency:string}|undefined){
  if(!cash||cash.currency!=='CNY')return;
  if(!Number.isSafeInteger(cash.amountFen)||cash.amountFen<0||cash.amountFen>Number(order.amount_fen))throw invalid();
  const old=(await c.query('SELECT * FROM bb_payment_cash_proofs WHERE order_id=$1',[order.id])).rows[0];
  if(old){
    if(old.lot_id!==lotId||old.provider_txn_id!==order.provider_txn_id||Number(old.cash_amount_fen)!==cash.amountFen)throw new Problem(409,'PAYMENT_INVALID','Authenticated cash evidence conflicts with the original receipt');
    return;
  }
  await c.query(`INSERT INTO bb_payment_cash_proofs(order_id,owner_user_id,lot_id,provider,merchant_id,provider_txn_id,currency,order_amount_fen,cash_amount_fen)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[order.id,order.owner_user_id,lotId,order.provider,order.merchant_id,order.provider_txn_id,order.currency,order.amount_fen,cash.amountFen]);
}

function eligibilityReason(order:any,proof:any,lot:any,providers:readonly PaymentProvider[],active:boolean,available:number,period?:any){
  const subscription=order.order_kind==='subscription';
  if(order.state!=='paid')return '该订单尚未确认实付到账，暂无可退现金。';
  if(!proof)return '该订单缺少已认证的实付金额证据，请联系支持核实原付款后处理。';
  if(Number(proof.cash_amount_fen)!==Number(order.amount_fen))return '该订单含优惠或实付与服务余额不等额，请联系支持按原实付凭证处理。';
  if(!lot||lot.id!==proof.lot_id||lot.source!==(subscription?'subscription':'purchase')||lot.source_key!==`recharge:${order.id}`||
    Number(lot.original_points)!==Number(order.points)||!subscription&&lot.expires_at||
    ![Number(order.amount_fen),Number(order.points)].every(Number.isSafeInteger)||Number(order.amount_fen)<1||Number(order.amount_fen)>1000000||Number(order.points)<1||Number(order.points)>1150000)return '原订单服务余额归属待核实，请联系支持处理。';
  if(!providers.some(p=>p.name===order.provider&&p.merchantId===order.merchant_id&&p.refunds))return '原支付渠道暂未开放自动退款，请联系支持核实原单。';
  if(active)return '该订单已有退款处理中，相关金额保持冻结；请刷新原退款单。';
  if(subscription&&(!period||period.status!=='active'||Date.now()>new Date(period.starts_at).getTime()+7*86400000||
    Number(lot.remaining)!==Number(period.points)||Number(lot.frozen)!==0||period.historically_used))return '订阅仅支持到账后7天内、整期额度从未消费且未被任务预留的全额退款；取消续订不影响原90天额度权益。';
  if(available<=0)return '该订单已消费、已退款或被任务预留的余额不能申请退款。';
  return '';
}
const requestUnit=(order:any):'amount_fen'|'points'=>order.order_kind==='subscription'||Number(order.points)===Number(order.amount_fen)?'amount_fen':'points';
async function refundTotals(c:PoolClient,owner:string,orderId:string){
  return (await c.query(`SELECT COALESCE(sum(amount_fen) FILTER(WHERE state IN ('requested','processing')),0)::text held,
    COALESCE(sum(amount_fen) FILTER(WHERE state='succeeded'),0)::text refunded,
    COALESCE(sum(credit_points) FILTER(WHERE state='succeeded'),0)::text refunded_points,
    count(*) FILTER(WHERE state IN ('requested','processing'))::integer active FROM bb_payment_refunds WHERE owner_user_id=$1 AND order_id=$2`,[owner,orderId])).rows[0];
}
/** Restored purchased rights retain the original cash basis and source family.
 * Expired or frozen credits cannot be turned into cash by pooling unrelated lots. */
async function refundableLots(c:PoolClient,owner:string,order:any,proof:any,lock=false){
  if(!proof)return [];
  return (await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND
    (id=$2 OR ($3='recharge' AND cash_origin_lot_id=$2 AND cash_order_id=$4 AND cash_basis_fen=$5 AND cash_basis_points=$6 AND source='purchase'))
    AND (expires_at IS NULL OR expires_at>now()) ORDER BY id ${lock?'FOR UPDATE':''}`,
    [owner,proof.lot_id,order.order_kind,order.id,proof.cash_amount_fen,order.points])).rows;
}
function cashForPoints(order:any,totals:any,points:number){
  try{return cumulativeRefundFen(Number(order.amount_fen),Number(order.points),Number(totals.refunded_points),Number(totals.refunded),points);}
  catch{throw new Problem(503,'DATA_UNAVAILABLE','Original-payment refund consideration requires reconciliation');}
}
export async function paymentRefundEligibility(pool:Pool,owner:string,orderId:string,providers:readonly PaymentProvider[]):Promise<PaymentRefundEligibility>{
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const order=(await c.query('SELECT * FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2',[orderId,owner])).rows[0];if(!order)throw missing();
    const proof=(await c.query('SELECT * FROM bb_payment_cash_proofs WHERE order_id=$1 AND owner_user_id=$2',[orderId,owner])).rows[0];
    const lot=proof?(await c.query('SELECT * FROM bb_credit_lots WHERE id=$1 AND owner_user_id=$2',[proof.lot_id,owner])).rows[0]:null;
    const period=order.order_kind==='subscription'?(await c.query(`SELECT p.*,EXISTS(SELECT 1 FROM bb_credit_allocations a WHERE a.lot_id=p.lot_id AND a.charged_points>0) historically_used
      FROM bb_subscription_periods p WHERE p.order_id=$1 AND p.owner_user_id=$2`,[orderId,owner])).rows[0]:null;
    const totals=await refundTotals(c,owner,orderId),lots=await refundableLots(c,owner,order,proof);
    const available=Math.min(lots.reduce((n,l)=>n+Number(l.remaining)-Number(l.frozen),0),Number(order.points)-Number(totals.refunded_points));
    let reason=eligibilityReason(order,proof,lot,providers,totals.active>0,available,period);
    const refundableFen=reason?0:period?Number(order.amount_fen):cashForPoints(order,totals,available);
    if(!reason&&refundableFen<1)reason='当前可退积分折算不足人民币1分，积分继续保留；可与之后返还的同源积分合并申请。';
    const rows=(await c.query('SELECT * FROM bb_payment_refunds WHERE owner_user_id=$1 AND order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[owner,orderId])).rows;
    return {order_id:orderId,currency:'CNY',order_amount_fen:Number(order.amount_fen),original_points:Number(order.points),paid_amount_fen:proof?Number(proof.cash_amount_fen):null,
      refundable_fen:reason?0:refundableFen,held_refund_fen:Number(totals.held),refunded_fen:Number(totals.refunded),request_unit:requestUnit(order),
      refundable_points:reason?0:available,refunded_points:Number(totals.refunded_points),enabled:!reason,reason,refunds:rows.map(refundDto)};
  });
}

export async function requestPaymentRefund(pool:Pool,owner:string,orderId:string,input:PaymentRefundRequest,providers:readonly PaymentProvider[]):Promise<PaymentRefund>{
  const raw=input as any,amountRequest=raw&&Object.hasOwn(raw,'amount_fen'),pointsRequest=raw&&Object.hasOwn(raw,'points');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.request_id!=='string'||!raw.request_id||raw.request_id.length>128||
    amountRequest===pointsRequest||Object.keys(raw).some(k=>!(amountRequest?['request_id','amount_fen']:['request_id','points','expected_amount_fen']).includes(k))||
    !Number.isSafeInteger(amountRequest?raw.amount_fen:raw.points)||(amountRequest?raw.amount_fen:raw.points)<1||
    (amountRequest?raw.amount_fen>1000000:raw.points>1150000)||Object.hasOwn(raw,'expected_amount_fen')&&
      (!Number.isSafeInteger(raw.expected_amount_fen)||raw.expected_amount_fen<1||raw.expected_amount_fen>1000000))throw new Problem(422,'VALIDATION_FAILED','Invalid refund request');
  // Preserve the hash of pre-existing amount requests; points are a distinct unit.
  const hash=digest(JSON.stringify(amountRequest?[orderId,raw.amount_fen]:[orderId,'points',raw.points,...(raw.expected_amount_fen===undefined?[]:[raw.expected_amount_fen])]));
  const result=await transaction(pool,async c=>{
    // Same lock order as task allocation and settlement; never lock a lot before its account.
    await lockCreditAccount(c,owner);
    const old=(await c.query('SELECT * FROM bb_payment_refunds WHERE owner_user_id=$1 AND request_id=$2',[owner,input.request_id])).rows[0];
    if(old){if(old.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Refund key already used for another amount or original order');return {row:old,replay:true};}
    const order=(await c.query('SELECT * FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[orderId,owner])).rows[0];if(!order)throw missing();
    const proof=(await c.query('SELECT * FROM bb_payment_cash_proofs WHERE order_id=$1 AND owner_user_id=$2',[orderId,owner])).rows[0];
    const lots=await refundableLots(c,owner,order,proof,true);
    const lot=proof?(await c.query('SELECT * FROM bb_credit_lots WHERE id=$1 AND owner_user_id=$2',[proof.lot_id,owner])).rows[0]:null;
    const period=order.order_kind==='subscription'?(await c.query(`SELECT p.*,EXISTS(SELECT 1 FROM bb_credit_allocations a WHERE a.lot_id=p.lot_id AND a.charged_points>0) historically_used
      FROM bb_subscription_periods p WHERE p.order_id=$1 AND p.owner_user_id=$2`,[orderId,owner])).rows[0]:null;
    const totals=await refundTotals(c,owner,orderId),available=Math.min(lots.reduce((n,l)=>n+Number(l.remaining)-Number(l.frozen),0),Number(order.points)-Number(totals.refunded_points));
    const reason=eligibilityReason(order,proof,lot,providers,totals.active>0,available,period);
    if(reason)throw new Problem(409,'PAYMENT_INVALID',reason);
    if(requestUnit(order)!==(amountRequest?'amount_fen':'points'))throw new Problem(409,'PAYMENT_INVALID',period?'订阅周期仅支持原订单金额整期退款。':'该订单请按原权益单位申请退款，现金由系统按原实付对价计算。');
    const creditPoints=period?Number(period.points):amountRequest?raw.amount_fen:raw.points;
    if(period&&raw.amount_fen!==Number(period.amount_fen))throw new Problem(409,'PAYMENT_INVALID','订阅周期仅支持全额退款，不按剩余额度拆分退现金。');
    if(creditPoints>available)throw new Problem(409,'PAYMENT_INVALID','退款金额超过该原订单尚未消费且未预留的余额。');
    const amountFen=period?Number(period.amount_fen):cashForPoints(order,totals,creditPoints);
    if(amountFen<1)throw new Problem(409,'PAYMENT_INVALID','本次可退现金不足人民币1分，积分继续保留；请合并更多同源积分后申请。');
    if(raw.expected_amount_fen!==undefined&&raw.expected_amount_fen!==amountFen)throw new Problem(409,'QUOTE_CHANGED','原订单累计退款发生变化，请刷新可退金额后重新申请。');
    const row=(await c.query(`INSERT INTO bb_payment_refunds(id,owner_user_id,order_id,lot_id,request_id,request_hash,provider,merchant_id,provider_txn_id,currency,order_amount_fen,amount_fen,credit_points)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CNY',$10,$11,$12) RETURNING *`,[uid().replaceAll('-',''),owner,orderId,lot.id,input.request_id,hash,order.provider,order.merchant_id,order.provider_txn_id,order.amount_fen,amountFen,creditPoints])).rows[0];
    let remaining=creditPoints;
    for(const source of lots){
      const points=Math.min(remaining,Number(source.remaining)-Number(source.frozen));if(!points)continue;
      await c.query('INSERT INTO bb_payment_refund_allocations(refund_id,owner_user_id,lot_id,points) VALUES($1,$2,$3,$4)',[row.id,owner,source.id,points]);
      await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[source.id,points]);remaining-=points;if(!remaining)break;
    }
    if(remaining)throw new Problem(503,'DATA_UNAVAILABLE','Original-payment refund allocation mismatch');
    await event(c,row,'requested');return {row,replay:false};
  });
  // An old failed key never silently creates another channel refund. A new explicit key is required.
  return result.replay?refundDto(result.row):refreshPaymentRefund(pool,owner,result.row.id,providers);
}

export async function applyVerifiedRefund(pool:Pool,provider:PaymentProvider,receipt:VerifiedRefund):Promise<PaymentRefund>{
  const pointer=(await pool.query('SELECT owner_user_id,lot_id FROM bb_payment_refunds WHERE id=$1',[receipt.refundId])).rows[0];if(!pointer)throw missing();
  return transaction(pool,async c=>{
    await lockCreditAccount(c,pointer.owner_user_id);
    const allocations=(await c.query(`SELECT a.*,l.remaining,l.frozen FROM bb_payment_refund_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id AND l.owner_user_id=a.owner_user_id
      WHERE a.refund_id=$1 AND a.owner_user_id=$2 ORDER BY l.id FOR UPDATE OF l`,[receipt.refundId,pointer.owner_user_id])).rows;
    const row=(await c.query('SELECT * FROM bb_payment_refunds WHERE id=$1 FOR UPDATE',[receipt.refundId])).rows[0];
    if(!row||!allocations.length||allocations.reduce((n,a)=>n+Number(a.points),0)!==Number(row.credit_points)||row.provider!==provider.name||row.merchant_id!==provider.merchantId||receipt.merchantId!==row.merchant_id||
      receipt.orderId!==row.order_id||receipt.transactionId!==row.provider_txn_id||receipt.currency!==row.currency||
      receipt.orderAmountFen!==Number(row.order_amount_fen)||receipt.amountFen!==Number(row.amount_fen)||
      receipt.payerTotalFen!==Number(row.order_amount_fen)||receipt.payerRefundFen!==Number(row.amount_fen)||
      ![receipt.orderAmountFen,receipt.amountFen,receipt.payerTotalFen,receipt.payerRefundFen].every(Number.isSafeInteger)||
      !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.providerRefundId)||!['processing','succeeded','failed'].includes(receipt.state)||
      receipt.state==='failed'&&receipt.failureCode!=='CLOSED'||!row.dispatch_started_at)throw invalid();
    if(row.provider_refund_id&&row.provider_refund_id!==receipt.providerRefundId)throw new Problem(409,'PAYMENT_INVALID','Channel refund identity conflicts with the original refund');
    if(terminal(row.state)){
      if(terminal(receipt.state)&&row.state!==receipt.state)throw new Problem(409,'PAYMENT_INVALID','Conflicting terminal refund outcome requires reconciliation');
      return refundDto(row);
    }
    if(terminal(receipt.state)){
      for(const allocation of allocations){
        const changed=await c.query(`UPDATE bb_credit_lots SET frozen=frozen-$2,remaining=remaining-$3
          WHERE id=$1 AND frozen>=$2 AND remaining>=$2 RETURNING id`,[allocation.lot_id,allocation.points,receipt.state==='succeeded'?allocation.points:0]);
        if(!changed.rowCount)throw new Problem(503,'DATA_UNAVAILABLE','Frozen original-payment balance requires reconciliation');
      }
      if(receipt.state==='succeeded'){
        const period=(await c.query("UPDATE bb_subscription_periods SET status='refunded' WHERE order_id=$1 AND lot_id=$2 AND status='active' RETURNING subscription_id,starts_at",[row.order_id,row.lot_id])).rows[0];
        if(period)await c.query(`UPDATE bb_subscriptions SET status='cancelled',auto_renew=false,auto_renew_requested=false,
          mandate_status=CASE WHEN mandate_status IN ('pending','active') THEN 'cancel_pending' ELSE mandate_status END,
          current_period_end=NULL,current_period_start=NULL,updated_at=now() WHERE id=$1 AND current_period_start=$2`,[period.subscription_id,period.starts_at]);
      }
    }
    const updated=(await c.query(`UPDATE bb_payment_refunds SET state=$2,provider_refund_id=COALESCE(provider_refund_id,$3),updated_at=now(),
      completed_at=CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE NULL END,failure_code=$4 WHERE id=$1 RETURNING *`,
      [row.id,receipt.state,receipt.providerRefundId,receipt.state==='failed'?'CLOSED':null])).rows[0];
    await event(c,updated,receipt.state);return refundDto(updated);
  });
}

export async function refreshPaymentRefund(pool:Pool,owner:string,refundId:string,providers:readonly PaymentProvider[]):Promise<PaymentRefund>{
  const pointer=(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2',[refundId,owner])).rows[0];if(!pointer)throw missing();
  if(terminal(pointer.state))return refundDto(pointer);
  const provider=refundProvider(providers,pointer);
  const claimed=await transaction(pool,async c=>{
    await lockCreditAccount(c,owner);
    await c.query(`SELECT l.id FROM bb_payment_refund_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id
      WHERE a.refund_id=$1 AND a.owner_user_id=$2 ORDER BY l.id FOR UPDATE OF l`,[pointer.id,owner]);
    const row=(await c.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[refundId,owner])).rows[0];
    if(row.dispatch_started_at||terminal(row.state))return {row,create:false};
    // Commit BEFORE leaving the database. Recovery uses this same immutable refund ID.
    const updated=(await c.query("UPDATE bb_payment_refunds SET state='processing',dispatch_started_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
    await event(c,updated,'dispatch');return {row:updated,create:true};
  });
  if(terminal(claimed.row.state))return refundDto(claimed.row);
  let receipt:VerifiedRefund;
  try{receipt=await provider.refunds![claimed.create?'create':'query'](refundOrder(claimed.row));}
  catch{
    // A process can die after dispatch_started_at commits but before sending the request.
    // Never infer failure/absence from a transport error or an unsigned 404. A capable
    // adapter may resend the exact same authorised request under its same-key guarantee.
    const latest=(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2',[refundId,owner])).rows[0];
    if(terminal(latest.state))return refundDto(latest);
    if(!claimed.create&&provider.refunds!.recoverSameRequest){
      try{receipt=await provider.refunds!.recoverSameRequest(refundOrder(claimed.row));}
      catch{return refundDto((await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2',[refundId,owner])).rows[0]);}
    }else return refundDto((await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2',[refundId,owner])).rows[0]);
  }
  if(receipt.refundId!==claimed.row.id||receipt.orderId!==claimed.row.order_id)throw invalid();
  return applyVerifiedRefund(pool,provider,receipt);
}

export function installPaymentRefunds(app:FastifyInstance,pool:Pool,owner:(r:FastifyRequest)=>Promise<string>,providers:readonly PaymentProvider[]){
  app.get('/api/v1/commerce/topups/:order_id/refund-eligibility',{schema:{response:{200:schemas.PaymentRefundEligibilityResponse}}},async r=>
    paymentRefundEligibility(pool,await owner(r),(r.params as {order_id:string}).order_id,providers));
  app.post('/api/v1/commerce/topups/:order_id/refunds',{schema:{body:schemas.PaymentRefundRequest,response:{202:schemas.PaymentRefundResponse}}},async(r,reply)=>
    reply.code(202).send(await requestPaymentRefund(pool,await owner(r),(r.params as {order_id:string}).order_id,r.body as PaymentRefundRequest,providers)));
  app.get('/api/v1/commerce/refunds/:refund_id',{schema:{response:{200:schemas.PaymentRefundResponse}}},async r=>{
    const user=await owner(r),row=(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2',[(r.params as {refund_id:string}).refund_id,user])).rows[0];
    if(!row)throw missing();return refundDto(row);
  });
  app.post('/api/v1/commerce/refunds/:refund_id/refresh',{schema:{body:{type:'object',additionalProperties:false},response:{200:schemas.PaymentRefundResponse}}},async r=>
    refreshPaymentRefund(pool,await owner(r),(r.params as {refund_id:string}).refund_id,providers));
  app.register(async child=>{
    child.removeContentTypeParser('application/json');
    child.addContentTypeParser('application/json',{parseAs:'string',bodyLimit:65536},(_r,body,done)=>done(null,body));
    child.post('/api/v1/payments/:provider/refund-callback',{bodyLimit:65536},async r=>{
      const provider=providers.find(p=>p.name===(r.params as {provider:string}).provider&&p.refunds);if(!provider?.refunds)throw unavailable();
      let receipt:VerifiedRefund;
      try{receipt=await provider.refunds.verifyCallback(r.headers,r.body as string);}catch{throw new Problem(401,'PAYMENT_INVALID','Refund signature verification failed');}
      await applyVerifiedRefund(pool,provider,receipt);return provider.acknowledgement;
    });
  });
}
