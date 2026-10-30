import test from 'node:test';
import assert from 'node:assert/strict';
import {lotFundingMatches,type LotFundingEvidence} from './subscription-funding-evidence.js';
import {summarizeSubscriptionFacts,type SubscriptionFactsInput} from './subscription-facts-report.js';

const funding=():LotFundingEvidence[]=>[
 {funding_source_id:'new',kind:'new_cash',source_order_id:'new-order',source_lot_id:null,point_numerator:'50000',point_denominator:'114000',
  source_point_numerator:'50000',source_point_denominator:'114000',amount_numerator:'50000',amount_denominator:'1',contract_points:'114000',cash_amount_fen:'50000'},
 {funding_source_id:'old',kind:'transfer',source_order_id:'old-order',source_lot_id:'old-lot',point_numerator:'49900',point_denominator:'114000',
  source_point_numerator:'49900',source_point_denominator:'114000',amount_numerator:'49900',amount_denominator:'1',contract_points:'114000',cash_amount_fen:'49900'},
];

test('mixed funding keeps old and new cash separate while exactly summing repeating point consideration',()=>{
 const input={required:true,numerator:'333',denominator:'380',funding:funding()};
 assert.equal(lotFundingMatches(input),true);
 assert.equal(lotFundingMatches({...input,funding:input.funding.slice(0,1)}),false,'Missing transfer cannot be reported as fully funded');
 assert.equal(lotFundingMatches({...input,funding:[...input.funding,input.funding[0]]}),false,'Duplicate provenance cannot increase earned revenue');
 assert.equal(lotFundingMatches({...input,funding:input.funding.map((f,i)=>i?f:{...f,cash_amount_fen:null})}),false);
 assert.equal(lotFundingMatches({...input,funding:input.funding.map((f,i)=>i?f:{...f,point_numerator:'50001'})}),false);
 assert.equal(lotFundingMatches({...input,funding:input.funding.map((f,i)=>i?{...f,source_lot_id:null}:f)}),false);
});

test('consumption and quality returns use mixed original consideration once; a transfer is not another cash receipt',()=>{
 const input:SubscriptionFactsInput={from:'2026-10',to:'2026-10',as_of:'2026-10-31T00:00:00Z',orders:[],redemptions:[],corrections:[],cash_refunds:[],expired_lots:[],excluded_legacy_settlement_points:'0'};
 input.orders=['old-order','new-order'].map((id,i)=>({order_id:id,owner_user_id:'user',order_kind:'subscription',occurred_at:'2026-10-20T00:00:00Z',amount_fen:i?'50000':'49900',cash_amount_fen:i?'50000':'49900',refunded_fen:'0',period_start:i?'2026-10-20T00:00:00Z':'2026-10-01T00:00:00Z',period_end:i?'2026-11-20T00:00:00Z':'2026-11-01T00:00:00Z'}));
 const slice={event_id:'use',occurred_at:'2026-10-21T00:00:00Z',lot_id:'mixed',origin_lot_id:'mixed',order_id:null,source:'subscription',points:'380',basis_fen:'333',basis_points:'380',funding_required:true,funding_slices:funding()};
 input.redemptions=[slice];input.corrections=[{...slice,event_id:'quality',lot_id:'returned',points:'38'}];
 const result=summarizeSubscriptionFacts(input),month=result.months[0];
 assert.equal(month.verified_payer_cash_fen,'99900');assert.equal(month.retained_renewal_orders,'0');
 assert.equal(month.retained_same_or_overlapping_period_orders,'1');
 assert.deepEqual(month.net_earned_order_consideration_fen,{numerator:'2997',denominator:'10'});
 assert.equal(result.original_batches[0].order_id,null,'A mixed source never claims that all consideration came from the new order');
 assert.equal(result.mixed_funding_allocations.length,2);
 input.redemptions=[{...slice,funding_slices:[]}];
 assert.equal(summarizeSubscriptionFacts(input).months[0].net_earned_order_consideration_fen,null);
});
