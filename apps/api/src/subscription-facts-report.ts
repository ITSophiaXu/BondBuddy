import {pathToFileURL} from 'node:url';
import type {Pool} from 'pg';
import {int64,serializeInt64} from '@bondbuddy/contracts';
import {transaction,Problem} from './data.js';
import {ZERO,ratio,add,subtract,ratioJson,type ExactRatio} from './commerce-economics-math.js';
import {lotFundingEvidenceSql,lotFundingMatches,type LotFundingEvidence} from './subscription-funding-evidence.js';

export const SUBSCRIPTION_FACTS_VERSION='subscription-facts-exact-v2';
type Order={order_id:string;owner_user_id:string;order_kind:string;occurred_at:string;amount_fen:string;cash_amount_fen:string|null;refunded_fen:string;period_start:string|null;period_end:string|null};
type Slice={event_id:string;occurred_at:string;lot_id:string;origin_lot_id:string|null;order_id:string|null;source:string;points:string;basis_fen:string|null;basis_points:string|null;event_total_points?:string;reservation_id?:string;funding_required?:boolean;funding_slices?:LotFundingEvidence[]};
type Refund={refund_id?:string;occurred_at:string|null;amount_fen:string};
type Expiry={expires_at:string;remaining:string;frozen:string};
export type SubscriptionFactsInput={from:string;to:string;as_of:string;orders:Order[];redemptions:Slice[];corrections:Slice[];cash_refunds:Refund[];expired_lots:Expiry[];excluded_legacy_settlement_points:string};
const monthPattern=/^\d{4}-(?:0[1-9]|1[0-2])$/;
const month=(date:string)=>new Date(Date.parse(date)+8*3600000).toISOString().slice(0,7);
const monthIndex=(value:string)=>Number(value.slice(0,4))*12+Number(value.slice(5))-1;
const monthName=(index:number)=>`${Math.floor(index/12).toString().padStart(4,'0')}-${String(index%12+1).padStart(2,'0')}`;
const nextMonth=(value:string)=>`${monthName(monthIndex(value)+1)}-01T00:00:00+08:00`;
function checkRange(from:string,to:string){if(!monthPattern.test(from)||!monthPattern.test(to)||from>to||monthIndex(to)-monthIndex(from)>35)throw new Problem(422,'VALIDATION_FAILED','Use YYYY-MM from/to, at most 36 months.');}
const sumPoints=(values:string[])=>serializeInt64(values.reduce((n,value)=>n+int64(value),0n));
const unique=(values:string[])=>String(new Set(values).size);
function consideration(slices:Slice[]){
 let known=ZERO;const missing:string[]=[];
 for(const s of slices){
  if(s.basis_fen===null||s.basis_points===null||int64(s.basis_points)===0n||!lotFundingMatches({required:s.funding_required,funding:s.funding_slices,numerator:s.basis_fen,denominator:s.basis_points})){missing.push(s.lot_id);continue;}
  known=add(known,ratio(int64(s.basis_fen)*int64(s.points),int64(s.basis_points)));
 }
 return{complete:missing.length===0,known,total:missing.length?null:known,missing_lots:[...new Set(missing)].sort()};
}
function inconsistentRedemptionEvents(slices:Slice[]){
 const groups=new Map<string,Slice[]>(),reservations=new Map<string,Set<string>>(),bad=new Set<string>();
 for(const s of slices){groups.set(s.event_id,[...(groups.get(s.event_id)??[]),s]);if(s.reservation_id){const events=reservations.get(s.reservation_id)??new Set<string>();events.add(s.event_id);reservations.set(s.reservation_id,events);}}
 for(const [id,rows]of groups){const total=rows[0].event_total_points;if(total!==undefined&&(rows.some(s=>s.event_total_points!==total)||rows.reduce((n,s)=>n+int64(s.points),0n)!==int64(total)))bad.add(id);}
 for(const events of reservations.values())if(events.size>1)for(const id of events)bad.add(id);
 return bad;
}

/** Exact observed facts. No estimated users, retention, breakage income or future cash. */
export function summarizeSubscriptionFacts(input:SubscriptionFactsInput){
 checkRange(input.from,input.to);const at=Date.parse(input.as_of);if(!Number.isFinite(at))throw new RangeError('Invalid report snapshot');
 const datedRefunds=input.cash_refunds.filter((s):s is Refund&{occurred_at:string}=>s.occurred_at!==null&&Number.isFinite(Date.parse(s.occurred_at)));
 const undatedRefunds=input.cash_refunds.filter(s=>s.occurred_at===null||!Number.isFinite(Date.parse(s.occurred_at)));
 const redemptions=input.redemptions.filter(s=>Date.parse(s.occurred_at)<=at),corrections=input.corrections.filter(s=>Date.parse(s.occurred_at)<=at),cashRefunds=datedRefunds.filter(s=>Date.parse(s.occurred_at)<=at);
 const inconsistent=inconsistentRedemptionEvents(redemptions);
 const orders=input.orders.filter(o=>Date.parse(o.occurred_at)<=at),inMonth=(m:string)=>(item:{occurred_at:string})=>month(item.occurred_at)===m;
 // Full cash refunds remove a period from the retained-purchase cohort. A reopened
 // purchase is not a renewal merely because its immutable cycle_index is greater.
 const retained=orders.filter(o=>o.order_kind==='subscription'&&o.period_start&&o.period_end&&o.cash_amount_fen!==null&&int64(o.cash_amount_fen)>int64(o.refunded_fen))
  .sort((a,b)=>Date.parse(a.period_start!)-Date.parse(b.period_start!)||a.order_id.localeCompare(b.order_id));
 const first=new Map<string,Order>(),renewals=new Set<string>(),overlap=new Set<string>();
 for(const o of retained){
  if(!first.has(o.owner_user_id)){first.set(o.owner_user_id,o);continue;}
  const prior=retained.filter(p=>p.owner_user_id===o.owner_user_id&&p.order_id!==o.order_id&&Date.parse(p.period_start!)<Date.parse(o.period_start!));
  const previous=prior.at(-1);if(previous&&Date.parse(previous.period_end!)<=Date.parse(o.period_start!))renewals.add(o.order_id);else overlap.add(o.order_id);
 }
 const months=[];
 for(let index=monthIndex(input.from);index<=monthIndex(input.to);index++){
  const m=monthName(index),paid=orders.filter(inMonth(m)),redemption=redemptions.filter(inMonth(m)),correction=corrections.filter(inMonth(m));
  const unverified=[...new Set(redemption.filter(s=>inconsistent.has(s.event_id)).map(s=>s.event_id))],mapped=redemption.filter(s=>!inconsistent.has(s.event_id));
  const earned=consideration(mapped),reversed=consideration(correction),cashMissing=paid.filter(o=>o.cash_amount_fen===null);
  if(unverified.length){earned.complete=false;earned.total=null;}
  const cashKnown=paid.reduce((n,o)=>n+(o.cash_amount_fen===null?0n:int64(o.cash_amount_fen)),0n),refund=int64(sumPoints(cashRefunds.filter(inMonth(m)).map(r=>r.amount_fen)));
  const expiry=input.expired_lots.filter(l=>Date.parse(l.expires_at)<=at&&month(l.expires_at)===m);
  months.push({month:m,observation_complete:Date.parse(nextMonth(m))<=at,
   paid_orders:String(paid.length),paid_subscription_orders:String(paid.filter(o=>o.order_kind==='subscription').length),paid_topup_orders:String(paid.filter(o=>o.order_kind==='recharge').length),
   verified_cash_paid_unique:unique(paid.filter(o=>o.cash_amount_fen!==null&&int64(o.cash_amount_fen)>0n).map(o=>o.owner_user_id)),
   new_retained_subscription_customers:unique([...first.values()].filter(o=>month(o.period_start!)===m).map(o=>o.owner_user_id)),
   retained_renewal_orders:String(retained.filter(o=>renewals.has(o.order_id)&&month(o.period_start!)===m).length),
   retained_same_or_overlapping_period_orders:String(retained.filter(o=>overlap.has(o.order_id)&&month(o.period_start!)===m).length),
   accepted_order_amount_fen:sumPoints(paid.map(o=>o.amount_fen)),verified_payer_cash_fen_known:cashKnown.toString(),cash_proof_missing_orders:String(cashMissing.length),
   verified_payer_cash_fen:cashMissing.length?null:cashKnown.toString(),cash_refunded_fen_known:refund.toString(),cash_refunded_fen:undatedRefunds.length?null:refund.toString(),
   net_payer_cash_flow_fen:cashMissing.length||undatedRefunds.length?null:(cashKnown-refund).toString(),
   redeemed_points:unverified.length?null:sumPoints(redemption.map(s=>s.points)),known_mapped_redeemed_points:sumPoints(mapped.map(s=>s.points)),unverified_redemption_event_ids:unverified,
   quality_returned_points:sumPoints(correction.map(s=>s.points)),
   original_order_consideration_earned_fen:ratioJson(earned.total),quality_return_consideration_fen:ratioJson(reversed.total),
   net_earned_order_consideration_fen:ratioJson(earned.total!==null&&reversed.total!==null?subtract(earned.total,reversed.total):null),
   known_earned_order_consideration_fen:ratioJson(earned.known),consideration_complete:earned.complete&&reversed.complete,
   missing_cash_basis_lots:[...new Set([...earned.missing_lots,...reversed.missing_lots])].sort(),
   expired_unfrozen_points_at_snapshot:serializeInt64(expiry.reduce((n,l)=>n+int64(l.remaining)-int64(l.frozen),0n)),
   expired_frozen_points_at_snapshot:sumPoints(expiry.map(l=>l.frozen)),
  });
 }
 const cohorts=[];
 for(const m of [...new Set([...first.values()].map(o=>month(o.period_start!)))].sort().filter(m=>m>=input.from&&m<=input.to)){
  const owners=[...first.values()].filter(o=>month(o.period_start!)===m).map(o=>o.owner_user_id),members=new Set(owners);
  for(let offset=1;offset<=12;offset++){
   const target=monthName(monthIndex(m)+offset),matured=Date.parse(nextMonth(target))<=at;
   const repeat=new Set(retained.filter(o=>members.has(o.owner_user_id)&&renewals.has(o.order_id)&&month(o.period_start!)===target).map(o=>o.owner_user_id));
   cohorts.push({cohort_month:m,target_month:target,month_offset:offset,eligible_customers:String(members.size),observation_complete:matured,
    repurchased_customers:matured?String(repeat.size):null,calendar_month_subscription_repurchase_rate:matured?ratioJson(ratio(BigInt(repeat.size),BigInt(members.size))):null});
  }
 }
 const originalBatches=new Map<string,{month:string;origin_lot_id:string;order_id:string|null;source:string;redeemed_points:bigint;returned_points:bigint;earned:ExactRatio;reversed:ExactRatio;complete:boolean}>();
 for(const [kind,slices]of [['redeem',redemptions],['return',corrections]] as const)for(const s of slices){
  const m=month(s.occurred_at);if(m<input.from||m>input.to)continue;const origin=s.origin_lot_id??s.lot_id,key=m+'|'+origin;
  const b=originalBatches.get(key)??{month:m,origin_lot_id:origin,order_id:s.order_id,source:s.source,redeemed_points:0n,returned_points:0n,earned:ZERO,reversed:ZERO,complete:true};
  const value=consideration([s]);b.complete&&=value.complete&&(kind!=='redeem'||!inconsistent.has(s.event_id));
  if(kind==='redeem'){b.redeemed_points+=int64(s.points);b.earned=add(b.earned,value.known);}else{b.returned_points+=int64(s.points);b.reversed=add(b.reversed,value.known);}originalBatches.set(key,b);
 }
 return{report_version:SUBSCRIPTION_FACTS_VERSION,from:input.from,to:input.to,as_of:input.as_of,time_zone:'Asia/Shanghai',months,cohorts,
  unallocated_cash_refunds:{events:String(undatedRefunds.length),amount_fen:sumPoints(undatedRefunds.map(r=>r.amount_fen)),refund_ids:undatedRefunds.flatMap(r=>r.refund_id?[r.refund_id]:[])},
  cohort_status:cohorts.length?'observed_retained_paid_cohorts':'no_observed_retained_paid_cohort',
  original_batches:[...originalBatches.values()].sort((a,b)=>a.month.localeCompare(b.month)||a.origin_lot_id.localeCompare(b.origin_lot_id)).map(b=>({month:b.month,origin_lot_id:b.origin_lot_id,order_id:b.order_id,source:b.source,
   redeemed_points:serializeInt64(b.redeemed_points),quality_returned_points:serializeInt64(b.returned_points),consideration_complete:b.complete,net_earned_order_consideration_fen:b.complete?ratioJson(subtract(b.earned,b.reversed)):null})),
  mixed_funding_allocations:[...redemptions.map(s=>({kind:'redemption' as const,...s})),...corrections.map(s=>({kind:'quality_return' as const,...s}))]
   .filter(s=>s.funding_required||s.funding_slices?.length).map(s=>({kind:s.kind,event_id:s.event_id,lot_id:s.lot_id,origin_lot_id:s.origin_lot_id,
    points:s.points,consideration_complete:consideration([s]).complete,funding:s.funding_slices??[]})),
  excluded_legacy_progress_settlement_points:input.excluded_legacy_settlement_points,
  accounting_notice:'Read-only management facts, not statutory revenue or company profit. Paid orders are prepayments; verified payer cash and cash refunds are separate from earned original-lot A*p/Q consideration. Cash refunds follow authenticated channel success time, never original payment, refund application or local recording time. Missing refund success dates leave all monthly refund totals and net cash flow unknown; known monthly refunds and unallocated amounts remain explicit until authenticated dates arrive. Quality returns reverse earned consideration; cash refunds are not deducted again from earned consideration. Expired balances are current unfrozen/frozen snapshots grouped by expiry month, not historical expiry flows or breakage income. Cohorts exclude fully cash-refunded periods and missing/zero payer cash proof as of this snapshot; historical cohorts can restate after refunds. Renewal requires a new period after an earlier retained period ended; same/overlapping-month purchases and refunded reopenings do not establish renewal. Only fully observed later calendar months have repurchase rates; this is purchase recurrence, not product retention. Legacy progress-billing settlements are excluded explicitly. No forecast, supplier expense, tax or profit is inferred.'};
}

/** One repeatable-read, read-only snapshot. This CLI has no financial writer. */
export async function readSubscriptionFacts(pool:Pool,from:string,to:string){
 checkRange(from,to);
 return transaction(pool,async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const asOf=(await c.query('SELECT now() at')).rows[0].at.toISOString();
  const orders=(await c.query(`SELECT o.id order_id,o.owner_user_id,o.order_kind,COALESCE(o.provider_paid_at,o.credited_at) occurred_at,o.amount_fen::text,
    proof.cash_amount_fen::text,COALESCE(refunds.amount,0)::text refunded_fen,p.starts_at period_start,p.ends_at period_end
    FROM bb_recharge_orders o LEFT JOIN bb_payment_cash_proofs proof ON proof.order_id=o.id AND proof.owner_user_id=o.owner_user_id
    LEFT JOIN bb_subscription_periods p ON p.order_id=o.id AND p.owner_user_id=o.owner_user_id
    LEFT JOIN LATERAL(SELECT sum(amount_fen) amount FROM bb_payment_refunds WHERE order_id=o.id AND owner_user_id=o.owner_user_id AND state='succeeded') refunds ON true
    WHERE o.state='paid' AND o.credited_at IS NOT NULL ORDER BY o.credited_at,o.id`)).rows;
  const slices=(await c.query(`SELECT e.id event_id,e.reservation_id,e.points::text event_total_points,e.created_at occurred_at,COALESCE(a.lot_id,'unmapped:'||e.id) lot_id,l.cash_origin_lot_id origin_lot_id,l.cash_order_id order_id,COALESCE(l.source,'unknown') source,
    COALESCE(bb_credit_allocation_charge(a.reservation_id,a.lot_id),e.points)::text points,l.cash_basis_fen::text basis_fen,l.cash_basis_points::text basis_points,
    (l.cash_order_id IS NULL AND l.cash_basis_fen>0) funding_required,${lotFundingEvidenceSql()} funding_slices
    FROM bb_credit_events e JOIN bb_credit_reservations r ON r.id=e.reservation_id AND r.owner_user_id=e.owner_user_id
    LEFT JOIN bb_credit_allocations a ON a.reservation_id=r.id AND bb_credit_allocation_charge(a.reservation_id,a.lot_id)>0 LEFT JOIN bb_credit_lots l ON l.id=a.lot_id AND l.owner_user_id=e.owner_user_id
    WHERE e.kind='settle' AND r.billing_policy='on_delivery' AND e.points>0
    AND e.created_at>=($1||'-01')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AND e.created_at<(($2||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai'`,[from,to])).rows;
  const corrections=(await c.query(`SELECT e.id event_id,e.created_at occurred_at,COALESCE(e.lot_id,'unmapped:'||e.id) lot_id,l.cash_origin_lot_id origin_lot_id,l.cash_order_id order_id,COALESCE(l.source,'unknown') source,e.points::text,
    l.cash_basis_fen::text basis_fen,l.cash_basis_points::text basis_points,
    (l.cash_order_id IS NULL AND l.cash_basis_fen>0) funding_required,${lotFundingEvidenceSql()} funding_slices FROM bb_credit_events e
    JOIN bb_credit_reservations r ON r.id=e.reservation_id AND r.owner_user_id=e.owner_user_id
    LEFT JOIN bb_credit_lots l ON l.id=e.lot_id AND l.owner_user_id=e.owner_user_id
    WHERE e.kind='correction' AND r.billing_policy='on_delivery'
    AND e.created_at>=($1||'-01')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AND e.created_at<(($2||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai'`,[from,to])).rows;
  const cash=(await c.query(`SELECT e.refund_id,r.provider_succeeded_at occurred_at,e.cash_refunded_fen::text amount_fen
    FROM bb_payment_refund_events e LEFT JOIN bb_payment_refunds r ON r.id=e.refund_id AND r.owner_user_id=e.owner_user_id
    WHERE e.kind='succeeded'`)).rows;
  const expired=(await c.query('SELECT expires_at,remaining::text,frozen::text FROM bb_credit_lots WHERE expires_at<=now() AND remaining>0')).rows;
  const excluded=(await c.query(`SELECT COALESCE(sum(e.points),0)::text points FROM bb_credit_events e JOIN bb_credit_reservations r ON r.id=e.reservation_id AND r.owner_user_id=e.owner_user_id
    WHERE e.kind='settle' AND r.billing_policy<>'on_delivery' AND e.created_at>=($1||'-01')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AND e.created_at<(($2||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai'`,[from,to])).rows[0].points;
  const dateRows=(rows:any[])=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([key,value])=>[key,value instanceof Date?value.toISOString():value])));
  return summarizeSubscriptionFacts({from,to,as_of:asOf,orders:dateRows(orders) as Order[],redemptions:dateRows(slices) as Slice[],corrections:dateRows(corrections) as Slice[],cash_refunds:dateRows(cash) as Refund[],expired_lots:dateRows(expired) as Expiry[],excluded_legacy_settlement_points:excluded});
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [from,to]=process.argv.slice(2);if(!process.env.DATABASE_URL||!from||!to)throw Error('Use DATABASE_URL=<read-only database> node subscription-facts-report.js YYYY-MM YYYY-MM');
 const {Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL});
 try{process.stdout.write(JSON.stringify(await readSubscriptionFacts(pool,from,to),null,2)+'\n');}finally{await pool.end();}
}
