import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainQaPreparation,qaPreparationResponse,qaPreparationURL} from './qa-preparation.mjs';

const expected={filename:'原始七题.docx',sha256:'a'.repeat(64)};
const source={kind:'material',pin:{source_project_id:'qa-project',material_id:'questions',material_version:1,sha256:expected.sha256}};
const request={request_id:'prepare-request',source};
const ack=(status=200,body={run_id:'prepare-run'})=>({request:()=>({method:()=> 'POST',url:()=> 'http://localhost:5288/api/v1/projects/qa-project/qa/prepare',postDataJSON:()=>structuredClone(request)}),url:()=> 'http://localhost:5288/api/v1/projects/qa-project/qa/prepare',status:()=>status,json:async()=>body});
const entry=()=>({projectURL:'http://localhost:5288/#qa?project=qa-project',prepared:false});

test('preparation navigation preserves project context and replaces a previous run parameter',()=>{
 const url=new URL(qaPreparationURL(entry().projectURL+'&folder=4.2&run=old','prepare-run'));
 const params=new URLSearchParams(url.hash.split('?')[1]);
 assert.equal(params.get('project'),'qa-project');assert.equal(params.get('folder'),'4.2');assert.deepEqual(params.getAll('run'),['prepare-run']);
});
function harness(initial,acknowledgement=ack(),state='queued'){
 const events=[];let resolve,requestListener;
 const page={on(event,listener){assert.equal(event,'request');requestListener=listener;},off(event,listener){assert.equal(event,'request');assert.equal(listener,requestListener);requestListener=undefined;},waitForResponse(predicate){events.push('listen');assert.equal(predicate(acknowledgement),true);return new Promise(r=>resolve=r);},async goto(url){events.push('goto');assert.match(url,/run=prepare-run/);},async waitForURL(predicate){events.push('app-handoff');assert.equal(predicate(new URL(initial.projectURL+'&run=prepare-run')),true);},request:{async get(url){events.push('read');assert.equal(url,'/api/v1/projects/qa-project/qa?run_id=prepare-run');return {status:()=>200,json:async()=>({runs:[{run_id:'prepare-run',operation:'prepare',state,stage:state==='queued'?'queued':null,manifest:{source:{filename:expected.filename,asset:source}}}]})};}}};
 const options={entry:initial,expected,save(){events.push(initial.preparationId?'save-run':initial.preparationReceipt?'save-receipt':'save-request');},async upload(){events.push('upload');assert.equal(events[0],'listen');requestListener(acknowledgement.request());resolve(acknowledgement);}};
 return {page,options,events};
}

test('prepare acceptance is persisted before any queued recognition wait or navigation',async()=>{
 const h=harness(entry());await retainQaPreparation(h.page,h.options);
 assert.deepEqual(h.events,['listen','upload','save-request','save-receipt','save-run','app-handoff','read','save-run']);
 assert.equal(h.options.entry.prepared,false);assert.equal(h.options.entry.preparationId,'prepare-run');assert.equal(h.options.entry.preparationReceipt.request_id,'prepare-request');assert.equal(h.options.entry.preparationState,'queued');
});

test('a sent preparation with a lost response is durable and cannot be resubmitted on resume',async()=>{
 const initial=entry(),events=[];let requestListener;
 const page={on(event,listener){requestListener=listener;},off(event,listener){assert.equal(listener,requestListener);requestListener=undefined;},waitForResponse(){return Promise.reject(Error('synthetic lost receipt'));}};
 const options={entry:initial,expected,save(){events.push('save-request');},async upload(){events.push('upload');requestListener(ack().request());}};
 await assert.rejects(retainQaPreparation(page,options),/lost receipt/);
 assert.deepEqual(initial.preparationRequest.source,source);assert.equal(initial.preparationRequest.request_id,request.request_id);
 assert.equal(initial.preparationId,undefined);assert.equal(initial.preparationReceipt,undefined);assert.equal(requestListener,undefined);
 await assert.rejects(retainQaPreparation(page,options),/unresolved/);
 assert.deepEqual(events,['upload','save-request']);
});

test('resume with prepared=false follows the accepted preparation without uploading or submitting again',async()=>{
 const h=harness({...entry(),preparationId:'prepare-run',preparationReceipt:{request_id:'prepare-request',source}},ack(),'succeeded');
 await retainQaPreparation(h.page,h.options);assert.deepEqual(h.events,['goto','read','save-run']);
});

test('a rejected or malformed receipt remains visible and blocks automatic resubmission',async()=>{
 for(const response of [ack(409,{}),ack(200,{})]){
  const h=harness(entry(),response);await assert.rejects(retainQaPreparation(h.page,h.options),/failed|no run ID/);
  assert.ok(h.options.entry.preparationReceipt);assert.equal(h.options.entry.preparationId,undefined);
  await assert.rejects(retainQaPreparation(h.page,h.options),/unresolved/);assert.equal(h.events.filter(x=>x==='upload').length,1);
 }
});

test('unrelated preparation receipts and terminal failures cannot silently advance the fixture',async()=>{
 assert.equal(qaPreparationResponse(ack(),'other-project',expected.sha256),false);assert.equal(qaPreparationResponse(ack(),'qa-project','b'.repeat(64)),false);
 const h=harness({...entry(),preparationId:'prepare-run'},ack(),'failed');await assert.rejects(retainQaPreparation(h.page,h.options),/did not succeed: failed/);assert.ok(!h.events.includes('upload'));
});
