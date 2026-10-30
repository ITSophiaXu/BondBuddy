import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_QA_PRICE,INTEGRITY_PRICE,PROJECT_FILE_UPDATE_PRICE,OUTCOME_PRICE_VERSION,WORKPAPER_PRICE,
  BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION} from '@bondbuddy/contracts';
import {billingRecoverySchemas,billingRecoveryHeaders} from './billing-recovery-wire.js';
import {schemas} from './billing-types.js';
const sha='a'.repeat(64);
const requests={
  QaAnswerRequest:{request_id:'old-qa',expected_revision:7,expected_points:60,price_version:PROJECT_QA_PRICE.version},
  IntegrityRunRequest:{request_id:'old-integrity',expected_revision:4,expected_points:5000,price_version:INTEGRITY_PRICE.version},
  ProjectFileBatchRequest:{request_id:'old-batch',source_version_id:'source',expected_selection_revision:7,expected_points:5000,price_version:OUTCOME_PRICE_VERSION,documents:[{document_type:'issuer',draft_version:2,scope_quote_id:'original-quote'}]},
  ProjectFileCheckRequest:{request_id:'old-check',expected_source_version_id:'source',expected_points:5000,price_version:OUTCOME_PRICE_VERSION,file_version_ids:['file-v3'],scope_quote_id:'original-quote'},
  ProjectFileUpdateRequest:{request_id:'old-update',expected_check_sha256:sha,expected_points:4500,price_version:PROJECT_FILE_UPDATE_PRICE.version,files:[{file_version_id:'file-v3'}]},
  WorkpaperStart:{start_mode:'direct',request_id:'old-workpaper',catalogue_id:'catalogue',catalogue_sha256:sha,item_ids:['item'],source_version_id:'source',source_selection_revision:3,requirements:'原范围',price_version:WORKPAPER_PRICE.version,expected_points:5000},
};
for(const name of Object.keys(requests) as (keyof typeof requests)[])test(name+' preserves numeric recovery while keeping the current wire strict',()=>{
  const legacy=requests[name],raw=JSON.stringify(legacy),current={...legacy,expected_points:String(legacy.expected_points)};
  assert.equal(Value.Check(billingRecoverySchemas[name],legacy),true);
  assert.deepEqual(billingRecoveryHeaders(name,legacy),{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION});
  assert.equal(JSON.stringify(legacy),raw);assert.equal(Value.Check(billingRecoverySchemas[name],current),true);assert.deepEqual(billingRecoveryHeaders(name,current),{});
  if(name!=='WorkpaperStart')assert.equal(Value.Check(schemas[name],legacy),false);
  for(const amount of [Number.MAX_SAFE_INTEGER+1,-1,0.5,NaN,Infinity,'05000','5e3',null]){
    assert.equal(Value.Check(billingRecoverySchemas[name],{...legacy,expected_points:amount}),false,String(amount));
    assert.throws(()=>billingRecoveryHeaders(name,{...legacy,expected_points:amount}));
  }
  assert.equal(Value.Check(billingRecoverySchemas[name],{...legacy,unexpected:true}),false);
});
test('numeric recovery preserves the original bounded request limits',()=>{
  assert.equal(Value.Check(billingRecoverySchemas.ProjectFileCheckRequest,{...requests.ProjectFileCheckRequest,expected_points:100000001}),false);
  assert.equal(Value.Check(billingRecoverySchemas.ProjectFileCheckRequest,{...requests.ProjectFileCheckRequest,expected_points:'9007199254740993'}),true);
});
