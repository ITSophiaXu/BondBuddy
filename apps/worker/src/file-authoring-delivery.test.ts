import assert from 'node:assert/strict';
import test from 'node:test';
import {digest} from '@bondbuddy/api/data';
import {fileAuthoringDeliveryStage,type FileAuthoringResult} from './file-authoring-stage.js';
import type {StageContext} from './run-pipeline.js';

function fixture(){
  const bytes=Buffer.from('PK\x03\x04synthetic bounded candidate');
  const prefix='owners/owner/projects/project/runs/run/file-authoring/call/';
  const file=(name:string)=>({key:prefix+name,sha256:digest(bytes),byte_size:bytes.length});
  const result:FileAuthoringResult={version:'codex-file-word-v1',input_hash:'a'.repeat(64),
    files:{'tracked.docx':file('tracked.docx'),'clean.docx':file('clean.docx')},
    error:'WORD_QUALITY_REJECTED',summary:{validation_error:'WORD_REVISION_MISMATCH'}};
  const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_hash:'a'.repeat(64)},
    values:new Map([['model_generation',result]]),blobs:{getIfExistsBounded:async()=>bytes}} as unknown as StageContext;
  return {result,ctx,bytes};
}
test('previous consistency rejection is advisory: both files delivered without baseline or summary file',async()=>{
  const {result,ctx}=fixture();
  const outcome=await fileAuthoringDeliveryStage().run(ctx);
  assert.equal(outcome.kind,'deliver');
  if(outcome.kind!=='deliver')throw Error('expected delivery');
  assert.equal(outcome.deliveryPolicy,'generated_pair_v1');
  assert.equal(outcome.baselineBytes,undefined);
  assert.equal(outcome.wordSummary?.content_review,'not_performed');
  assert.equal(outcome.wordSummary?.replacements,null);
  assert.equal(result.error,'WORD_QUALITY_REJECTED');
});
test('a missing pair or foreign file reference still cannot be delivered',async()=>{
  for(const mutation of ['missing','foreign'] as const){
    const {ctx,result}=fixture();
    if(mutation==='missing')delete result.files['clean.docx'];
    else result.files['clean.docx']!.key='owners/other/projects/project/runs/run/file-authoring/call/clean.docx';
    assert.deepEqual(await fileAuthoringDeliveryStage().run(ctx),{kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'});
  }
});
test('missing or changed stored bytes are never a successful download',async()=>{
  for(const stored of [null,Buffer.from('changed')]){
    const {ctx}=fixture();ctx.blobs.getIfExistsBounded=async()=>stored;
    await assert.rejects(fileAuthoringDeliveryStage().run(ctx),/WORD_OUTPUT_BLOB_MISMATCH/);
  }
});
