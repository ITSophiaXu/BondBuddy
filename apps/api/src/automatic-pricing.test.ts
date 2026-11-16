import assert from 'node:assert/strict';
import test from 'node:test';
import {AUTOMATIC_TASK_TARIFF,AUTOMATIC_PRICE_VERSION,PREVIOUS_AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,INTEGRITY_SITES,integrityScopeMeasurement,integrityRoundPoints,automaticTaskTariff,automaticPriceFromPlannedCost,FULL_REVIEW_PLANNED_COST_CNY,emptyUpdateDetails,reportingWindow} from '@bondbuddy/contracts';
import {resolveAutomaticTaskPrice} from './automatic-pricing.js';

test('all twelve tariff rows preserve separate base-fen and 1.7 rounding',()=>{
  assert.equal(Object.keys(AUTOMATIC_TASK_TARIFF).length,12);
  for(const [sku,row]of Object.entries(AUTOMATIC_TASK_TARIFF))if(row.base_fen!==null)assert.equal(row.points,Math.ceil(row.base_fen*17/10),sku);
  assert.equal(AUTOMATIC_TASK_TARIFF.integrity.base_fen,null,'commercial scope prices do not fabricate a C_plan-derived base');
});
test('comprehensive review uses its planning cost, with exact two-stage rounding',()=>{
  assert.deepEqual(automaticPriceFromPlannedCost(FULL_REVIEW_PLANNED_COST_CNY),{base_fen:15997,points:27195});
  // A single rounding would undercharge this boundary by one point.
  assert.deepEqual(automaticPriceFromPlannedCost('0.0001'),{base_fen:1,points:2});
  for(const value of ['-1','0','NaN','Infinity','1e8','9007199254740991'])assert.throws(()=>automaticPriceFromPlannedCost(value),RangeError);
  const current=resolveAutomaticTaskPrice('review',{task:'full_review'});
  assert.equal(current.points,27195);assert.equal(current.sku,'full_review');assert.equal(current.lines[0].label,'独立全面复核');
  const legacy=resolveAutomaticTaskPrice('review',{task:'full_review'},LEGACY_AUTOMATIC_PRICE_VERSION);
  assert.equal(legacy.points,14900);assert.equal(legacy.version,LEGACY_AUTOMATIC_PRICE_VERSION);
  assert.equal(automaticTaskTariff(LEGACY_AUTOMATIC_PRICE_VERSION).full_review.base_fen,null);
  for(const task of ['differential_review','review_revision'])assert.equal(resolveAutomaticTaskPrice('review',{task}).points,14900);
  assert.throws(()=>resolveAutomaticTaskPrice('review',{task:'unknown'}),/请选择/);
  assert.throws(()=>resolveAutomaticTaskPrice('review',{}),/请选择/);
});
test('independent question list charges one unit each; malformed or oversized lists are rejected',()=>{
  const price=resolveAutomaticTaskPrice('project_qa_answer',{questions:[{id:'q0',question:'第一题'},{id:'q1',question:'第二题'}]});
  assert.equal(price.points,2436);assert.equal(price.lines.length,2);assert.equal(price.version,AUTOMATIC_PRICE_VERSION);
  assert.throws(()=>resolveAutomaticTaskPrice('project_qa_answer',{questions:[{id:'q',question:'a'},{id:'q',question:'b'}]}),/无效/);
  assert.throws(()=>resolveAutomaticTaskPrice('project_qa_answer',{questions:[]}),/独立问题/);
});
test('historical integrity website selections retain their accepted fixed round tariff',()=>{
  const sites=INTEGRITY_SITES.map(site=>site.id);
  assert.ok(sites.length>20,'immutable historical scopes still exercise the former pricing boundary');
  for(const version of [PREVIOUS_AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION]){
    const expected=automaticTaskTariff(version).integrity.points;
    for(const count of [1,20,21,sites.length]){
      const draft={subjects:[{id:'issuer'}],site_ids:sites.slice(0,count)},before=structuredClone(draft);
      const price=resolveAutomaticTaskPrice('integrity_round',{draft},version);
      assert.equal(price.points,expected);assert.equal(price.lines.length,1);
      assert.equal(price.lines[0].quantity,1);assert.equal(price.lines[0].amount_fen,expected);
      assert.deepEqual(draft,before,'pricing must not trim or split the selected websites');
    }
  }
});

const integritySubject=(id:string,kind:'company'|'person'='company')=>({id,kind,name:'合成主体'+id,identifier:'',role:'',province:'山东',city:'东营'});
test('v4 integrity bills executable subject/section pairs with an explicit round ceiling',()=>{
 const sites=INTEGRITY_SITES.map(site=>site.id);
 for(const count of [1,20,49])for(const subjects of [1,5]){
  const draft={subjects:Array.from({length:subjects},(_,i)=>integritySubject(String(i))),site_ids:sites.slice(0,count),notes:''},before=structuredClone(draft);
  const price=resolveAutomaticTaskPrice('integrity_round',{draft});
  assert.equal(price.points,integrityRoundPoints(integrityScopeMeasurement(draft).executable_pairs));
  assert.equal(price.lines.reduce((n,line)=>n+line.quantity*line.unit_price_fen,0),price.points);
  assert.deepEqual(draft,before);
 }
 assert.equal(resolveAutomaticTaskPrice('integrity_round',{draft:{subjects:[integritySubject('one')],site_ids:['tax'],notes:''}}).points,2085);
 assert.equal(resolveAutomaticTaskPrice('integrity_round',{draft:{subjects:Array.from({length:5},(_,i)=>integritySubject(String(i))),site_ids:sites,notes:''}}).points,22738);
 const mixed={subjects:[{...integritySubject('one'),province:'',city:''},integritySubject('two','person')],site_ids:['gsxt','tax','local-csrc'],notes:''};
 assert.equal(resolveAutomaticTaskPrice('integrity_round',{draft:mixed}).points,2255,'three executable pairs; person company-only and unresolved locality excluded');
 assert.throws(()=>resolveAutomaticTaskPrice('integrity_round',{draft:{subjects:[integritySubject('one','person')],site_ids:['gsxt'],notes:''}}),{code:'SCOPE_UNSUPPORTED'});
});

test('integrity still requires a nonempty distinct scope and at most five subjects',()=>{
  const draft={subjects:Array.from({length:5},(_,i)=>integritySubject('s'+i)),site_ids:INTEGRITY_SITES.map(site=>site.id)};
  assert.equal(resolveAutomaticTaskPrice('integrity_round',{draft}).points,AUTOMATIC_TASK_TARIFF.integrity.points);
  assert.throws(()=>resolveAutomaticTaskPrice('integrity_round',{draft:{...draft,subjects:[...draft.subjects,{id:'s5'}]}}),/1至5/);
  for(const invalid of [{...draft,subjects:[]},{...draft,site_ids:[]},{...draft,site_ids:null},null]){
    assert.throws(()=>resolveAutomaticTaskPrice('integrity_round',{draft:invalid}),{code:'SCOPE_UNSUPPORTED'});
  }
  for(const invalid of [{...draft,subjects:[{id:'same'},{id:'same'}]},{...draft,site_ids:[draft.site_ids[0],draft.site_ids[0]]}]){
    assert.throws(()=>resolveAutomaticTaskPrice('integrity_round',{draft:invalid}),/重复/);
  }
});

test('v4 requotes price the validated immutable query pairs instead of rederiving the current catalogue',()=>{
 const draft={subjects:[{...integritySubject('locked'),province:'',city:''}],site_ids:['tax','local-csrc'],notes:''};
 assert.equal(integrityScopeMeasurement(draft).executable_pairs,1);
 const scope_measurement=integrityScopeMeasurement({...draft,subjects:[{...draft.subjects[0],province:'山东',city:'东营'}]});
 scope_measurement.executable_query_pairs[1].urls=['https://locked.example/previous-section/'];
 const snapshot={draft,round_id:'same-accepted-round',scope_measurement},before=structuredClone(snapshot);
 assert.equal(resolveAutomaticTaskPrice('integrity_round',snapshot).points,2170);
 assert.deepEqual(snapshot,before,'requotes retain the accepted URLs and query identities');
 for(const invalid of [null,{...scope_measurement,executable_pairs:1},{...scope_measurement,executable_query_pairs:[]}])assert.throws(()=>resolveAutomaticTaskPrice('integrity_round',{...snapshot,scope_measurement:invalid}),{code:'SCOPE_UNSUPPORTED'});
});
test('one-question chat cannot accept an explicit multi-question list at one-unit price',()=>{
  assert.equal(resolveAutomaticTaskPrice('m4_qa',{content:'请说明本期收入增长的主要原因。'}).points,1218);
  assert.throws(()=>resolveAutomaticTaskPrice('m4_qa',{content:'1. 说明收入增长\n2. 核对抵押资产'}),/逐题回复/);
  assert.throws(()=>resolveAutomaticTaskPrice('m4_qa',{content:'收入为何增长？负债为何下降？'}),/逐题回复/);
});

test('one question includes its calculation process and numbered verification steps',()=>{
  for(const content of ['请计算资产负债率，并说明计算过程。','请计算资产负债率，步骤如下：\n1. 核对负债总额\n2. 核对资产总额','请计算资产负债率，并列出依据。']){
    const price=resolveAutomaticTaskPrice('m4_qa',{content});
    assert.equal(price.points,AUTOMATIC_TASK_TARIFF.response.points);assert.equal(price.lines.length,1);
  }
});

test('clear independent questions without question marks use the owned question list',()=>{
  for(const content of ['资产负债率是多少；流动比率是多少','资产负债率是多少\n流动比率是多少','资产负债率是多少？流动比率是多少？','1. 资产负债率是多少\n2. 流动比率是多少','请计算资产负债率，步骤如下：\n1. 核对负债总额\n2. 流动比率是多少'])assert.throws(()=>resolveAutomaticTaskPrice('m4_qa',{content}),{code:'SCOPE_UNSUPPORTED'});
  const price=resolveAutomaticTaskPrice('project_qa_answer',{questions:[{id:'ratio-1',question:'资产负债率是多少'},{id:'ratio-2',question:'流动比率是多少'}]});
  assert.equal(price.points,2*AUTOMATIC_TASK_TARIFF.response.points);assert.deepEqual(price.lines.map(line=>line.key),['ratio-1','ratio-2']);
});
test('new check includes repair; older checks retain their original upgrade rights',()=>{
  const manifest={file_version_id:'f'};
  assert.equal(resolveAutomaticTaskPrice('project_file_patch',{manifest,paid_check:{quote_id:'paid',price_version:AUTOMATIC_PRICE_VERSION}}).points,0);
  assert.equal(resolveAutomaticTaskPrice('project_file_patch',{manifest,paid_check:{quote_id:'paid-v2',price_version:LEGACY_AUTOMATIC_PRICE_VERSION}}).points,0);
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
