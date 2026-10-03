import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_FIXED_PRICES, emptyUpdateDetails, reportingWindow, type SourceProspectus } from '@bondbuddy/contracts';
import { classifyFixedPrice } from './billing-classification.js';
import { validatePrices } from './billing.js';

function fixture(years: number, migration = false) {
  const source: SourceProspectus = {material_id:'source',material_version:1,sha256:'a'.repeat(64),issuer_name:'Synthetic',relation:'same_issuer',market:'sse',offering:'private',status:'user_asserted',reporting_periods:reportingWindow('sse','private','2022-12-31')};
  const annuals: SourceProspectus['reporting_periods']=Array.from({length:years},(_,i)=>({start:`${2023+i}-01-01`,end:`${2023+i}-12-31`,period_kind:'annual' as const,scope:null,status:'user_asserted' as const,evidence_refs:[]}));
  return {market:migration?'szse':'sse',offering:'private',materials:[{material_id:'source',role:'historical'}],
    update_details:{...emptyUpdateDetails(),target_reporting_periods:annuals},
    authoring:{version:'unified_v1',source_prospectuses:[source],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}};
}
test('all eight fixed tiers and user-approved boundaries use one package',()=>{
  for(const [years,migration,expected] of [[0,false,'interim'],[1,false,'annual'],[2,false,'two_years'],[3,false,'three_years'],[0,true,'migration'],[1,true,'migration'],[2,true,'migration_two_years'],[3,true,'migration_three_years'],[5,false,'three_years'],[5,true,'migration_three_years']] as const){
    const m=fixture(years,migration);
    if(!years)m.update_details.target_reporting_periods=reportingWindow('sse','private','2022-12-31');
    assert.equal(classifyFixedPrice(m).task,expected);
  }
  const m=fixture(1);m.materials=[];m.authoring.source_prospectuses=[];
  assert.equal(classifyFixedPrice(m).task,'new_authoring');
});
test('annual update includes interim, de-duplicates statements, and only charges newly covered annual periods',()=>{
  const m=fixture(1);
  m.authoring.source_prospectuses[0].reporting_periods=reportingWindow('sse','private','2024-12-31');
  m.update_details.target_reporting_periods=reportingWindow('sse','private','2026-09-30');
  m.update_details.target_reporting_periods.push(...m.update_details.target_reporting_periods);
  assert.equal(classifyFixedPrice(m).task,'annual');
});
test('non-issuer references never reduce target periods; missing metadata never silently selects highest price',()=>{
  for(const relation of ['parent','subsidiary','similar_business'] as const){
    const m=fixture(1);m.authoring.source_prospectuses[0].relation=relation;
    assert.equal(classifyFixedPrice(m).task,'new_authoring');
  }
  const absent=fixture(1);absent.authoring.source_prospectuses=[];
  assert.equal(classifyFixedPrice(absent).task,null);
  const partial=fixture(1);partial.authoring.source_prospectuses[0].relation=null;
  assert.equal(classifyFixedPrice(partial).task,null);
});
test('price configuration requires exactly eight bounded integer prices',()=>{
  validatePrices(INITIAL_FIXED_PRICES);
  for(const prices of [{...INITIAL_FIXED_PRICES,annual:0},{...INITIAL_FIXED_PRICES,annual:1.1},{...INITIAL_FIXED_PRICES,annual:Infinity},{...INITIAL_FIXED_PRICES,ninth:10},{}])
    assert.throws(()=>validatePrices(prices));
});
