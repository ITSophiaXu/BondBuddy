import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PaymentProvider} from './payments.js';
import type {AlipayStatementEntry,VerifiedAlipayStatement} from './alipay-statements.js';
import {statementInteger as exact} from './payment-statement-integers.js';

type Difference={kind:string;line:number;reference:string;unit:'cny_fen'|'points'|'identity'|'coverage'|'state';expected?:string;observed?:string};
const reference=(entry:AlipayStatementEntry)=>entry.kind==='refund'?entry.refundId!:entry.orderId;
const chinaDay=(value:Date|string)=>new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10);
// The deployment interprets the channel's local timestamps as Asia/Shanghai,
// consistently with the existing authenticated Alipay callback adapter. This is
// not a claim that the public CSV field guide explicitly supplies a timezone.
const matchesTime=(stored:Date|string|null,local:string,billDate:string)=>!!stored&&
  new Date(stored).getTime()===Date.parse(local.replace(' ','T')+'+08:00')&&local.slice(0,10)===billDate;

/** A PID statement covers all applications. Attribute only an exact registered
 * order/refund identity, and never turn merchant receipts into buyer cash. */
export async function alipayStatementDifferences(c:PoolClient,provider:PaymentProvider,statement:VerifiedAlipayStatement):Promise<Difference[]>{
  if(statement.normalization.status!=='normalized')return [{kind:'alipay_statement_format_unverified',line:0,reference:statement.billDate,unit:'coverage'}];
  const issues:Difference[]=[],entries=statement.entries;
  const add=(kind:string,entry:AlipayStatementEntry|undefined,unit:Difference['unit'],expected?:unknown,observed?:unknown,id?:string)=>
    issues.push({kind,line:entry?.line??0,reference:id??(entry?reference(entry):statement.billDate),unit,
      ...(expected===undefined?{}:{expected:exact(expected).toString()}),...(observed===undefined?{}:{observed:exact(observed).toString()})});
  const compare=(kind:string,entry:AlipayStatementEntry,unit:'cny_fen'|'points',expected:unknown,observed:unknown)=>{
    if(exact(expected)!==exact(observed))add(kind,entry,unit,expected,observed);
  };
  const orderIds=entries.map(e=>e.orderId),transactionIds=entries.map(e=>e.transactionId),refundIds=entries.flatMap(e=>e.kind==='refund'?[e.refundId!]:[]);
  const orders=(await c.query(`SELECT o.*,p.order_id AS proof_order_id,p.cash_amount_fen,p.order_amount_fen AS proof_order_amount_fen,
      p.merchant_id AS proof_merchant_id,p.provider AS proof_provider,p.provider_txn_id AS proof_txn_id,p.lot_id AS proof_lot_id,
      l.id AS lot_id,l.original_points
    FROM bb_recharge_orders o LEFT JOIN bb_payment_cash_proofs p ON p.order_id=o.id AND p.owner_user_id=o.owner_user_id
    LEFT JOIN bb_credit_lots l ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
    WHERE o.provider='alipay' AND o.merchant_id=$1 AND (o.id=ANY($2::text[]) OR o.provider_txn_id=ANY($3::text[])
      OR o.state='paid' AND (o.provider_paid_at IS NULL OR
        o.provider_paid_at>=($4::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.provider_paid_at<($4::date::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '1 day'))`,
    [provider.merchantId,orderIds,transactionIds,statement.billDate])).rows;
  const refunds=(await c.query(`SELECT r.*,COALESCE(e.cash_refunded_fen,0) AS ledger_cash_refunded_fen,
      COALESCE(ce.points,0) AS ledger_refund_points,ce.mismatches AS ledger_allocation_mismatches
    FROM bb_payment_refunds r LEFT JOIN bb_payment_refund_events e ON e.refund_id=r.id AND e.kind='succeeded'
    LEFT JOIN LATERAL (SELECT COALESCE(sum(ev.points),0) AS points,count(*) FILTER(WHERE ev.points IS DISTINCT FROM a.points) AS mismatches
      FROM bb_payment_refund_allocations a LEFT JOIN bb_credit_events ev ON ev.owner_user_id=a.owner_user_id AND ev.lot_id=a.lot_id
        AND ev.kind='refund_settle' AND ev.event_key='refund-credit:'||r.id||':succeeded'||CASE WHEN a.lot_id=r.lot_id THEN '' ELSE ':'||a.lot_id END
      WHERE a.refund_id=r.id AND a.owner_user_id=r.owner_user_id) ce ON true
    WHERE r.provider='alipay' AND r.merchant_id=$1 AND (r.id=ANY($2::text[]) OR r.state='succeeded' AND
      (r.provider_succeeded_at IS NULL OR r.provider_succeeded_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
        AND r.provider_succeeded_at<($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '1 day'))`,
    [provider.merchantId,refundIds,statement.billDate])).rows;
  const orderMap=new Map(orders.map(o=>[o.id,o])),refundMap=new Map(refunds.map(r=>[r.id,r]));
  const foundPayments=new Set<string>(),foundRefunds=new Set<string>(),unknownPaymentTimes=new Set<string>(),unknownRefundTimes=new Set<string>();
  for(const entry of entries){
    // These values and their source signs are preserved for accounting. A blank
    // optional merchant field is unknown, never zero or customer consideration.
    if(entry.merchantReceivedFen===null||entry.merchantDiscountFen===null)
      add('alipay_merchant_amounts_uncovered',entry,'coverage');
    if(entry.feeFen===null)add('alipay_fee_uncovered',entry,'coverage');
    if(entry.kind==='payment'){
      const order=orderMap.get(entry.orderId);
      if(!order){add('alipay_payment_without_registered_order',entry,'coverage');continue;}
      const identity=order.provider_txn_id===entry.transactionId;
      if(!identity)add('alipay_payment_identity',entry,'identity');
      if(order.state!=='paid')add('alipay_payment_not_credited',entry,'state');
      compare('alipay_payment_nominal',entry,'cny_fen',order.amount_fen,entry.amountFen);
      if(!order.proof_order_id)add('alipay_payment_cash_proof_missing',entry,'coverage');
      else{
        if(order.proof_provider!=='alipay'||order.proof_merchant_id!==provider.merchantId||order.proof_txn_id!==order.provider_txn_id||order.proof_lot_id!==order.lot_id)
          add('alipay_payment_cash_proof_identity',entry,'identity');
        compare('alipay_payment_cash_proof_nominal',entry,'cny_fen',order.amount_fen,order.proof_order_amount_fen);
        if(exact(order.cash_amount_fen)<0n||exact(order.cash_amount_fen)>exact(order.amount_fen))add('alipay_payment_cash_proof_range',entry,'cny_fen',order.amount_fen,order.cash_amount_fen);
      }
      if(!order.lot_id)add('alipay_payment_lot_missing',entry,'coverage');
      else compare('alipay_original_credit_issuance',entry,'points',order.points,order.original_points);
      const timeMatches=matchesTime(order.provider_paid_at,entry.completedLocalTime,statement.billDate);
      if(!order.provider_paid_at){add('alipay_payment_time_uncovered',entry,'coverage');unknownPaymentTimes.add(order.id);}
      else if(!timeMatches)add('alipay_payment_channel_time',entry,'identity');
      if(identity&&timeMatches&&order.state==='paid'&&exact(order.amount_fen)===exact(entry.amountFen))foundPayments.add(order.id);
    }else{
      const refund=refundMap.get(entry.refundId!);
      if(!refund){add('alipay_refund_without_registered_intent',entry,'coverage');continue;}
      const expectedProviderId='alipay_'+createHash('sha256').update(JSON.stringify([entry.transactionId,entry.refundId])).digest('hex');
      const identity=refund.order_id===entry.orderId&&refund.provider_txn_id===entry.transactionId&&refund.provider_refund_id===expectedProviderId;
      if(!identity)add('alipay_refund_identity',entry,'identity');
      compare('alipay_refund_nominal',entry,'cny_fen',refund.amount_fen,entry.amountFen);
      const original=orderMap.get(refund.order_id);
      if(!original?.proof_order_id)add('alipay_refund_original_cash_proof_missing',entry,'coverage');
      else{
        if(original.proof_provider!=='alipay'||original.proof_merchant_id!==provider.merchantId||original.proof_txn_id!==refund.provider_txn_id||original.proof_lot_id!==refund.lot_id)
          add('alipay_refund_original_cash_identity',entry,'identity');
        compare('alipay_refund_original_cash',entry,'cny_fen',refund.order_amount_fen,original.cash_amount_fen);
        compare('alipay_refund_original_nominal',entry,'cny_fen',refund.order_amount_fen,original.proof_order_amount_fen);
      }
      const settled=refund.state==='succeeded';
      if(!settled)add('alipay_refund_not_settled',entry,'state');
      compare('alipay_refund_cash_ledger',entry,'cny_fen',settled?refund.amount_fen:0,refund.ledger_cash_refunded_fen);
      compare('alipay_refund_points_ledger',entry,'points',settled?refund.credit_points:0,refund.ledger_refund_points);
      if(settled&&Number(refund.ledger_allocation_mismatches)>0)add('alipay_refund_points_allocation',entry,'coverage');
      const timeMatches=matchesTime(refund.provider_succeeded_at,entry.completedLocalTime,statement.billDate);
      if(!refund.provider_succeeded_at){add('alipay_refund_time_uncovered',entry,'coverage');unknownRefundTimes.add(refund.id);}
      else if(!timeMatches)add('alipay_refund_channel_time',entry,'identity');
      if(identity&&settled&&timeMatches&&exact(refund.amount_fen)===exact(entry.amountFen))foundRefunds.add(refund.id);
    }
  }
  // Reverse coverage uses authenticated completion times, independently of the
  // rows which happened to be downloaded. Local ingestion time proves no date.
  for(const order of orders){
    if(order.state!=='paid')continue;
    if(!order.provider_paid_at){if(!unknownPaymentTimes.has(order.id))add('alipay_payment_time_uncovered',undefined,'coverage',undefined,undefined,order.id);}
    else if(chinaDay(order.provider_paid_at)===statement.billDate&&!foundPayments.has(order.id))add('alipay_local_payment_missing_from_statement',undefined,'coverage',undefined,undefined,order.id);
  }
  for(const refund of refunds){
    if(refund.state!=='succeeded')continue;
    if(!refund.provider_succeeded_at){if(!unknownRefundTimes.has(refund.id))add('alipay_refund_time_uncovered',undefined,'coverage',undefined,undefined,refund.id);}
    else if(chinaDay(refund.provider_succeeded_at)===statement.billDate&&!foundRefunds.has(refund.id))add('alipay_local_refund_missing_from_statement',undefined,'coverage',undefined,undefined,refund.id);
  }
  return issues;
}
