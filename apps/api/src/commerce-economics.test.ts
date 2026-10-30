import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ECONOMICS_REPORT_VERSION,EXPENSE_CATEGORIES,summarizeRunCosts,type RunCostInput} from './commerce-economics.js';
const fraction=(numerator:string,denominator='1')=>({numerator,denominator});
const expenses=()=>EXPENSE_CATEGORIES.map((category,i)=>({id:String(i),category,amount_fen:i===0?300:0,within_fixed_budget:false}));
const base=():RunCostInput=>({run_id:'synthetic-run',state:'succeeded',revenue_fen:'10000',compensation_fen:'0',
 consideration_slices:[{lot_id:'original',points:'10000',numerator_fen:'10000',denominator_points:'10000'}],compensation_slices:[],
 attempts:[{attempt_id:'first',billable:true,pricing_status:'priced',usage_status:'measured',currency:'CNY',cost_amount:'2.5',cached_input_tokens:10,reasoning_tokens:1},
 {attempt_id:'retry',billable:true,pricing_status:'priced',usage_status:'measured',currency:'CNY',cost_amount:'1.5',cached_input_tokens:0,reasoning_tokens:0}],expenses:expenses()});
const reviewed=(b:RunCostInput,model_required=true)=>summarizeRunCosts({...b,reviews:[{snapshot_hash:summarizeRunCosts(b).snapshot_hash,model_required}]});

test('all attempts count once, budget allocations stay separate, and exact contribution is not net profit',()=>{
 const b=base();b.expenses[1]={...b.expenses[1],amount_fen:160000,within_fixed_budget:true};
 const r=reviewed(b);assert.equal(r.report_version,ECONOMICS_REPORT_VERSION);assert.equal(r.cost_complete,true);
 assert.equal(r.variable_cost_cny,'7');assert.deepEqual(r.contribution_cny,fraction('93'));assert.deepEqual(r.contribution_margin,fraction('93','100'));
 assert.equal(r.fixed_budget_allocation_fen,'160000');assert.equal(r.after_tax_net_margin,null);assert.equal(r.after_tax_net_profit,null);assert.equal(r.actual_supplier_invoice_cost,null);
 assert.equal(r.model_attempts,'2');assert.doesNotThrow(()=>JSON.stringify(r));
});
test('unknown, pending and failed attempts with missing cost never become healthy zero',()=>{
 const b=base();b.attempts.push({...b.attempts[0],attempt_id:'timeout',pricing_status:'unknown',usage_status:'pending',cost_amount:null});
 const r=reviewed(b);assert.equal(r.cost_complete,false);assert.equal(r.unpriced_attempts,'1');assert.equal(r.variable_cost_cny,null);assert.equal(r.contribution_margin,null);
});
test('foreign currency stays exact and separate, never implicitly converted to CNY',()=>{
 const b=base();b.attempts[0].currency='USD';const r=reviewed(b);assert.equal(r.cost_complete,false);
 assert.deepEqual(r.known_model_cost_native,{CNY:'1.5',USD:'2.5'});assert.equal(r.variable_cost_cny,null);assert.equal(r.actual_supplier_invoice_cost,null);
});
test('later evidence invalidates a closed review, but row order does not',()=>{
 const b=base(),old={snapshot_hash:summarizeRunCosts(b).snapshot_hash,model_required:true};
 assert.equal(summarizeRunCosts({...b,attempts:[...b.attempts].reverse(),expenses:[...b.expenses].reverse(),reviews:[old]}).cost_complete,true);
 b.expenses.push({...b.expenses[0],id:'late-extra',amount_fen:100});
 const r=summarizeRunCosts({...b,reviews:[old]});assert.equal(r.cost_complete,false);assert.ok(r.problems.includes('cost_review_missing_or_stale'));
 assert.deepEqual(r.review_history,{current_snapshot_reviewed:false,stale_snapshot_hashes:[old.snapshot_hash]});
});
test('explicit zero expenses still require all categories, terminal state and model evidence review',()=>{
 const b=base();b.expenses.pop();assert.equal(reviewed(b).cost_complete,false);
 const no={...base(),attempts:[]};assert.equal(reviewed(no).cost_complete,false);assert.equal(reviewed(no,false).cost_complete,true);
 assert.equal(reviewed({...base(),state:'running'}).cost_complete,false);
});
test('missing cache or reasoning subset is incomplete when procurement rates differ',()=>{
 const b=base();Object.assign(b.attempts[0],{cached_input_tokens:null,input_per_million:'2',cached_input_per_million:'0.2'});assert.equal(reviewed(b).cost_complete,false);
 Object.assign(b.attempts[0],{input_per_million:'2',cached_input_per_million:'2'});assert.equal(reviewed(b).cost_complete,true);
 Object.assign(b.attempts[0],{reasoning_tokens:null,output_per_million:'2',reasoning_output_per_million:'3'});assert.equal(reviewed(b).cost_complete,false);
});
test('subscription original consideration, not face value, determines contribution',()=>{
 const b=base();b.consideration_slices![0].numerator_fen='9000';
 const r=reviewed(b);assert.equal(r.delivered_service_charge_points,'10000');assert.equal(r.delivered_service_charge_fen,'10000');
 assert.deepEqual(r.net_consideration_fen,fraction('9000'));assert.deepEqual(r.contribution_cny,fraction('83'));
 const unknown=base();unknown.consideration_slices![0].numerator_fen=null;
 const missing=reviewed(unknown);assert.equal(missing.cost_complete,true);assert.equal(missing.consideration_complete,false);
 assert.equal(missing.cash_consideration_fen,null);assert.equal(missing.contribution_cny,null);assert.equal(missing.contribution_margin,null);
});
test('0.1+0.2 and long decimal supplier amounts remain exact before any display rounding',()=>{
 const b=base();b.expenses=expenses().map(e=>({...e,amount_fen:0}));b.attempts[0].cost_amount='0.1';b.attempts[1].cost_amount='0.2';
 let r=reviewed(b);assert.equal(r.known_model_cost_native.CNY,'0.3');assert.equal(r.variable_cost_cny,'0.3');assert.deepEqual(r.contribution_cny,fraction('997','10'));
 b.attempts[0].cost_amount='9007199254740993.123456789012345678901';b.attempts[1].cost_amount='0.000000000000000000009';
 r=reviewed(b);assert.equal(r.variable_cost_cny,'9007199254740993.12345678901234567891');assert.equal(r.display_only.variable_cost_cny,'9007199254740993.123457');
});
test('fractional JS costs, NaN, infinity, negative, exponent and absent decimals are incomplete',()=>{
 for(const cost of [0.1,NaN,Infinity,'-1','1e-3',null,'']){
  const b=base();b.attempts[0].cost_amount=cost;const r=reviewed(b);assert.equal(r.cost_complete,false,String(cost));assert.equal(r.variable_cost_cny,null);
 }
});
test('each non-divisible source A*p/Q is summed exactly and its original correction is subtracted',()=>{
 const b=base();b.revenue_fen='3';b.compensation_fen='1';b.expenses=expenses().map(e=>({...e,amount_fen:0}));b.attempts=[];
 b.consideration_slices=[{lot_id:'subscription',points:'2',numerator_fen:'1',denominator_points:'3'},
  {lot_id:'topup',points:'1',numerator_fen:'2',denominator_points:'7'}];
 b.compensation_slices=[{event_id:'restore',lot_id:'restored-subscription',cash_origin_lot_id:'subscription',points:'1',numerator_fen:'1',denominator_points:'3'}];
 const r=reviewed(b,false);assert.equal(r.consideration_complete,true);
 assert.deepEqual(r.cash_consideration_fen,fraction('20','21'));assert.deepEqual(r.cash_compensation_fen,fraction('1','3'));
 assert.deepEqual(r.net_consideration_fen,fraction('13','21'));assert.deepEqual(r.contribution_cny,fraction('13','2100'));
 assert.deepEqual(r.contribution_margin,fraction('1'));assert.equal(r.display_only.net_consideration_fen,'0.619048');
 assert.equal(r.display_only.authoritative,false);assert.equal(r.display_only.rounding,'nearest_ties_away_from_zero');
 assert.equal(r.display_only.cash_fen_decimal_places,6);assert.equal(r.display_only.margin_decimal_places,8);
});
test('a complete reversal cancels repeating ratios exactly; remaining resource cost is a negative contribution',()=>{
 const b=base();b.revenue_fen='1';b.compensation_fen='1';
 b.consideration_slices=[{lot_id:'original',points:'1',numerator_fen:'1',denominator_points:'3'}];
 b.compensation_slices=[{event_id:'reverse',points:'1',numerator_fen:'1',denominator_points:'3'}];
 const r=reviewed(b);assert.deepEqual(r.net_consideration_fen,fraction('0'));assert.deepEqual(r.contribution_cny,fraction('-7'));
 assert.equal(r.contribution_margin,null);assert.equal(r.display_only.contribution_cny,'-7.000000');
});
test('missing or mismatched compensation/consumption slices do not fabricate known cash',()=>{
 const cases:RunCostInput[]=[];
 const absent=base();delete absent.consideration_slices;cases.push(absent);
 const mismatch=base();mismatch.consideration_slices![0].points='9999';cases.push(mismatch);
 const missingRefund=base();missingRefund.compensation_fen='1';cases.push(missingRefund);
 const unknownRefund=base();unknownRefund.compensation_fen='1';unknownRefund.compensation_slices=[{points:'1',numerator_fen:null,denominator_points:null}];cases.push(unknownRefund);
 const zeroDenominator=base();zeroDenominator.consideration_slices![0].denominator_points='0';cases.push(zeroDenominator);
 for(const b of cases){const r=reviewed(b);assert.equal(r.consideration_complete,false);assert.equal(r.net_consideration_fen,null);assert.equal(r.contribution_cny,null);}
});
test('zero cash activity basis is explicit; excess reversal is an anomaly rather than invented negative revenue',()=>{
 const b=base();b.consideration_slices![0].numerator_fen='0';
 let r=reviewed(b);assert.equal(r.consideration_complete,true);assert.deepEqual(r.cash_consideration_fen,fraction('0'));assert.equal(r.contribution_margin,null);
 b.compensation_fen='1';b.compensation_slices=[{points:'1',numerator_fen:'1',denominator_points:'1'}];r=reviewed(b);
 assert.equal(r.consideration_complete,false);assert.ok(r.consideration_problems.includes('compensation_exceeds_original_consideration'));
});
test('int64 inputs beyond MAX_SAFE stay exact; unsafe numeric inputs and overflow are rejected',()=>{
 const b=base();b.revenue_fen='9223372036854775807';b.compensation_fen='9007199254740993';
 b.consideration_slices=[{points:b.revenue_fen,numerator_fen:'1',denominator_points:'3'}];
 b.compensation_slices=[{points:b.compensation_fen,numerator_fen:'1',denominator_points:'3'}];
 const r=reviewed(b);assert.equal(r.delivered_service_charge_points,'9223372036854775807');assert.equal(r.net_service_points,'9214364837600034814');
 assert.deepEqual(r.net_consideration_fen,fraction('9214364837600034814','3'));
 assert.throws(()=>summarizeRunCosts({...b,revenue_fen:9007199254740992}),RangeError);
 assert.throws(()=>summarizeRunCosts({...b,revenue_fen:'9223372036854775808'}),RangeError);
});
test('legacy arithmetic reviews cannot approve v2, and changed original ratios require a fresh review',()=>{
 const b=base();
 const legacyFacts={run_id:b.run_id,state:b.state,revenue_fen:10000,compensation_fen:0,cash_consideration_fen:'10000',cash_compensation_fen:'0',consideration_slices:b.consideration_slices,attempts:b.attempts,expenses:b.expenses};
 const legacyHash=createHash('sha256').update(JSON.stringify(legacyFacts,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
 let r=summarizeRunCosts({...b,reviews:[{snapshot_hash:legacyHash,model_required:true}]});
 assert.notEqual(r.snapshot_hash,legacyHash);assert.equal(r.cost_complete,false);assert.deepEqual(r.review_history.stale_snapshot_hashes,[legacyHash]);
 const originalHash=r.snapshot_hash;b.consideration_slices![0].denominator_points='21000';
 r=summarizeRunCosts({...b,reviews:[{snapshot_hash:originalHash,model_required:true}]});assert.notEqual(r.snapshot_hash,originalHash);assert.equal(r.cost_complete,false);
});
