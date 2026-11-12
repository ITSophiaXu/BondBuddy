import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_EVIDENCE_SQL,readModelEvidence,validateModelEvidence} from './model-quality-evidence.mjs';

const options={ownerId:'owner',runIds:['answer'],preparationId:'prepare',workpaperBatchId:'batch'};
function fixture(){
 const runs=['answer','prepare','item-old','item-new'].map(id=>({id,owner_user_id:'owner',project_id:'project',state:'succeeded',qa_operation:id==='prepare'?'prepare':id==='answer'?'answer':null,preparation_id:id==='answer'?'prepare':null}));
 const jobs=runs.map(r=>({id:'job-'+r.id,owner_user_id:'owner',run_id:r.id}));
 const attempts=runs.map((r,i)=>({id:'attempt-'+r.id,owner_user_id:'owner',job_id:'job-'+r.id,run_id:r.id,logical_call_id:'call',attempt_no:i+1,call_status:'completed',model_id:'actual-model',usage_present:true,usage_status:'measured',input_tokens:'10',output_tokens:'5',cached_input_tokens:null,reasoning_tokens:'0',conflicting_measurements:0,runtime_id:'runtime-'+r.id,runtime_run_id:r.id,runtime_job_id:'job-'+r.id,model_provider:'copilot',adapter:'codex_exec',model_config_version:'config',duration_ms:25,started_at:'2026-11-12T00:00:00Z'}));
 return {owner_id:'owner',captured_at:'2026-11-12T01:00:00Z',transaction_read_only:'on',transaction_isolation:'repeatable read',scope_run_ids:runs.map(r=>r.id),runs,jobs,attempts,workpaper_batch:{id:'batch',owner_user_id:'owner'},workpaper_attempts:[{run_id:'item-old',item_id:'item',attempt:1},{run_id:'item-new',item_id:'item',attempt:2}]};
}
test('model evidence includes QA preparation and all workpaper retry runs',async()=>{
 let request;const result=await readModelEvidence({...options,execReadOnly:async value=>{request=value;return {rows:[{evidence:fixture()}]};}});
 assert.equal(request.text,MODEL_EVIDENCE_SQL);assert.deepEqual(request.values,['owner',['answer'],'batch','prepare']);assert.deepEqual(request.transaction,{isolation:'repeatable read',readOnly:true});
 assert.equal(result.attempts.length,4);assert.equal(result.preparation.attempts,1);assert.equal(result.execution.attempts,3);assert.equal(result.summary.inputTokens.total,'40');assert.equal(result.summary.durationMs.total,100);assert.equal(result.attempts[0].provider,'copilot');assert.equal(result.attempts[0].model,'actual-model');
 assert.match(MODEL_EVIDENCE_SQL,/FROM bb_workpaper_attempts/);assert.match(MODEL_EVIDENCE_SQL,/LEFT JOIN bb_call_usage /);assert.match(MODEL_EVIDENCE_SQL,/LEFT JOIN bb_model_call_attempt_runtime/);assert.doesNotMatch(MODEL_EVIDENCE_SQL,/\b(UPDATE|DELETE|INSERT|CREATE|ALTER)\b/i);
});
test('unknown, pending, conflict and absent runtime remain null instead of zero',()=>{
 for(const status of ['unknown','pending','conflict']){const db=fixture(),a=db.attempts[0];Object.assign(a,{usage_status:status,input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,runtime_id:null,duration_ms:null,model_provider:null});const result=validateModelEvidence(db,options);assert.equal(result.attempts[0].usage.inputTokens,null);assert.equal(result.attempts[0].durationMs,null);assert.equal(result.attempts[0].provider,null);assert.equal(result.summary.inputTokens.known,'30');assert.equal(result.summary.inputTokens.total,null);assert.equal(result.summary.durationMs.total,null);assert.deepEqual(result.missingRuntime,[a.id]);}
 const db=fixture();Object.assign(db.attempts[0],{usage_present:false,usage_status:null,input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null});assert.equal(validateModelEvidence(db,options).attempts[0].usage.status,'unknown');
});
test('known zero is retained and nullable optional token dimensions do not contaminate totals',()=>{
 const db=fixture();Object.assign(db.attempts[0],{input_tokens:'0',duration_ms:0});const result=validateModelEvidence(db,options);assert.equal(result.attempts[0].usage.inputTokens,'0');assert.equal(result.attempts[0].durationMs,0);assert.equal(result.summary.inputTokens.total,'30');assert.equal(result.summary.cachedInputTokens.total,null);assert.equal(result.summary.reasoningTokens.total,'0');
});
test('decimal counters retain precision beyond the JS safe integer range',()=>{
 const db=fixture();db.attempts[0].input_tokens='9007199254740993';const result=validateModelEvidence(db,options);assert.equal(result.summary.inputTokens.total,'9007199254741023');
});
test('raw original measurements are retained and cannot be filled for unknown usage',()=>{
 const db=fixture();const result=validateModelEvidence(db,options);assert.equal(result.raw,db);db.attempts[0].usage_status='unknown';assert.throws(()=>validateModelEvidence(db,options),/remain unknown/);db.attempts[0].usage_status='measured';db.attempts[0].input_tokens=10;assert.throws(()=>validateModelEvidence(db,options),/decimal precision/);
});
test('scope, owner, preparation identity, duplicate and runtime binding mismatches fail',()=>{
 for(const mutate of [db=>db.owner_id='other',db=>db.transaction_read_only='off',db=>db.transaction_isolation='read committed',db=>db.runs.pop(),db=>db.jobs.pop(),db=>db.attempts.push(db.attempts[0]),db=>db.attempts[0].owner_user_id='other',db=>db.attempts[0].runtime_run_id='prepare',db=>db.attempts[0].runtime_job_id='other',db=>db.runs.find(r=>r.id==='prepare').qa_operation='answer',db=>db.workpaper_batch.id='other',db=>db.workpaper_attempts.pop()]){const db=fixture();mutate(db);assert.throws(()=>validateModelEvidence(db,options));}
});
test('an automatically discovered QA preparation is still included without explicit preparationId',()=>{
 const result=validateModelEvidence(fixture(),{...options,preparationId:null});assert.equal(result.preparation.attempts,1);
});
test('empty scope and duplicate requested run IDs are refused before any query',async()=>{
 let calls=0;const execReadOnly=async()=>{calls++;};await assert.rejects(()=>readModelEvidence({execReadOnly,ownerId:'owner'}));await assert.rejects(()=>readModelEvidence({execReadOnly,ownerId:'owner',runIds:['r','r']}));assert.equal(calls,0);
});
