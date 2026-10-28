import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPENSE_CATEGORIES,summarizeRunCosts} from './commerce-economics.js';
const expenses=()=>EXPENSE_CATEGORIES.map((category,i)=>({id:String(i),category,amount_fen:i===0?300:0,within_fixed_budget:false}));
const base=()=>({run_id:'synthetic-run',state:'succeeded',revenue_fen:10000,compensation_fen:0,attempts:[{attempt_id:'first',billable:true,pricing_status:'priced',usage_status:'measured',currency:'CNY',cost_amount:'2.5',cached_input_tokens:10,reasoning_tokens:1},{attempt_id:'retry',billable:true,pricing_status:'priced',usage_status:'measured',currency:'CNY',cost_amount:'1.5',cached_input_tokens:0,reasoning_tokens:0}],expenses:expenses()});
const reviewed=(b:ReturnType<typeof base>)=>summarizeRunCosts({...b,reviews:[{snapshot_hash:summarizeRunCosts(b).snapshot_hash,model_required:true}]});
test('all billable attempts count, company-budget allocations do not count twice and contribution is not net margin',()=>{
 const b=base();b.expenses[1]={...b.expenses[1],amount_fen:160000,within_fixed_budget:true};
 const r=reviewed(b);assert.equal(r.cost_complete,true);assert.equal(r.variable_cost_cny,7);assert.equal(r.contribution_cny,93);assert.equal(r.fixed_budget_allocation_fen,160000);assert.equal(r.after_tax_net_margin,null);
});
test('unknown, pending or failed attempts with missing cost never disappear into healthy zero',()=>{
 const b=base();b.attempts.push({...b.attempts[0],attempt_id:'timeout',pricing_status:'unknown',usage_status:'pending',cost_amount:null as any});
 const r=reviewed(b);assert.equal(r.cost_complete,false);assert.equal(r.unpriced_attempts,1);assert.equal(r.variable_cost_cny,null);assert.equal(r.contribution_margin,null);
});
test('foreign currency is reported separately and never implicitly converted to CNY',()=>{
 const b=base();b.attempts[0].currency='USD';const r=reviewed(b);assert.equal(r.cost_complete,false);assert.deepEqual(r.known_model_cost_native,{USD:2.5,CNY:1.5});assert.equal(r.variable_cost_cny,null);
});
test('later cost evidence invalidates an earlier closed review; order of rows does not',()=>{
 const b=base(),old={snapshot_hash:summarizeRunCosts(b).snapshot_hash,model_required:true};
 assert.equal(summarizeRunCosts({...b,attempts:[...b.attempts].reverse(),expenses:[...b.expenses].reverse(),reviews:[old]}).cost_complete,true);
 b.expenses.push({...b.expenses[0],id:'late-extra',amount_fen:100});
 const r=summarizeRunCosts({...b,reviews:[old]});assert.equal(r.cost_complete,false);assert.ok(r.problems.includes('cost_review_missing_or_stale'));
});
test('explicit zero expenses require all categories and a terminal review; missing model evidence cannot close',()=>{
 const b=base();b.expenses.pop();assert.equal(reviewed(b).cost_complete,false);
 const no={...base(),attempts:[]};let r=summarizeRunCosts({...no,reviews:[{snapshot_hash:summarizeRunCosts(no).snapshot_hash,model_required:true}]});assert.equal(r.cost_complete,false);
 r=summarizeRunCosts({...no,reviews:[{snapshot_hash:summarizeRunCosts(no).snapshot_hash,model_required:false}]});assert.equal(r.cost_complete,true);
 r=reviewed({...base(),state:'running'});assert.equal(r.cost_complete,false);
});
test('a missing cache or reasoning subset is incomplete when procurement rates differ',()=>{
 const b=base();Object.assign(b.attempts[0],{cached_input_tokens:null,input_per_million:'2',cached_input_per_million:'0.2'});assert.equal(reviewed(b).cost_complete,false);
 Object.assign(b.attempts[0],{input_per_million:'2',cached_input_per_million:'2'});assert.equal(reviewed(b).cost_complete,true);
});
