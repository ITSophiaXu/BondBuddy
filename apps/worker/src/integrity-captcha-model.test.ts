import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import type {StageContext,StageOutcome,codexModelStage} from './run-pipeline.js';
import {saveModelImage,loadModelImage} from './model-image-input.js';
import {integrityCaptchaRecognizer,integrityCaptchaCallName} from './integrity-captcha-model.js';
import {IntegrityCaptchaInterruption} from './integrity-captcha.js';
import {collectIntegritySite} from './integrity-browser-stage.js';
import {INTEGRITY_SITES} from '@bondbuddy/contracts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
const image={png,sha256:createHash('sha256').update(png).digest('hex')};
test('image storage is owner/run-scoped and validates bytes on every replay',async()=>{
 const records=new Map<string,Buffer>();
 const blobs={put:async(k:string,b:Buffer)=>{records.set(k,b);},getIfExistsBounded:async(k:string)=>records.get(k)??null} as unknown as PrivateBlobs;
 const scope={owner_user_id:'owner',project_id:'project',id:'run'};
 const ref=await saveModelImage(blobs,scope,image);
 assert.deepEqual(await loadModelImage(blobs,scope,ref),image);
 await assert.rejects(loadModelImage(blobs,{...scope,owner_user_id:'other'},ref));
 await assert.rejects(loadModelImage(blobs,scope,{...ref,byte_size:2*1024*1024}));
 const key=[...records.keys()][0];records.set(key,Buffer.alloc(png.length));
 await assert.rejects(loadModelImage(blobs,scope,ref));
});
test('recognition uses bounded durable slots; old sessions are reconciled and their codes discarded',async()=>{
 const ctx={checkpoint:{},signal:new AbortController().signal} as StageContext;
 const names:string[]=[];let calls=0;
 const model:typeof codexModelStage=options=>({name:options.name,run:async()=>{
  names.push(options.logicalCallId);calls++;ctx.checkpoint[options.name+'_prompt']={snapshot_id:'pinned'};
  assert.equal(options.config instanceof Function&&options.config().web_search,'disabled');
  return {kind:'done',value:{code:calls===1?'A1b2':'C3d4'}};
 }});
 const config=()=>({model_provider:'copilot_enterprise',model_id:'gpt-6-sol',timeout_ms:5000} as ReturnType<typeof import('./codex-adapter.js').loadCodexAdapterConfig>);
 const first=(await integrityCaptchaRecognizer(ctx,'subject','credit-china',{model,config}))!;
 assert.equal(await first(image),'A1b2');
 const restarted=(await integrityCaptchaRecognizer(ctx,'subject','credit-china',{model,config}))!;
 assert.equal(calls,2,'preflight replays the prior durable slot before opening a fresh browser');
 assert.equal(await restarted(image),'C3d4');assert.equal(await restarted(image),null);assert.equal(calls,3);
 assert.deepEqual(names,[integrityCaptchaCallName('subject','credit-china',1),integrityCaptchaCallName('subject','credit-china',1),integrityCaptchaCallName('subject','credit-china',2)]);
 const pause:StageOutcome={kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'};
 const paused:typeof codexModelStage=o=>({name:o.name,run:async()=>pause});
 await assert.rejects(integrityCaptchaRecognizer(ctx,'subject','credit-china',{model:paused,config}),e=>e instanceof IntegrityCaptchaInterruption&&e.outcome===pause);
 const site=INTEGRITY_SITES.find(s=>s.id==='credit-china')!;
 await assert.rejects(collectIntegritySite(async()=>{throw new IntegrityCaptchaInterruption(pause);},site,{name:'合成企业',kind:'company',province:'河南',city:''},ctx.signal),IntegrityCaptchaInterruption);
 assert.equal(await integrityCaptchaRecognizer(ctx,'subject','execution-debtor',{model,config}),undefined);
 const textOnly=(await integrityCaptchaRecognizer({...ctx,checkpoint:{}},'other','credit-china',{model,config:()=>({...config(),model_id:'deepseek-flash'})}))!;
 assert.equal(textOnly,undefined);assert.equal(calls,3);
});
