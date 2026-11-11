import test from 'node:test';
import assert from 'node:assert/strict';
import {integrityPricingScope,integrityInputSite,integrityScopeMeasurement,integrityRoundPoints,integrityHasSuccessfulQuery,integritySearchQueries,integrityObservedTimeValid} from './integrity-billing.js';
import type {IntegrityDraft,IntegrityRecord,IntegrityInput} from './integrity.js';
const draft:IntegrityDraft={subjects:[{id:'company',kind:'company',name:'合成企业',identifier:'',role:'',province:'',city:''},{id:'person',kind:'person',name:'合成人员',identifier:'',role:'',province:'',city:''}],site_ids:['gsxt','tax','local-csrc'],notes:''};
test('scope units distinguish applicable, excluded and unresolved pairs without inventing costs',()=>{
 const {executable_query_pairs,...counts}=integrityScopeMeasurement(draft);
 assert.deepEqual(counts,{version:'integrity-scope-measurement-v1',subjects:2,selected_sites:3,selected_pairs:6,applicable_pairs:4,executable_pairs:3,excluded_pairs:2,unresolved_pairs:1});assert.equal(executable_query_pairs.length,3);
 assert.deepEqual(integrityPricingScope(draft),{draft});
 assert.notDeepEqual(integrityPricingScope(draft,'new-round'),integrityPricingScope(draft,'previous-round'));
 assert.deepEqual(integrityScopeMeasurement({...draft,subjects:[...draft.subjects,...draft.subjects],site_ids:[...draft.site_ids,...draft.site_ids]}),integrityScopeMeasurement(draft),'repeated identities cannot inflate query units');
});
test('accepted website URLs and applicability come from the locked input instead of the current catalogue',()=>{
 const scope=integrityScopeMeasurement(draft);scope.executable_query_pairs[0].urls=['https://locked.example/previous-section/'];
 const input={draft,scope_measurement:scope} as IntegrityInput;
 assert.deepEqual(integrityInputSite(input,'gsxt',draft.subjects[0]).links.map(link=>link.url),['https://locked.example/previous-section/']);
 assert.equal(integrityInputSite(input,'local-csrc',draft.subjects[0]).links.length,0);
 assert.equal(integrityInputSite(input,'gsxt',draft.subjects[1]).companyOnly,true);
});
test('commercial points charge zero for no success and never exceed the round ceiling',()=>{
 assert.equal(integrityRoundPoints(0),0);assert.equal(integrityRoundPoints(1),2085);assert.equal(integrityRoundPoints(49),6165);assert.equal(integrityRoundPoints(245),22738);
 for(const count of [-1,0.5,NaN,Infinity])assert.throws(()=>integrityRoundPoints(count),RangeError);
});
const record:IntegrityRecord={subject_id:'company',site_id:'tax',site_name:'税务',urls:[],query:'合成企业',status:'no_public_results',reason:'官网明确无结果',checked_at:'2026-11-11T00:00:00Z',sources:[],search_performed:true,
 browser:{version:'official-browser-v1',outcome:'no_results',scope:'测试',limitation:'仅本次查询',captures:[{id:'capture',kind:'result',url:'https://www.chinatax.gov.cn/',title:'结果',captured_at:'2026-11-11T00:00:00Z',page:1,screenshot_sha256:'a'.repeat(64),text_sha256:'b'.repeat(64),byte_size:68}],diagnostic:{code:'no_results',phase:'results'}}};
test('verified zero result is successful; blocked, failed, unverified and screenshotless requests are not',()=>{
 assert.equal(integrityHasSuccessfulQuery([record]),true);
 for(const outcome of ['blocked','failed','unverified'] as const)assert.equal(integrityHasSuccessfulQuery([{...record,browser:{...record.browser!,outcome}}]),false);
 assert.equal(integrityHasSuccessfulQuery([{...record,browser:{...record.browser!,captures:[]}}]),false);
 assert.equal(integrityHasSuccessfulQuery([{...record,search_performed:false}]),false);
 for(const invalid of [{...record,search_performed:'true'},{...record,browser:null},{...record,browser:{...record.browser!,diagnostic:null}}])assert.equal(integrityHasSuccessfulQuery([invalid as unknown as IntegrityRecord]),false);
});

test('journal observation times require complete UTC ISO timestamps and real calendar dates',()=>{
 for(const time of ['0001-01-01T00:00:00Z','2000-02-29T23:59:59.123456Z','2024-02-29T00:00:00.1Z','2026-11-11T00:00:00.000Z','9999-12-31T23:59:59Z'])assert.equal(integrityObservedTimeValid(time),true,time);
 for(const time of [null,'','0000-01-01T00:00:00Z','1900-02-29T00:00:00Z','2026-02-31T00:00:00Z','2026-13-01T00:00:00Z','2026-00-01T00:00:00Z','2026-01-00T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:60:00Z','2026-01-01T00:00:60Z','2026-11-11 00:00:00Z','2026-11-11','2026-11-11T00:00:00+00:00','2026-11-11T00:00:00.1234567Z','2026-11-11T00:00:00Z\n'])assert.equal(integrityObservedTimeValid(time),false,String(time));
});
test('historical search actions support empty results but reject queued, failed or fabricated events',()=>{
 const event={observed_at:'2026-11-11T00:00:00Z',item:{type:'web_search',id:'actual',action:{type:'search',query:'合成企业 site:www.chinatax.gov.cn'},results:[]}};
 assert.deepEqual(integritySearchQueries([event]),[event.item.action.query]);
 for(const status of ['in_progress','failed','queued','cancelled'])assert.deepEqual(integritySearchQueries([{...event,item:{...event.item,status}}]),[]);
 assert.deepEqual(integritySearchQueries([{...event,item:{...event.item,type:'message'}}]),[]);
 for(const invalid of [{...event,item:{...event.item,id:''}},{...event,item:{...event.item,status:null}},{...event,item:{...event.item,action:{...event.item.action,type:null}}},{...event,observed_at:'2026-02-31T00:00:00Z'},{...event,observed_at:'2026-11-11 00:00:00Z'}])assert.deepEqual(integritySearchQueries([invalid]),[]);
 assert.deepEqual(integritySearchQueries([{...event,item:{...event.item,status:'completed',action:{query:event.item.action.query}}}]),[event.item.action.query],'missing optional provider type/status remains historically valid');
});
