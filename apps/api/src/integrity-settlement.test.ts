import test from 'node:test';
import assert from 'node:assert/strict';
import {INTEGRITY_COMMERCIAL_RULE,integrityScopeMeasurement,type IntegrityInput} from '@bondbuddy/contracts';
import {integritySettlement} from './integrity-settlement.js';

function row(){
 const draft={subjects:[{id:'issuer',kind:'company' as const,name:'合成发行人',identifier:'',role:'发行人',province:'',city:''}],site_ids:['pbc','nfra','csrc','sse','szse'],notes:''};
 const manifest:IntegrityInput={version:'integrity-round-v1',operation:'check',round_id:'run',project_name:'合成项目',draft,price_version:INTEGRITY_COMMERCIAL_RULE.version,points:2425,records:[],evidence_ids:[],scope_measurement:integrityScopeMeasurement(draft)};
 return {operation:'check',state:'succeeded',manifest,reservation_state:'settled',points:'2425',charged_points:'2170',released_points:'255',result:{measurement:{verified_successful_pairs:2,verified_query_pairs:['["issuer","pbc"]','["issuer","nfra"]']}}};
}
test('settlement projects exact accepted/charged/released points and saved query pairs without mutating facts',()=>{
 const input=row(),before=structuredClone(input),result=integritySettlement(input);
 assert.deepEqual(result,{version:'integrity-settlement-v1',outcome:'delivered',quoted_points:2425,charged_points:2170,released_points:255,verified_query_pairs:[{subject_id:'issuer',site_id:'pbc'},{subject_id:'issuer',site_id:'nfra'}]});assert.deepEqual(input,before);
});
test('all successful pairs and zero release remain explicit',()=>{
 const input=row();input.result.measurement.verified_query_pairs=input.manifest.draft.site_ids.map(site=>JSON.stringify(['issuer',site]));input.result.measurement.verified_successful_pairs=5;input.charged_points='2425';input.released_points='0';
 assert.equal(integritySettlement(input)?.verified_query_pairs.length,5);assert.equal(integritySettlement(input)?.released_points,0);
});
test('undelivered terminal tasks explain actual full release without inventing successful queries',()=>{
 for(const state of ['failed','cancelled','rejected']){const input={...row(),state,reservation_state:'released',charged_points:'0',released_points:'2425',result:undefined};assert.equal(integritySettlement(input)?.outcome,'not_delivered');assert.deepEqual(integritySettlement(input)?.verified_query_pairs,[]);}
});
test('missing, duplicate, malformed and out-of-scope durable pairs never become confirmed fee explanations',()=>{
 for(const pairs of [[],['broken'],['["issuer","pbc"]','["issuer","pbc"]'],['["other","pbc"]'],['["issuer","retired"]'],['["issuer","pbc"]','[ "issuer", "pbc" ]']]){const input=row();input.result.measurement.verified_query_pairs=pairs;input.result.measurement.verified_successful_pairs=pairs.length;assert.equal(integritySettlement(input),null);}
 const missing=row();delete (missing.result as Partial<typeof missing.result>).measurement;assert.equal(integritySettlement(missing),null);
 const mismatch=row();mismatch.result.measurement.verified_successful_pairs=3;assert.equal(integritySettlement(mismatch),null);
});
test('unsettled, legacy, exported and contradictory ledger snapshots do not receive a v4 settlement',()=>{
 for(const patch of [{reservation_state:'held'},{state:'running'},{operation:'export'},{charged_points:'2171'},{released_points:'-1'},{points:'2426'},{released_points:undefined},{charged_points:'9007199254740993'}])assert.equal(integritySettlement({...row(),...patch}),null);
 const old=row();old.manifest.price_version='integrity-round-5000-v1';assert.equal(integritySettlement(old),null);
});
