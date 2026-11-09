import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeSubscriptionFacts,type SubscriptionFactsInput} from './subscription-facts-report.js';
const base=():SubscriptionFactsInput=>({from:'2026-01',to:'2026-02',as_of:'2026-03-01T00:00:00+08:00',orders:[],redemptions:[],corrections:[],cash_refunds:[],expired_lots:[],excluded_legacy_settlement_points:'0'});
const order=(id:string,user:string,start:string,end:string,refund='0')=>({order_id:id,owner_user_id:user,order_kind:'subscription',occurred_at:start,amount_fen:'19900',cash_amount_fen:'19900',refunded_fen:refund,period_start:start,period_end:end});
test('refunded reopening is a new retained purchase, calendar repurchase requires a matured subsequent period',()=>{
 const i=base();i.orders=[order('refunded','u1','2026-01-01T00:00:00+08:00','2026-02-01T00:00:00+08:00','19900'),order('reopened','u1','2026-01-03T00:00:00+08:00','2026-02-03T00:00:00+08:00'),order('renewed','u1','2026-02-03T00:00:00+08:00','2026-03-03T00:00:00+08:00'),order('second-user','u2','2026-01-03T00:00:00+08:00','2026-02-03T00:00:00+08:00'),order('same-month','u2','2026-01-04T00:00:00+08:00','2026-02-04T00:00:00+08:00')];
 const report=summarizeSubscriptionFacts(i),jan=report.months[0],next=report.cohorts.find(c=>c.cohort_month==='2026-01'&&c.month_offset===1)!;
 assert.equal(jan.new_retained_subscription_customers,'2');assert.equal(jan.retained_renewal_orders,'0');assert.equal(jan.retained_same_or_overlapping_period_orders,'1');
 assert.equal(report.months[1].retained_renewal_orders,'1');assert.deepEqual(next.calendar_month_subscription_repurchase_rate,{numerator:'1',denominator:'2'});
 const immature=summarizeSubscriptionFacts({...i,as_of:'2026-02-15T00:00:00+08:00'}).cohorts[0];assert.equal(immature.observation_complete,false);assert.equal(immature.repurchased_customers,null);assert.equal(immature.calendar_month_subscription_repurchase_rate,null);
});
test('prepayment, original-lot consideration, quality returns, cash refunds and expiry remain separate',()=>{
 const i=base();i.orders=[order('paid','u1','2026-01-01T00:00:00+08:00','2026-02-01T00:00:00+08:00')];
 const slice={event_id:'earned',occurred_at:'2026-01-15T00:00:00+08:00',lot_id:'lot',origin_lot_id:'lot',order_id:'paid',source:'subscription',points:'10000',basis_fen:'19900',basis_points:'21000'};
 i.redemptions=[slice];i.corrections=[{...slice,event_id:'quality',lot_id:'returned',points:'1000'}];i.cash_refunds=[{occurred_at:'2026-01-20T00:00:00+08:00',amount_fen:'100'}];i.expired_lots=[{expires_at:'2026-01-21T00:00:00+08:00',remaining:'700',frozen:'200'}];
 const report=summarizeSubscriptionFacts(i),m=report.months[0];assert.equal(m.accepted_order_amount_fen,'19900');assert.equal(m.net_payer_cash_flow_fen,'19800');
 assert.deepEqual(m.net_earned_order_consideration_fen,{numerator:'59700',denominator:'7'});assert.equal(m.expired_unfrozen_points_at_snapshot,'500');assert.equal(m.expired_frozen_points_at_snapshot,'200');
 assert.equal(report.original_batches.length,1);assert.deepEqual(report.original_batches[0].net_earned_order_consideration_fen,m.net_earned_order_consideration_fen);
});
test('missing proof remains unknown and empty cohorts never imply zero retention',()=>{
 const i=base();i.orders=[{...order('unknown','u','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z'),cash_amount_fen:null}];
 i.redemptions=[{event_id:'e',occurred_at:'2026-01-15T00:00:00Z',lot_id:'missing',origin_lot_id:null,order_id:null,source:'purchase',points:'9007199254740993',basis_fen:null,basis_points:null}];
 const r=summarizeSubscriptionFacts(i);assert.equal(r.months[0].verified_payer_cash_fen,null);assert.equal(r.months[0].redeemed_points,'9007199254740993');assert.equal(r.months[0].net_earned_order_consideration_fen,null);assert.equal(r.cohort_status,'no_observed_retained_paid_cohort');assert.deepEqual(r.cohorts,[]);
});
test('incomplete or duplicate settlement allocations cannot appear as exact earned revenue',()=>{
 const i=base(),s={event_id:'e',reservation_id:'r',event_total_points:'10',occurred_at:'2026-01-15T00:00:00Z',lot_id:'lot',origin_lot_id:'lot',order_id:'o',source:'purchase',points:'9',basis_fen:'10',basis_points:'10'};
 for(const slices of [[s],[{...s,points:'10'},{...s,event_id:'duplicate',points:'10'}]]){
  const r=summarizeSubscriptionFacts({...i,redemptions:slices});assert.equal(r.months[0].redeemed_points,null);assert.equal(r.months[0].consideration_complete,false);assert.equal(r.months[0].net_earned_order_consideration_fen,null);assert.equal(r.original_batches[0].consideration_complete,false);
 }
});
test('cash refunds keep their authenticated success month, Shanghai month boundary and snapshot cutoff',()=>{
 const i=base();i.orders=[order('paid','u','2026-01-30T00:00:00Z','2026-02-28T00:00:00Z')];
 i.cash_refunds=[{refund_id:'jan',occurred_at:'2026-01-31T15:59:59.000Z',amount_fen:'100'},
  {refund_id:'feb',occurred_at:'2026-01-31T16:00:00.000Z',amount_fen:'200'}];
 const r=summarizeSubscriptionFacts(i);assert.equal(r.report_version,'subscription-facts-exact-v2');
 assert.equal(r.months[0].cash_refunded_fen,'100');assert.equal(r.months[0].net_payer_cash_flow_fen,'19800');
 assert.equal(r.months[1].cash_refunded_fen,'200');assert.equal(r.months[1].net_payer_cash_flow_fen,'-200');
 const earlier=summarizeSubscriptionFacts({...i,as_of:'2026-01-31T15:59:59.000Z'});
 assert.equal(earlier.months[0].cash_refunded_fen,'100');assert.equal(earlier.months[1].cash_refunded_fen,'0');
});
test('undated successful refunds are explicit unknown amounts instead of zero or local-date cash flow',()=>{
 const i=base();i.cash_refunds=[{refund_id:'known',occurred_at:'2026-01-20T00:00:00Z',amount_fen:'100'},
  {refund_id:'missing',occurred_at:null,amount_fen:'9007199254740993'}];
 const r=summarizeSubscriptionFacts(i);
 assert.deepEqual(r.unallocated_cash_refunds,{events:'1',amount_fen:'9007199254740993',refund_ids:['missing']});
 assert.equal(r.months[0].cash_refunded_fen_known,'100');assert.equal(r.months[1].cash_refunded_fen_known,'0');
 for(const m of r.months){assert.equal(m.cash_refunded_fen,null);assert.equal(m.net_payer_cash_flow_fen,null);}
 const recovered=summarizeSubscriptionFacts({...i,cash_refunds:i.cash_refunds.map(s=>s.refund_id==='missing'?{...s,occurred_at:'2026-02-01T00:00:00Z'}:s)});
 assert.deepEqual(recovered.unallocated_cash_refunds,{events:'0',amount_fen:'0',refund_ids:[]});
 assert.equal(recovered.months[0].cash_refunded_fen,'100');assert.equal(recovered.months[1].cash_refunded_fen,'9007199254740993');
});
