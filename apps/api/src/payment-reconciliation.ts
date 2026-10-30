import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {applyVerifiedPayment,paymentOrder,closeRecharge,type PaymentProvider} from './payments.js';
import {refreshPaymentRefund,refundDatesIncomplete} from './payment-refunds.js';
import {raiseAlert} from './evidence-gate.js';
import {scanAndIsolateBilling} from './billing-safety.js';

/** Recover persisted authorised intents only. Never creates another order, mandate, refund ID or business task. */
export async function reconcilePendingPayments(pool:Pool,providers:readonly PaymentProvider[],limit=20,shouldStop:()=>boolean=()=>false){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new RangeError('Invalid reconciliation limit');
  const counts={payments_checked:0,payments_paid:0,refunds_checked:0,refunds_terminal:0,unknown:0,alert_failures:0};
  if(shouldStop())return counts;
  // The audit uses separate committed transactions, including when no merchant
  // is configured. Unknown provider responses never create isolation incidents.
  const safety=await scanAndIsolateBilling(pool);
  for(const result of safety.results.filter(row=>row.status==='isolated')){
    try{await raiseAlert(pool,{kind:'billing_safety_isolated',severity:'critical',scope:result.incidentId!,
      detail:{incident_id:result.incidentId!,scope_kind:result.scope.kind},bucketSeconds:3600});}
    catch{counts.alert_failures++;}
  }
  counts.alert_failures+=safety.errors.length;
  if(!providers.length||shouldStop())return counts;
  const unresolved=async(kind:'payment'|'refund',row:any)=>{
    // Only server-owned identifiers/counters. Never persist raw provider errors, bodies or credentials.
    try{await raiseAlert(pool,{kind:'payment_reconciliation_unresolved',severity:'warning',scope:kind+':'+row.id,
      detail:{intent_kind:kind,intent_id:row.id,provider:row.provider,attempts:Number(row.reconcile_attempts)},bucketSeconds:3600});}
    catch{counts.alert_failures++;}
  };
  const identities=JSON.stringify(providers.map(p=>({provider:p.name,merchant_id:p.merchantId,refunds:Boolean(p.refunds)})));
  // Claim fairly across API instances. Advance the schedule before I/O so a timeout cannot monopolise the queue.
  const orders=(await pool.query(`WITH due AS (
    SELECT o.id FROM bb_recharge_orders o
    WHERE o.state<>'paid' AND o.next_reconcile_at<=now() AND o.created_at<=now()-interval '30 seconds'
      AND (o.state='pending' OR o.expires_at>=now()-interval '7 days')
      AND EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS p(provider text,merchant_id text,refunds boolean)
        WHERE p.provider=o.provider AND p.merchant_id=o.merchant_id)
    ORDER BY o.next_reconcile_at,o.id FOR UPDATE SKIP LOCKED LIMIT $2
  ) UPDATE bb_recharge_orders o SET reconcile_attempts=LEAST(o.reconcile_attempts+1,100),
      next_reconcile_at=now()+LEAST(3600,60*power(2,LEAST(o.reconcile_attempts,6))) * interval '1 second'
    FROM due WHERE o.id=due.id RETURNING o.*`,[identities,limit])).rows;
  await parallel(orders,async order=>{
    counts.payments_checked++;
    const provider=providers.find(p=>p.name===order.provider&&p.merchantId===order.merchant_id)!;
    try{
      if(provider.closePayment&&(order.close_requested_at||new Date(order.expires_at).getTime()<=Date.now())){
        const applied=await closeRecharge(pool,order.owner_user_id,order.id,providers,true);
        if(applied.state==='paid')counts.payments_paid++;
        if(applied.state==='pending'){counts.unknown++;await unresolved('payment',order);}
        return;
      }
      const receipt=await provider.query(paymentOrder(order));
      if(receipt.orderId!==order.id)throw Error('Payment query identity mismatch');
      const applied=await applyVerifiedPayment(pool,provider,receipt);
      if(applied.state==='paid')counts.payments_paid++;
    }catch{counts.unknown++;await unresolved('payment',order);} // Unknown/mismatch never issues points or fabricates a failure.
  },shouldStop);
  if(shouldStop())return counts;
  const refunds=(await pool.query(`WITH due AS (
    SELECT r.id FROM bb_payment_refunds r WHERE (r.state IN ('requested','processing')
      OR r.provider='wechat' AND r.state IN ('succeeded','failed')
        AND (r.provider_created_at IS NULL OR r.state='succeeded' AND r.provider_succeeded_at IS NULL)
      OR r.provider='alipay' AND r.state='succeeded' AND r.provider_succeeded_at IS NULL)
      AND r.next_reconcile_at<=now() AND r.updated_at<=now()-interval '30 seconds'
      AND EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS p(provider text,merchant_id text,refunds boolean)
        WHERE p.provider=r.provider AND p.merchant_id=r.merchant_id AND p.refunds)
    ORDER BY r.next_reconcile_at,r.id FOR UPDATE SKIP LOCKED LIMIT $2
  ) UPDATE bb_payment_refunds r SET reconcile_attempts=LEAST(r.reconcile_attempts+1,100),
      next_reconcile_at=now()+LEAST(3600,60*power(2,LEAST(r.reconcile_attempts,6))) * interval '1 second'
    FROM due WHERE r.id=due.id RETURNING r.*`,[identities,limit])).rows;
  await parallel(refunds,async row=>{
    counts.refunds_checked++;
    try{
      // A crash after the authorised freeze committed may precede the first dispatch.
      // refresh serialises that dispatch with browser refreshes and other API instances.
      const applied=await refreshPaymentRefund(pool,row.owner_user_id,row.id,providers);
      if(applied.state==='succeeded'||applied.state==='failed'){
        counts.refunds_terminal++;
        const proof=(await pool.query('SELECT provider,state,provider_created_at,provider_succeeded_at FROM bb_payment_refunds WHERE id=$1',[row.id])).rows[0];
        if(refundDatesIncomplete(proof)){counts.unknown++;if(Number(row.reconcile_attempts)>=3)await unresolved('refund',row);}
      }
      else {counts.unknown++;if(Number(row.reconcile_attempts)>=3)await unresolved('refund',row);}
    }catch{counts.unknown++;await unresolved('refund',row);} // Refund-held points stay held until an authenticated matching terminal receipt.
  },shouldStop);
  return counts;
}
async function parallel<T>(rows:T[],work:(row:T)=>Promise<void>,shouldStop:()=>boolean){
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(cursor<rows.length&&!shouldStop()){const row=rows[cursor++];await work(row);}}));
}

export function installPaymentReconciliation(app:FastifyInstance,pool:Pool,providers:readonly PaymentProvider[]){
  let timer:ReturnType<typeof setInterval>|undefined,running:Promise<void>|undefined,stopping=false;
  const tick=()=>{
    if(running||stopping)return;
    running=reconcilePendingPayments(pool,providers,20,()=>stopping).then(result=>{
      if(result.unknown)app.log.warn({unknown:result.unknown},'Payment reconciliation has unresolved channel responses');
      if(result.alert_failures)app.log.error({count:result.alert_failures},'Payment reconciliation alerts could not persist');
    }).catch(()=>app.log.error('Payment reconciliation unavailable')).finally(()=>{running=undefined;});
  };
  // Listening servers recover dropped callbacks even when the customer's browser has closed.
  app.addHook('onListen',async()=>{tick();timer=setInterval(tick,60000);timer.unref();});
  app.addHook('onClose',async()=>{stopping=true;if(timer)clearInterval(timer);await running;});
}
