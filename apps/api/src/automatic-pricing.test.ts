import assert from 'node:assert/strict';
import test from 'node:test';
import {AUTOMATIC_TASK_TARIFF,AUTOMATIC_PRICE_VERSION,emptyUpdateDetails,reportingWindow} from '@bondbuddy/contracts';
import {resolveAutomaticTaskPrice} from './automatic-pricing.js';

test('all eleven tariff rows preserve the supplied base-fen 1.7 rounding',()=>{
  assert.equal(Object.keys(AUTOMATIC_TASK_TARIFF).length,11);
  for(const [sku,row]of Object.entries(AUTOMATIC_TASK_TARIFF))assert.equal(row.points,Math.ceil(row.base_fen*17/10),sku);
});
test('independent question list charges one unit each; malformed or oversized lists are rejected',()=>{
  const price=resolveAutomaticTaskPrice('project_qa_answer',{questions:[{id:'q0',question:'第一题'},{id:'q1',question:'第二题'}]});
  assert.equal(price.points,2436);assert.equal(price.lines.length,2);assert.equal(price.version,AUTOMATIC_PRICE_VERSION);
  assert.throws(()=>resolveAutomaticTaskPrice('project_qa_answer',{questions:[{id:'q',question:'a'},{id:'q',question:'b'}]}),/无效/);
  assert.throws(()=>resolveAutomaticTaskPrice('project_qa_answer',{questions:[]}),/独立问题/);
});
test('integrity scope never splits an oversized request into silently chargeable rounds',()=>{
  const draft={subjects:Array.from({length:5},(_,i)=>({id:'s'+i})),site_ids:Array.from({length:20},(_,i)=>'site'+i)};
  assert.equal(resolveAutomaticTaskPrice('integrity_round',{draft}).points,22738);
  assert.throws(()=>resolveAutomaticTaskPrice('integrity_round',{draft:{...draft,subjects:[...draft.subjects,{id:'s5'}]}}),/1至5/);
});
test('one-question chat cannot accept an explicit multi-question list at one-unit price',()=>{
  assert.equal(resolveAutomaticTaskPrice('m4_qa',{content:'请说明本期收入增长的主要原因。'}).points,1218);
  assert.throws(()=>resolveAutomaticTaskPrice('m4_qa',{content:'1. 说明收入增长\n2. 核对抵押资产'}),/逐题回复/);
  assert.throws(()=>resolveAutomaticTaskPrice('m4_qa',{content:'收入为何增长？负债为何下降？'}),/逐题回复/);
});
test('new check includes repair; older checks retain their original upgrade rights',()=>{
  const manifest={file_version_id:'f'};
  assert.equal(resolveAutomaticTaskPrice('project_file_patch',{manifest,paid_check:{quote_id:'paid',price_version:AUTOMATIC_PRICE_VERSION}}).points,0);
  assert.equal(resolveAutomaticTaskPrice('project_file_patch',{manifest,paid_check:{quote_id:'old',price_version:'outcome-cny-20261028-v2'}}).points,1000);
  assert.equal(resolveAutomaticTaskPrice('project_file_patch',{manifest,paid_check:null}).points,6095);
});
test('workpaper is a separately commissioned document and not an automatic 280-unit purchase',()=>{
  const snapshot={kind:'document',input:{document_type:'workpaper'},billing_task:'m4_workpaper'};
  assert.equal(resolveAutomaticTaskPrice('m4_document',snapshot).points,3458);
  assert.equal(resolveAutomaticTaskPrice('m4_document',{...snapshot,input:{document_type:'recommendation'},billing_task:'m4_G04'}).points,7965);
});
test('more than three new annual periods is unsupported rather than silently capped',()=>{
  const manifest={draft_revision:1,issuer_name:'Synthetic',market:'sse',offering:'private',materials:[],
    update_details:{...emptyUpdateDetails(),reporting_cutoff:'2028-12-31',target_reporting_periods:Array.from({length:4},(_,i)=>({end:`${2025+i}-12-31`,period_kind:'annual'}))},
    authoring:{version:'unified_v1',source_prospectuses:[{material_id:'source',relation:'same_issuer',market:'sse',offering:'private',reporting_periods:reportingWindow('sse','private','2024-12-31')}],requirements:[]}};
  assert.throws(()=>resolveAutomaticTaskPrice('authoring',manifest),/超过三个年度/);
});
