import assert from 'node:assert/strict';
import test from 'node:test';
import {digest} from '@bondbuddy/api/data';
import {fileAuthoringDeliveryStage,type FileAuthoringResult} from './file-authoring-stage.js';
import type {WordQualityReport} from './file-authoring-quality.js';
import type {UnifiedInput} from './unified-input.js';
import type {StageContext} from './run-pipeline.js';

const passed:WordQualityReport={version:'word-quality-v1',status:'passed',issues:[],metrics:{},limitations:['semantic_review_not_performed']};
const load=async()=>({manifest:{authoring:{source_prospectuses:[]}},materials:[],requirements:[]} as unknown as UnifiedInput);
function fixture(){
  const bytes=Buffer.from('synthetic file bytes; OOXML checked in Python integration tests');
  const prefix='owners/owner/projects/project/runs/run/file-authoring/call/';
  const objects=new Map<string,Buffer>();
  const file=(name:string)=>{objects.set(prefix+name,bytes);return {key:prefix+name,sha256:digest(bytes),byte_size:bytes.length};};
  const result:FileAuthoringResult={version:'codex-file-word-v1',input_hash:'a'.repeat(64),
    files:{'tracked.docx':file('tracked.docx'),'clean.docx':file('clean.docx')},summary:{}};
  const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_hash:'a'.repeat(64)},
    values:new Map([['model_generation',result]]),signal:new AbortController().signal,
    blobs:{getIfExistsBounded:async(key:string)=>objects.get(key)??null,put:async(key:string,value:Buffer)=>{objects.set(key,value);}}} as unknown as StageContext;
  return {result,ctx,bytes,objects};
}
test('a prior quality rejection cannot become a successful download, including delivery-only recovery',async()=>{
  const {result,ctx}=fixture();
  result.error='WORD_QUALITY_REJECTED';result.summary.validation_error='WORD_REVISION_MISMATCH';
  let calls=0;
  for(const recovery of [false,true]){
    ctx.lease={checkpoint:recovery?{word_pair_delivery_recovery:{attempt_no:1}}:{}} as StageContext['lease'];
    assert.deepEqual(await fileAuthoringDeliveryStage({load,quality:async()=>{calls++;return passed;}}).run(ctx),{kind:'fail',code:'WORD_QUALITY_REJECTED'});
  }
  assert.equal(calls,0);
});
test('a pair is delivered only after a host quality pass and durable report readback',async()=>{
  const {ctx,objects}=fixture();let calls=0;
  const outcome=await fileAuthoringDeliveryStage({load,quality:async()=>{calls++;return passed;}}).run(ctx);
  assert.equal(outcome.kind,'deliver');if(outcome.kind!=='deliver')throw Error('expected delivery');
  const gate=outcome.wordSummary!.quality_gate as {status:string;report:{key:string;sha256:string}};
  assert.equal(gate.status,'passed');assert.equal(digest(objects.get(gate.report.key)!),gate.report.sha256);
  assert.equal(outcome.wordSummary!.content_review,'not_performed');assert.equal(calls,1);
});
test('failed quality is preserved with its hash and checkpoint instead of delivering the candidate',async()=>{
  const {ctx,objects}=fixture();
  const outcome=await fileAuthoringDeliveryStage({load,quality:async()=>({...passed,status:'failed',issues:['WORD_SOURCE_CONTENT_LOSS']})}).run(ctx);
  assert.equal(outcome.kind,'fail');if(outcome.kind!=='fail')throw Error('expected rejection');
  assert.equal(outcome.code,'WORD_QUALITY_REJECTED');
  const gate=outcome.checkpoint!.quality_gate as {status:string;report:{key:string;sha256:string}};
  const report=objects.get(gate.report.key)!;
  assert.equal(gate.status,'failed');assert.equal(digest(report),gate.report.sha256);assert.match(report.toString(),/WORD_SOURCE_CONTENT_LOSS/);
});
test('quality process outages and missing report readback never produce a successful download',async()=>{
  const {ctx}=fixture();
  await assert.rejects(fileAuthoringDeliveryStage({load,quality:async()=>{throw Error('SYNTHETIC_PYTHON_UNAVAILABLE');}}).run(ctx),/SYNTHETIC_PYTHON_UNAVAILABLE/);
  ctx.blobs.put=async()=>{};
  await assert.rejects(fileAuthoringDeliveryStage({load,quality:async()=>passed}).run(ctx),/AUTHORING_OUTPUT_STORE_FAILED/);
});
test('legacy replay checks the locked source bytes, ignoring the model baseline',async()=>{
  const {ctx,result,objects}=fixture(),original=Buffer.from('pinned original');
  const pin={material_id:'source',material_version:1,sha256:digest(original),role:'historical'};
  objects.set('original',original);result.files['baseline.docx']={...result.files['tracked.docx']!};let calls=0;
  const input={manifest:{authoring:{source_prospectuses:[]}},materials:[{pin,mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:'original'}]} as unknown as UnifiedInput;
  const outcome=await fileAuthoringDeliveryStage({load:async()=>input,quality:async input=>{
    calls++;assert.deepEqual(input.baseline,original);assert.equal(input.data.baseline_kind,'uploaded_source');return passed;
  }}).run(ctx);
  assert.equal(outcome.kind,'deliver');assert.equal(calls,1);
});
test('legacy PDF replay passes the pinned original PDF to independent retention checks',async()=>{
  const {ctx,result,objects}=fixture(),original=Buffer.from('synthetic pinned original PDF');
  const pin={material_id:'source',material_version:1,sha256:digest(original),role:'historical'};
  objects.set('original',original);result.files['baseline.docx']={...result.files['tracked.docx']!};
  const input={manifest:{authoring:{source_prospectuses:[]}},materials:[{pin,mediaType:'application/pdf',objectKey:'original'}]} as unknown as UnifiedInput;
  const outcome=await fileAuthoringDeliveryStage({load:async()=>input,quality:async input=>{
    assert.deepEqual(input.originalPdf,original);assert.equal(input.data.baseline_kind,'reconstructed_pdf');return passed;
  }}).run(ctx);
  assert.equal(outcome.kind,'deliver');
});
test('a missing pair or foreign file reference still cannot be delivered',async()=>{
  for(const mutation of ['missing','foreign'] as const){
    const {ctx,result}=fixture();
    if(mutation==='missing')delete result.files['clean.docx'];
    else result.files['clean.docx']!.key='owners/other/projects/project/runs/run/file-authoring/call/clean.docx';
    assert.equal((await fileAuthoringDeliveryStage().run(ctx)).kind,'fail');
  }
});
test('missing or changed stored bytes are never a successful download',async()=>{
  for(const stored of [null,Buffer.from('changed')]){
    const {ctx}=fixture();ctx.blobs.getIfExistsBounded=async()=>stored;
    await assert.rejects(fileAuthoringDeliveryStage().run(ctx),/WORD_OUTPUT_BLOB_MISMATCH/);
  }
});
