import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import type {PaymentProvider} from './payments.js';
import {transaction,uid} from './data.js';
import {raiseAlert} from './evidence-gate.js';
import {statementDate,type PaymentStatementRequest,type VerifiedPaymentStatement,type StatementEntry} from './payment-statements-format.js';
import {statementInteger as exact,statementAbsolute} from './payment-statement-integers.js';

type Difference={kind:string;line:number;reference:string;unit:'cny_fen'|'points'|'identity'|'coverage'|'state';expected?:string;observed?:string};
const ref=(entry:StatementEntry)=>entry.kind==='funds'?entry.flowId:entry.kind==='refund'?entry.refundId!:entry.orderId;
const chinaDate=(now:Date)=>new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
const dayBefore=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
const statementKinds=(provider:PaymentProvider)=>provider.statementKinds??(provider.name==='wechat'?['trade','funds'] as const:['trade'] as const);

/** Compare original amounts and separately audit cash/points. No payment/refund/credit writer is called here. */
async function differences(c:PoolClient,provider:PaymentProvider,statement:VerifiedPaymentStatement,asOfDay:string):Promise<Difference[]>{
  // A verified Alipay download is not yet a verified transaction/settlement format.
  // Never apply WeChat coupon arithmetic or application-date semantics to it.
  if(statement.provider==='alipay')return [{kind:'alipay_statement_format_unverified',line:0,reference:statement.billDate,unit:'coverage'}];
  const issues:Difference[]=[],entries=statement.entries;
  const add=(kind:string,entry:StatementEntry|undefined,unit:Difference['unit'],expected?:unknown,observed?:unknown,reference?:string)=>{
    issues.push({kind,line:entry?.line??0,reference:reference??(entry?ref(entry):statement.billDate),unit,
      ...(expected===undefined?{}:{expected:exact(expected).toString()}),...(observed===undefined?{}:{observed:exact(observed).toString()})});
  };
  const compare=(kind:string,entry:StatementEntry,unit:'cny_fen'|'points',expected:unknown,observed:unknown)=>{if(exact(expected)!==exact(observed))add(kind,entry,unit,expected,observed);};
  const orderIds=entries.filter(e=>e.kind!=='funds').map(e=>(e as Exclude<StatementEntry,{kind:'funds'}>).orderId);
  const businessIds=entries.flatMap(e=>e.kind==='funds'?[e.businessId,e.voucherId]:[e.transactionId]);
  const refundIds=entries.flatMap(e=>e.kind==='refund'?[e.refundId!]:e.kind==='funds'?[e.businessId,e.voucherId]:[]);
  const orders=(await c.query(`SELECT o.*,p.cash_amount_fen,l.id AS lot_id,l.original_points
    FROM bb_recharge_orders o LEFT JOIN bb_payment_cash_proofs p ON p.order_id=o.id
    LEFT JOIN bb_credit_lots l ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
    WHERE o.provider=$1 AND o.merchant_id=$2 AND (o.id=ANY($3::text[]) OR o.provider_txn_id=ANY($4::text[])
      OR (o.provider_paid_at>=($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.provider_paid_at<($5::date::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '1 day'))`,
    [provider.name,provider.merchantId,orderIds,businessIds,statement.billDate])).rows;
  const refunds=(await c.query(`SELECT r.*,COALESCE(e.cash_refunded_fen,0) AS ledger_cash_refunded_fen,COALESCE(ce.points,0) AS ledger_refund_points,ce.mismatches AS ledger_allocation_mismatches
    FROM bb_payment_refunds r LEFT JOIN bb_payment_refund_events e ON e.refund_id=r.id AND e.kind='succeeded'
    LEFT JOIN LATERAL (SELECT COALESCE(sum(ev.points),0) AS points,count(*) FILTER(WHERE ev.points IS DISTINCT FROM a.points) AS mismatches
      FROM bb_payment_refund_allocations a LEFT JOIN bb_credit_events ev ON ev.owner_user_id=a.owner_user_id AND ev.lot_id=a.lot_id
        AND ev.kind='refund_settle' AND ev.event_key='refund-credit:'||r.id||':succeeded'||CASE WHEN a.lot_id=r.lot_id THEN '' ELSE ':'||a.lot_id END
      WHERE a.refund_id=r.id AND a.owner_user_id=r.owner_user_id) ce ON true
    WHERE r.provider=$1 AND r.merchant_id=$2 AND (r.id=ANY($3::text[]) OR r.provider_refund_id=ANY($3::text[]))`,[provider.name,provider.merchantId,refundIds])).rows;
  const orderMap=new Map(orders.map(o=>[o.id,o])),refundMap=new Map(refunds.map(r=>[r.id,r]));
  const feeEvidence=(await c.query(`SELECT e.kind,e.payload FROM bb_payment_statement_entries e JOIN bb_payment_statements s ON s.id=e.statement_id
    JOIN bb_payment_statement_jobs j ON j.id=s.job_id WHERE j.provider=$1 AND j.merchant_id=$2 AND j.kind='trade'
    AND e.payload->>'merchantId'=$2 AND e.payload->>'appId'=$4 AND e.payload->>'tradeType'='NATIVE'
    AND ((e.kind='payment' AND e.payload->>'transactionId'=ANY($3::text[])) OR (e.kind='refund' AND e.payload->>'providerRefundId'=ANY($3::text[])))
    ORDER BY s.verified_at DESC`,[provider.name,provider.merchantId,businessIds,statement.appId])).rows;
  const feeMap=new Map<string,any>();for(const evidence of feeEvidence){const key=evidence.kind+':'+(evidence.kind==='payment'?evidence.payload.transactionId:evidence.payload.providerRefundId);if(!feeMap.has(key))feeMap.set(key,evidence.payload);}
  const foundPayments=new Set<string>(),foundRefunds=new Set<string>();
  for(const entry of entries){
    if(entry.kind==='payment'){
      if(entry.merchantId!==statement.merchantId){add('other_merchant',entry,'coverage');continue;}
      if(entry.appId!==statement.appId||entry.tradeType!=='NATIVE'){add('other_application_or_trade',entry,'coverage');continue;}
      const order=orderMap.get(entry.orderId);if(!order){add('channel_payment_without_order',entry,'coverage');continue;}
      if(order.provider_txn_id!==entry.transactionId)add('payment_identity',entry,'identity');
      if(order.state!=='paid')add('payment_not_credited',entry,'state');
      compare('payment_nominal',entry,'cny_fen',order.amount_fen,entry.nominalFen);
      if(exact(entry.couponFen)>exact(entry.nominalFen))add('payment_coupon_exceeds_total',entry,'cny_fen',entry.nominalFen,entry.couponFen);
      else if(order.cash_amount_fen===null||order.cash_amount_fen===undefined)add('payment_cash_proof_missing',entry,'coverage');
      else compare('payment_payer_cash',entry,'cny_fen',order.cash_amount_fen,exact(entry.nominalFen)-exact(entry.couponFen));
      if(!order.lot_id)add('payment_lot_missing',entry,'coverage');
      else compare('original_credit_issuance',entry,'points',order.points,order.original_points);
      // Use authenticated channel success_time, never local callback/credited_at time.
      const timeMatches=!!order.provider_paid_at&&new Date(order.provider_paid_at).toISOString()===entry.eventAt&&chinaDate(new Date(entry.eventAt))===statement.billDate;
      if(!order.provider_paid_at)add('payment_channel_time_uncovered',entry,'coverage');
      else if(!timeMatches)add('payment_channel_time',entry,'identity');
      if(timeMatches&&order.provider_txn_id===entry.transactionId&&exact(order.amount_fen)===exact(entry.nominalFen))foundPayments.add(entry.orderId);
    }else if(entry.kind==='refund'){
      if(entry.merchantId!==statement.merchantId){add('other_merchant',entry,'coverage');continue;}
      if(entry.appId!==statement.appId||entry.tradeType!=='NATIVE'){add('other_application_or_trade',entry,'coverage');continue;}
      const refund=refundMap.get(entry.refundId!);if(!refund){add('channel_refund_without_intent',entry,'coverage');continue;}
      // Trade bills describe accepted refund applications. Success/callback/local
      // completion times cannot locate this row, including a refund settled later.
      const applicationMatches=chinaDate(new Date(entry.eventAt))===statement.billDate&&
        (!refund.provider_created_at||new Date(refund.provider_created_at).toISOString()===entry.eventAt);
      if(!applicationMatches)add('refund_application_time',entry,'identity');
      if(refund.order_id!==entry.orderId||refund.provider_txn_id!==entry.transactionId||refund.provider_refund_id!==entry.providerRefundId)add('refund_identity',entry,'identity');
      else if(applicationMatches&&exact(refund.amount_fen)===exact(entry.refundRequestedFen))foundRefunds.add(refund.id);
      compare('refund_requested_cash',entry,'cny_fen',refund.amount_fen,entry.refundRequestedFen);
      // This file snapshots successful refund APPLICATIONS. PROCESSING/FAIL/CHANGE
      // is not the current API refund state; never reverse a later successful refund.
      const settled=refund.state==='succeeded';
      compare('refund_cash_ledger',entry,'cny_fen',settled?refund.amount_fen:0,refund.ledger_cash_refunded_fen);
      compare('refund_points_ledger',entry,'points',settled?refund.credit_points:0,refund.ledger_refund_points);
      if(settled&&Number(refund.ledger_allocation_mismatches)>0)add('refund_points_allocation',entry,'coverage');
      if(exact(entry.refundCouponFen)>exact(entry.refundSettlementFen))add('refund_coupon_exceeds_settlement',entry,'cny_fen',entry.refundSettlementFen,entry.refundCouponFen);
    }else if(entry.kind==='funds'){
      const order=orders.find(o=>o.provider_txn_id===entry.businessId),refund=refunds.find(r=>r.provider_refund_id===entry.businessId);
      if(entry.businessType==='交易'){
        if(!order){add('fund_payment_unmapped',entry,'coverage');continue;}
        if(entry.direction!=='income')add('fund_payment_direction',entry,'identity');
        if(order.cash_amount_fen===null||order.cash_amount_fen===undefined){add('fund_payment_cash_proof_missing',entry,'coverage');continue;}
        if(exact(order.cash_amount_fen)!==exact(order.amount_fen)){add('fund_discount_requires_settlement_evidence',entry,'coverage');continue;}
        compare('fund_payment_cash',entry,'cny_fen',order.amount_fen,entry.amountFen);
      }else if(entry.businessType==='退款'||entry.businessType==='退款关闭'){
        if(!refund){add('fund_refund_unmapped',entry,'coverage');continue;}
        if(entry.direction!==(entry.businessType==='退款'?'expense':'income'))add('fund_refund_direction',entry,'identity');
        compare('fund_refund_cash',entry,'cny_fen',refund.amount_fen,entry.amountFen);
        // A funds movement is not proof that the end customer received a refund.
      }else if(['扣除交易手续费','退还交易手续费'].includes(entry.businessType)){
        const source=feeMap.get((entry.businessType==='扣除交易手续费'?'payment':'refund')+':'+entry.businessId);
        if(!source){add('fund_fee_trade_evidence_missing',entry,'coverage');continue;}
        if(entry.direction!==(entry.businessType==='扣除交易手续费'?'expense':'income'))add('fund_fee_direction',entry,'identity');
        compare('fund_channel_fee',entry,'cny_fen',statementAbsolute(source.feeFen),entry.amountFen);
      }else add('fund_other_operation',entry,'coverage');
    }
  }
  if(statement.kind==='trade'){
    for(const order of orders){
      if(order.provider_paid_at&&chinaDate(new Date(order.provider_paid_at))===statement.billDate&&!foundPayments.has(order.id))
        add('local_payment_missing_from_statement',undefined,'coverage',undefined,undefined,order.id);
    }
    // Both authenticated API create_time and exact historical bill rows establish
    // application dates. Accepted processing/closed refunds also belong in bills.
    // Legacy unknown dates stay uncovered; never backfill from local timestamps.
    const refundCoverage=(await c.query(`SELECT r.id,count(b.statement_id)>0 AS has_statement_evidence,
      (r.provider_created_at AT TIME ZONE 'Asia/Shanghai')::date<$5::date-90 AS outside_statement_window,
      (r.provider_created_at IS NOT NULL OR count(b.statement_id)>0) AS has_application_evidence,
      CASE WHEN r.provider_created_at IS NOT NULL THEN (r.provider_created_at AT TIME ZONE 'Asia/Shanghai')::date=$3::date
        ELSE COALESCE(bool_or(b.bill_date=$3::date),false) END AS application_on_bill_date,
      COALESCE(bool_or(r.provider_created_at IS NOT NULL AND b.payload->>'eventAt'<>to_char(r.provider_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),false) AS historical_time_conflict
      FROM bb_payment_refunds r LEFT JOIN (
        SELECT e.statement_id,e.reference_id,e.payload,j.bill_date FROM bb_payment_statement_entries e
        JOIN bb_payment_statements s ON s.id=e.statement_id JOIN bb_payment_statement_jobs j ON j.id=s.job_id
        WHERE j.provider=$1 AND j.merchant_id=$2 AND j.kind='trade' AND e.kind='refund'
      ) b ON b.reference_id=r.id AND b.payload->>'refundId'=r.id AND b.payload->>'orderId'=r.order_id
        AND b.payload->>'transactionId'=r.provider_txn_id AND b.payload->>'providerRefundId'=r.provider_refund_id
        AND b.payload->>'refundRequestedFen'=r.amount_fen::text AND b.payload->>'appId'=$4
        AND b.payload->>'tradeType'='NATIVE' AND b.payload->>'merchantId'=$2
      WHERE r.provider=$1 AND r.merchant_id=$2
        AND (r.provider_created_at IS NOT NULL OR r.provider_refund_id IS NOT NULL OR r.state='succeeded') GROUP BY r.id`,
      [provider.name,provider.merchantId,statement.billDate,statement.appId,asOfDay])).rows;
    for(const refund of refundCoverage){
      if(refund.historical_time_conflict)add('refund_application_evidence_conflict',undefined,'identity',undefined,undefined,refund.id);
      if(!refund.has_application_evidence)add('refund_application_date_uncovered',undefined,'coverage',undefined,undefined,refund.id);
      else if(refund.application_on_bill_date&&!foundRefunds.has(refund.id))
        add('local_refund_missing_from_statement',undefined,'coverage',undefined,undefined,refund.id);
      else if(refund.outside_statement_window&&!refund.has_statement_evidence)
        add('refund_application_statement_window_uncovered',undefined,'coverage',undefined,undefined,refund.id);
    }
  }
  return issues;
}

export async function enqueuePaymentStatement(pool:Pool,provider:PaymentProvider,request:PaymentStatementRequest){
  if(!provider.downloadStatements)throw new Error('Statement provider unavailable');statementDate(request.billDate);
  const account=request.kind==='funds'?(request.accountType??'BASIC'):'';
  if(!(statementKinds(provider) as readonly string[]).includes(request.kind)||request.kind==='trade'&&request.accountType!==undefined||request.kind==='funds'&&!(provider.statementAccounts??['BASIC']).includes(account as any))throw new Error('Invalid statement account');
  const result=await pool.query(`INSERT INTO bb_payment_statement_jobs(id,provider,merchant_id,bill_date,kind,account_type) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(provider,merchant_id,bill_date,kind,account_type) DO NOTHING RETURNING id`,[uid(),provider.name,provider.merchantId,request.billDate,request.kind,account]);
  return result.rows[0]?.id as string|undefined;
}

async function persistStatement(pool:Pool,job:any,provider:PaymentProvider,statement:VerifiedPaymentStatement,asOfDay:string){
  const date=typeof job.bill_date==='string'?job.bill_date:new Date(job.bill_date).toISOString().slice(0,10);
  if(statement.provider!==provider.name||statement.merchantId!==provider.merchantId||statement.billDate!==date||statement.kind!==job.kind||(statement.accountType??'')!==job.account_type
    ||provider.statementAppId!==undefined&&(statement.provider==='wechat'?statement.appId:statement.requestAppId)!==provider.statementAppId
    ||!['available','absent'].includes(statement.availability)||statement.entries.length>20000)throw new Error('Statement identity mismatch');
  let method='wechat_sha1',signedResponseSha256:string|null=null,context:Record<string,unknown>={};
  const unresolved=statement.provider==='alipay';
  if(statement.provider==='alipay'){
    const proof=statement.evidence;
    if(statement.availability!=='available'||statement.sha1!==null||! /^[a-f0-9]{64}$/.test(statement.sha256)
      ||!Number.isSafeInteger(statement.byteLength)||statement.byteLength<1||statement.byteLength>10485760
      ||proof.kind!=='alipay_rsa2_download_url'||! /^[a-f0-9]{64}$/.test(proof.signedResponseSha256)||proof.downloadSha256!==statement.sha256
      ||proof.signedUrlMerchantId!==provider.merchantId||proof.requestedBillDate!==date||proof.requestBillType!=='trade'
      ||statement.normalization.status!=='unresolved'||statement.normalization.reasons.length!==1||statement.normalization.reasons[0]!=='ALIPAY_CSV_FORMAT_UNVERIFIED'
      ||statement.entries.length!==0||statement.totals!==null)throw new Error('Invalid Alipay statement proof');
    method=proof.kind;signedResponseSha256=proof.signedResponseSha256;
    // Keep only non-secret provenance; download URLs and file contents never enter logs/JSON evidence.
    context={request_app_id:statement.requestAppId,merchant_id:proof.signedUrlMerchantId,requested_bill_date:date,request_bill_type:'trade',
      normalization:statement.normalization,documents:statement.documents};
  }
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const locked=(await c.query('SELECT * FROM bb_payment_statement_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
    if(!locked||locked.state!=='running'||locked.lease_token!==job.lease_token)return 'lease_lost' as const;
    const key=statement.availability==='absent'?'absent':statement.sha256;
    let saved=(await c.query('SELECT id FROM bb_payment_statements WHERE job_id=$1 AND evidence_key=$2',[job.id,key])).rows[0];
    if(!saved){
      saved=(await c.query(`INSERT INTO bb_payment_statements(id,job_id,evidence_key,availability,sha1,sha256,byte_length,verified_at,totals,verification_method,signed_response_sha256,verification_context)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[uid(),job.id,key,statement.availability,statement.sha1,statement.sha256,statement.byteLength,statement.verifiedAt,JSON.stringify(statement.totals),method,signedResponseSha256,context])).rows[0];
      if(statement.entries.length)await c.query(`INSERT INTO bb_payment_statement_entries(statement_id,line_no,kind,reference_id,payload)
        SELECT $1,line_no,kind,reference_id,payload FROM jsonb_to_recordset($2::jsonb) r(line_no integer,kind text,reference_id text,payload jsonb)`,
        [saved.id,JSON.stringify(statement.entries.map(entry=>({line_no:entry.line,kind:entry.kind,reference_id:ref(entry),payload:entry})))]);
    }
    const issues=await differences(c,provider,statement,asOfDay),checkId=uid();
    await c.query('INSERT INTO bb_payment_statement_checks(id,job_id,statement_id,difference_count) VALUES($1,$2,$3,$4)',[checkId,job.id,saved.id,issues.length]);
    if(issues.length)await c.query(`INSERT INTO bb_payment_statement_differences(id,check_id,kind,line_no,reference_id,unit,expected_value,observed_value)
      SELECT id,$1,kind,line_no,reference_id,unit,expected_value,observed_value FROM jsonb_to_recordset($2::jsonb)
        r(id text,kind text,line_no integer,reference_id text,unit text,expected_value bigint,observed_value bigint)`,
      [checkId,JSON.stringify(issues.map(issue=>({id:uid(),kind:issue.kind,line_no:issue.line,reference_id:issue.reference,unit:issue.unit,expected_value:issue.expected??null,observed_value:issue.observed??null})))]);
    if(issues.length)await raiseAlert(c,{kind:'payment_statement_difference',severity:'warning',scope:job.id,detail:{statement_job_id:job.id,check_id:checkId,difference_count:issues.length},bucketSeconds:86400});
    await c.query(`UPDATE bb_payment_statement_jobs SET state=$3,lease_token=NULL,lease_until=NULL,last_check_id=$2,
      next_attempt_at=now()+CASE WHEN $3='unknown' THEN LEAST(21600,300*power(2,LEAST(attempts,6)))*interval '1 second' ELSE interval '1 day' END,
      updated_at=now() WHERE id=$1`,[job.id,checkId,unresolved?'unknown':'complete']);
    return unresolved?'unknown' as const:'complete' as const;
  });
}

/** Bounded, resumable daily reconciliation. Explicitly enabled adapters only; never uses a customer request to supply a download URL. */
export async function reconcileDailyStatements(pool:Pool,providers:readonly PaymentProvider[],options:{now?:Date;limit?:number;shouldStop?:()=>boolean}={}){
  const now=options.now??new Date(),limit=options.limit??2,stop=options.shouldStop??(()=>false),active=providers.filter(p=>p.downloadStatements);
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw new Error('Invalid statement batch limit');
  const counts={checked:0,completed:0,unknown:0};if(!active.length||stop())return counts;
  const today=chinaDate(now),chinaHour=new Date(now.getTime()+8*3600000).getUTCHours();
  if(chinaHour>=10)for(const provider of active)for(let days=1;days<=7;days++){
    if(stop())return counts;const billDate=dayBefore(today,days);
    if((statementKinds(provider) as readonly string[]).includes('trade'))await enqueuePaymentStatement(pool,provider,{billDate,kind:'trade'});
    if((statementKinds(provider) as readonly string[]).includes('funds'))for(const accountType of provider.statementAccounts??['BASIC'])await enqueuePaymentStatement(pool,provider,{billDate,kind:'funds',accountType});
  }
  const identities=JSON.stringify(active.map(p=>({provider:p.name,merchant_id:p.merchantId,kinds:statementKinds(p),accounts:p.statementAccounts??['BASIC']}))),lease=uid();
  const jobs=(await pool.query(`WITH due AS (SELECT j.id FROM bb_payment_statement_jobs j WHERE j.next_attempt_at<=now()
    AND (j.state<>'running' OR j.lease_until<=now()) AND j.bill_date<$2::date AND j.bill_date>=$2::date-90
    AND (j.bill_date>=$2::date-7 OR j.state<>'complete')
    AND EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) p(provider text,merchant_id text,kinds jsonb,accounts jsonb) WHERE p.provider=j.provider AND p.merchant_id=j.merchant_id
      AND p.kinds ? j.kind AND (j.kind='trade' OR p.accounts ? j.account_type))
    ORDER BY j.next_attempt_at,j.bill_date DESC,j.kind DESC,j.id FOR UPDATE SKIP LOCKED LIMIT $3)
    UPDATE bb_payment_statement_jobs j SET state='running',lease_token=$4,lease_until=now()+interval '2 minutes',attempts=LEAST(j.attempts+1,100),updated_at=now()
    FROM due WHERE j.id=due.id RETURNING j.*,j.bill_date::text AS bill_date`,[identities,today,limit,lease])).rows;
  for(const job of jobs){
    if(stop())break;counts.checked++;
    const provider=active.find(p=>p.name===job.provider&&p.merchantId===job.merchant_id)!;
    const billDate=typeof job.bill_date==='string'?job.bill_date:new Date(job.bill_date).toISOString().slice(0,10);
    try{
      const statement=await provider.downloadStatements!({billDate,kind:job.kind,...(job.kind==='funds'?{accountType:job.account_type}:{})});
      const state=await persistStatement(pool,job,provider,statement,today);
      if(state==='complete')counts.completed++;else if(state==='unknown')counts.unknown++;
    }catch{
      counts.unknown++;
      await transaction(pool,async c=>{
        const changed=await c.query(`UPDATE bb_payment_statement_jobs SET state='unknown',lease_token=NULL,lease_until=NULL,
          next_attempt_at=now()+LEAST(21600,300*power(2,LEAST(attempts,6)))*interval '1 second',updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING id`,[job.id,job.lease_token]);
        if(changed.rowCount)await raiseAlert(c,{kind:'payment_statement_unavailable',severity:'warning',scope:job.id,detail:{statement_job_id:job.id,attempts:Number(job.attempts)},bucketSeconds:3600});
      });
    }
  }
  return counts;
}

export function installPaymentStatements(app:FastifyInstance,pool:Pool,providers:readonly PaymentProvider[]){
  if(!providers.some(p=>p.downloadStatements))return;
  let timer:ReturnType<typeof setInterval>|undefined,running:Promise<void>|undefined,stopping=false;
  const tick=()=>{if(running||stopping)return;running=reconcileDailyStatements(pool,providers,{shouldStop:()=>stopping}).then(()=>{}).catch(()=>app.log.error('Payment statement reconciliation unavailable')).finally(()=>{running=undefined;});};
  app.addHook('onListen',async()=>{tick();timer=setInterval(tick,60000);timer.unref();});
  app.addHook('onClose',async()=>{stopping=true;if(timer)clearInterval(timer);await running;});
}
