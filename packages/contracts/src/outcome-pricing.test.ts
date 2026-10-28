import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {calculateOutcomePrice,OUTCOME_RATE_CARD,OUTCOME_PRICE_VERSION,LEGACY_OUTCOME_PRICE_VERSION,OutcomePricingInputError,OutcomeWorkPlanSchema,type GoalOutcomePriceKey,type OutcomePricingItem,type OutcomeOwnedCoverage,type OutcomePricingInput} from './outcome-pricing.js';
import {OUTCOME_CATALOG,commerceSchemas,commerceMetadata,CommercePriceMetadataSchema,ScopeQuotationSchema,ScopeLineSchema} from './commerce.js';
import {qaSchemas} from './project-qa.js';
import {projectFileSchemas} from './project-file-workspace.js';

const evidence=['synthetic:运营已确认本项目工作目标及交付范围'];
const goal=(price_key:GoalOutcomePriceKey,coverage_key='goal-1',key=coverage_key):OutcomePricingItem=>({key,coverage_key,evidence,family:'goal_upgrade',price_key});
const financial=(main_period_keys:string[],extra:Partial<Extract<OutcomePricingItem,{family:'financial_group'}>>={}):OutcomePricingItem=>({key:'financial-1',coverage_key:'issuer-snapshot-basis-1',evidence,family:'financial_group',main_period_keys,annual_main_periods:3,interim_main_periods:1,...extra});
const owned=(price_key:OutcomeOwnedCoverage['price_key'],extra:Partial<OutcomeOwnedCoverage>={}):OutcomeOwnedCoverage=>({id:'receipt-1',coverage_key:'goal-1',price_key,...extra});
const quote=(items:OutcomePricingItem[],owned_coverage:OutcomeOwnedCoverage[]=[])=>calculateOutcomePrice({scope_status:'confirmed',items,owned_coverage});
const periodReceipt=(period_keys:string[],extra:Partial<OutcomeOwnedCoverage>={})=>owned('period',{coverage_key:'issuer-snapshot-basis-1',period_keys,...extra});

test('trial-03 prices use integer fen and unpriced integrity is unavailable rather than free',()=>{
 assert.deepEqual(OUTCOME_RATE_CARD,{fact_reply:980,fact_revision:3900,calculation_reply:3900,argument_revision:9900,argument_reply:9900,new_disclosure:9900,period:24900,financial_restatement:24900,financial_group:49900,template:1990,check:990,sync:1990,review:14900});
 const catalog={enabled:true,currency:'CNY',version:OUTCOME_PRICE_VERSION,model:'pay_as_you_go',items:OUTCOME_CATALOG,rules:[]};
 assert.equal(Value.Check(commerceSchemas.CommerceCatalogResponse,catalog),true);
 assert.deepEqual(OUTCOME_CATALOG.filter(item=>item.price_fen===null).map(item=>[item.code,item.capability]),[['integrity_check','unavailable']]);
});

test('one target progresses 9.8 → 39 → 99 by valid owned tier, not by repeated charges',()=>{
 assert.equal(quote([goal('fact_reply')]).amount_fen,980);
 const second=quote([goal('fact_revision')],[owned('fact_reply')]);
 assert.equal(second.amount_fen,2920);
 assert.equal(second.scope_lines[0].pricing?.owned_coverage_fen,980);
 const third=quote([goal('argument_revision')],[owned('fact_reply'),owned('fact_revision',{id:'receipt-2'})]);
 assert.equal(third.amount_fen,6000);
 assert.equal(third.pricing_items[0].owned_coverage_fen,3900);
 assert.equal(quote([goal('argument_revision')],[owned('argument_revision')]).amount_fen,0);
 // A valid 99-yuan promise remains 99-yuan coverage even if that receipt was issued for a small upgrade difference.
 assert.equal(quote([goal('argument_revision')],[owned('argument_revision',{id:'upgrade-receipt'})]).amount_fen,0);
});

test('same goal reply and necessary draft merge once at the final tier',()=>{
 const result=quote([goal('fact_reply','same','reply'),goal('fact_revision','same','draft'),goal('argument_revision','same','argument')]);
 assert.equal(result.amount_fen,9900);assert.equal(result.scope_lines.length,1);
 assert.equal(result.pricing_items[0].price_key,'argument_revision');
 assert.equal(Value.Check(ScopeLineSchema,result.scope_lines[0]),true);
});

test('a different goal or genuinely new financial identity cannot consume unrelated coverage',()=>{
 assert.equal(quote([goal('new_disclosure','another-goal')],[owned('fact_revision')]).amount_fen,9900);
 assert.equal(quote([financial(['2026'],{coverage_key:'new-snapshot'})],[periodReceipt(['2026'])]).amount_fen,24900);
});

test('9.9 check upgrades to 19.9 sync with a 10-yuan difference; financial review is separate',()=>{
 assert.equal(quote([goal('sync')],[owned('check')]).amount_fen,1000);
 assert.throws(()=>quote([goal('sync')],[owned('review')]),OutcomePricingInputError);
 assert.throws(()=>quote([goal('fact_revision')],[owned('check')]),OutcomePricingInputError);
 const result=quote([{key:'review',coverage_key:'review-version-1',evidence,family:'independent_output',price_key:'review'}],[owned('check')]);
 assert.equal(result.amount_fen,14900);
});

test('financial work charges 249, 498, then 499 for one, two, then three new main periods',()=>{
 for(const [keys,amount] of [[['2026'],24900],[['2025','2026'],49800],[['2024','2025','2026'],49900]] as [string[],number][]){
  assert.equal(quote([financial(keys)]).amount_fen,amount);
 }
});

test('financial same-group split work and already-owned periods are deduplicated',()=>{
 const result=quote([financial(['2025','2026']),financial(['2026'],{key:'repeat-line'})],[periodReceipt(['2025'])]);
 assert.equal(result.amount_fen,24900);assert.equal(result.scope_lines.length,1);
 assert.deepEqual(result.pricing_items[0].period_keys,['2026']);
 assert.equal(quote([financial(['2025'])],[periodReceipt(['2025'])]).amount_fen,0);
});

test('financial incremental receipts reach the same 499 cap and a one-yuan period is still valid coverage',()=>{
 assert.equal(quote([financial(['2025'])],[periodReceipt(['2024'])]).amount_fen,24900);
 const after498=quote([financial(['2026'])],[periodReceipt(['2024']),periodReceipt(['2025'],{id:'r2'})]);
 assert.equal(after498.amount_fen,100);
 const after499=quote([financial(['2026','2026Q3'])],[periodReceipt(['2024']),periodReceipt(['2025'],{id:'r2'}),periodReceipt(['2026'],{id:'one-yuan-receipt'})]);
 assert.equal(after499.amount_fen,0);assert.deepEqual(after499.pricing_items[0].period_keys,['2026Q3']);
 assert.deepEqual(after499.pricing_items[0].owned_coverage_ids,['receipt-1','r2','one-yuan-receipt']);
});

test('full-price financial periods are independent; only discounted or included coverage pins prior receipts',()=>{
 const first=quote([financial(['2024'])]);assert.equal(first.amount_fen,24900);assert.deepEqual(first.pricing_items[0].owned_coverage_ids,[]);
 const second=quote([financial(['2025'])],[periodReceipt(['2024'])]);assert.equal(second.amount_fen,24900);assert.deepEqual(second.pricing_items[0].owned_coverage_ids,[]);
 const third=quote([financial(['2026'])],[periodReceipt(['2024']),periodReceipt(['2025'],{id:'r2'})]);assert.equal(third.amount_fen,100);assert.deepEqual(third.pricing_items[0].owned_coverage_ids,['receipt-1','r2']);
 const repeated=quote([financial(['2024'])],[periodReceipt(['2024'])]);assert.equal(repeated.amount_fen,0);assert.deepEqual(repeated.pricing_items[0].owned_coverage_ids,['receipt-1']);
 const completion=quote([financial([],{requires_complete_group_build:true})],[periodReceipt(['2024'])]);assert.equal(completion.amount_fen,25000);assert.deepEqual(completion.pricing_items[0].owned_coverage_ids,['receipt-1']);
});

test('necessary restatement and repair are included; another independently commissioned 99 target totals 348',()=>{
 const update=financial(['2026'],{necessary_restatement:true});
 assert.equal(quote([update]).amount_fen,24900);
 const disclosure:OutcomePricingItem={key:'fund-use',coverage_key:'separate-funds-use-target',evidence,family:'independent_output',price_key:'new_disclosure'};
 assert.equal(quote([update,disclosure]).amount_fen,34800);
 const reconstruction:OutcomePricingItem={key:'rebuild',coverage_key:'outside-original-financial-goal',evidence,family:'independent_output',price_key:'financial_restatement'};
 assert.equal(quote([reconstruction]).amount_fen,24900);
});

test('complete financial group is 499 and owned complete group never charges for the original target',()=>{
 const full=financial([],{requires_complete_group_build:true});
 assert.equal(quote([full]).amount_fen,49900);
 assert.equal(quote([full],[periodReceipt(['2024'])]).amount_fen,25000);
 const complete=owned('financial_group',{coverage_key:'issuer-snapshot-basis-1',complete_group:true});
 assert.equal(quote([financial(['2026'])],[complete]).amount_fen,0);
 assert.equal(quote([full],[complete]).amount_fen,0);
 assert.equal(quote([full],[complete]).pricing_items[0].complete_group,true);
});

test('included work requires an explicit valid parent receipt for the same coverage identity',()=>{
 const included:OutcomePricingItem={key:'correction',coverage_key:'goal-1',evidence,family:'included',owned_coverage_id:'receipt-1',reason:'原范围补证与纠错'};
 const result=quote([included],[owned('fact_revision')]);
 assert.equal(result.status,'ready');assert.equal(result.amount_fen,0);
 assert.deepEqual(result.pricing_items[0].owned_coverage_ids,['receipt-1']);
 assert.throws(()=>quote([included]),OutcomePricingInputError);
 assert.throws(()=>quote([included],[owned('fact_revision',{coverage_key:'different-target'})]),OutcomePricingInputError);
});

test('exact independent output reuse costs zero and different output identity is charged separately',()=>{
 const output:OutcomePricingItem={key:'template',coverage_key:'template-output-1',evidence,family:'independent_output',price_key:'template'};
 assert.equal(quote([output]).amount_fen,1990);
 assert.equal(quote([output],[owned('template',{coverage_key:'template-output-1'})]).amount_fen,0);
 assert.throws(()=>quote([output],[owned('new_disclosure',{coverage_key:'template-output-1'})]),OutcomePricingInputError);
});

test('unknown and unsupported scope remain nonexecutable, distinct from valid included zero',()=>{
 for(const [scope_status,status] of [['unknown','pending_scope'],['unsupported','unavailable']] as const){
  const result=calculateOutcomePrice({scope_status,items:[]});
  assert.equal(result.status,status);assert.equal(result.amount_fen,null);assert.deepEqual(result.scope_lines,[]);assert.deepEqual(result.pricing_items,[]);
 }
 assert.equal(quote([financial(['2026'],{annual_main_periods:4})]).status,'unavailable');
});

test('public plan excludes ownership; malformed counts, duplicate receipt ids and work ids are rejected',()=>{
 const plan={scope_status:'confirmed',items:[goal('fact_reply')]};
 assert.equal(Value.Check(OutcomeWorkPlanSchema,plan),true);
 assert.equal(Value.Check(OutcomeWorkPlanSchema,{...plan,owned_coverage:[owned('argument_revision')]}),false);
 assert.throws(()=>quote([goal('fact_reply')],[owned('fact_reply'),owned('fact_revision')]),OutcomePricingInputError);
 assert.throws(()=>quote([goal('fact_reply'),goal('fact_revision')]),OutcomePricingInputError);
 assert.throws(()=>calculateOutcomePrice({scope_status:'confirmed',items:[financial(['2026'],{annual_main_periods:1.5})]}),OutcomePricingInputError);
 assert.throws(()=>calculateOutcomePrice({...plan,paid_amount_fen:9900} as unknown as OutcomePricingInput),OutcomePricingInputError);
 assert.throws(()=>quote([financial(['2026'],{annual_main_periods:1,interim_main_periods:0})],[periodReceipt(['2025'])]),OutcomePricingInputError);
});

test('legacy outcome metadata preserves the submitted amount and all historical version schemas read v1',()=>{
 const original=commerceMetadata(14900,14900,1,LEGACY_OUTCOME_PRICE_VERSION);
 assert.equal(original.amount_fen,14900);assert.equal(original.price_version,LEGACY_OUTCOME_PRICE_VERSION);
 assert.equal(Value.Check(CommercePriceMetadataSchema,original),true);
 assert.equal(commerceMetadata(980).price_version,OUTCOME_PRICE_VERSION);
 assert.equal(Value.Check(ScopeQuotationSchema.properties.price_version,LEGACY_OUTCOME_PRICE_VERSION),true);
 assert.equal(Value.Check(qaSchemas.QaQuoteResponse,{...original,points:14900,price_version:LEGACY_OUTCOME_PRICE_VERSION}),true);
 assert.equal(Value.Check(projectFileSchemas.ProjectFileBatchRequest.properties.price_version,LEGACY_OUTCOME_PRICE_VERSION),true);
 assert.equal(Value.Check(projectFileSchemas.ProjectFileCheckRequest.properties.price_version,LEGACY_OUTCOME_PRICE_VERSION),true);
 assert.equal(Value.Check(projectFileSchemas.ProjectFileUpdateRequest.properties.price_version,LEGACY_OUTCOME_PRICE_VERSION),true);
 assert.equal(Value.Check(CommercePriceMetadataSchema,{...original,price_version:'project-file-update-4500-v1'}),true);
 assert.equal(Value.Check(ScopeQuotationSchema.properties.price_version,'future-unrecognized-version'),false);
});
