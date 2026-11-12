// Synthetic orchestration and durable-journal replay; no real supplier calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '@bondbuddy/api/data';
import { deliverWithSizeRepair, type SizeRepair } from './file-authoring-repair.js';
import type { FileAuthoringResult } from './file-authoring-stage.js';
import type { StageContext, StageOutcome } from './run-pipeline.js';

function fixture(){
  const prefix='owners/owner/projects/project/runs/run/file-authoring/';
  const objects=new Map<string,Buffer>();
  const candidate=(round:number):FileAuthoringResult=>({version:'codex-file-word-v1',input_hash:'a'.repeat(64),files:{},summary:{round}});
  const initial=candidate(0),ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_hash:initial.input_hash},
    lease:{checkpoint:{}},checkpoint:{},values:new Map([['model_generation',initial]]),signal:new AbortController().signal,
    blobs:{getIfExistsBounded:async(key:string)=>objects.get(key)??null}} as unknown as StageContext;
  const rejected=(codes=['WORD_DOCUMENT_SIZE_REDUCED']):StageOutcome=>{
    const bytes=Buffer.from(JSON.stringify({version:'word-quality-v1',status:'failed',issues:codes.map(code=>({code})),metrics:{},limitations:[]}));
    const sha256=digest(bytes),key=`${prefix}quality/${sha256}/quality-report.json`;objects.set(key,bytes);
    return {kind:'fail',code:'WORD_QUALITY_REJECTED',checkpoint:{quality_gate:{report:{key,sha256,byte_size:bytes.length}}}};
  };
  const persist:NonNullable<Parameters<typeof deliverWithSizeRepair>[1]['checkpoint']>=async(_pool,lease,stage,value,completed)=>{
    assert.equal(completed,false);
    lease.checkpoint={...lease.checkpoint,stages:{...lease.checkpoint.stages as object,[stage]:structuredClone(value)}};
  };
  let sends=0;const journal=new Map<number,FileAuthoringResult>();
  const repair=async(_ctx:StageContext,request:SizeRepair):Promise<StageOutcome>=>{
    assert.equal(request.previous.summary.round,request.round-1);
    if(!journal.has(request.round)){sends++;journal.set(request.round,candidate(request.round));}
    return {kind:'done',value:journal.get(request.round)};
  };
  const options={checkpoint:persist,pause:async()=>false,repair};
  const restart=()=>{ctx.checkpoint=structuredClone(ctx.lease.checkpoint.stages??{}) as StageContext['checkpoint'];};
  return {ctx,initial,objects,rejected,options,repair,journal,restart,sends:()=>sends};
}
const delivered:StageOutcome={kind:'deliver',bytes:Buffer.from('synthetic checked revision'),cleanBytes:Buffer.from('synthetic checked clean')};

test('size rejection repairs the same run and requires a fresh host pass before delivery',async()=>{
  const f=fixture(),checked:number[]=[];
  const result=await deliverWithSizeRepair(f.ctx,{...f.options,attempt:async(ctx,round)=>{
    checked.push(round);assert.equal((ctx.values.get('model_generation') as FileAuthoringResult).summary.round,round);
    return round===0?f.rejected():delivered;
  }});
  assert.equal(result.kind,'deliver');assert.deepEqual(checked,[0,1]);assert.equal(f.sends(),1);
  assert.equal(f.ctx.values.get('model_generation'),f.initial);
  assert.ok(f.ctx.checkpoint.word_size_review_0);
});

test('two unsuccessful repairs pause with durable evidence; resume does not reset the budget',async()=>{
  const f=fixture();let checks=0;
  const run=()=>deliverWithSizeRepair(f.ctx,{...f.options,attempt:async()=>{checks++;return f.rejected();}});
  const expected={kind:'pause',stage:'capability_not_ready',reason:'word_size_repair_exhausted'};
  assert.deepEqual(await run(),expected);assert.equal(f.sends(),2);assert.equal(checks,3);
  f.restart();assert.deepEqual(await run(),expected);assert.equal(f.sends(),2);assert.equal(checks,3);
  assert.ok(f.ctx.checkpoint.word_size_review_2);
});

test('a crash after provider completion replays that round instead of buying another call',async()=>{
  const f=fixture();let crash=true,checks=0;
  const run=()=>deliverWithSizeRepair(f.ctx,{...f.options,attempt:async(_ctx,round)=>{checks++;return round?delivered:f.rejected();},
    repair:async(ctx,request)=>{const done=await f.repair(ctx,request);if(crash){crash=false;throw Error('SYNTHETIC_CRASH');}return done;}});
  await assert.rejects(run,/SYNTHETIC_CRASH/);f.restart();
  assert.equal((await run()).kind,'deliver');assert.equal(f.sends(),1);assert.equal(checks,2);
});

test('renderer outages retry checking without any model repair',async()=>{
  const f=fixture();
  await assert.rejects(deliverWithSizeRepair(f.ctx,{...f.options,attempt:async()=>f.rejected(['WORD_PAGE_COUNT_UNAVAILABLE'])}),/WORD_PAGE_COUNT_UNAVAILABLE/);
  assert.equal(f.sends(),0);assert.deepEqual(f.ctx.checkpoint,{});
});

test('pause, cancellation and uncertain provider outcomes never launch extra repair turns',async()=>{
  const f=fixture();
  assert.deepEqual(await deliverWithSizeRepair(f.ctx,{...f.options,pause:async()=>true,attempt:async()=>f.rejected()}),{kind:'stopped'});
  assert.equal(f.sends(),0);
  f.restart();const paused={kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'} as const;
  assert.deepEqual(await deliverWithSizeRepair(f.ctx,{...f.options,repair:async()=>paused,attempt:async()=>assert.fail('replayed rejection')}),paused);
  const abort=new AbortController();abort.abort();f.ctx.signal=abort.signal;
  await assert.rejects(deliverWithSizeRepair(f.ctx,{...f.options,attempt:async()=>assert.fail('cancelled')}),{name:'AbortError'});
  assert.equal(f.sends(),0);
});

test('explicit delivery-only recovery and input-integrity failures never request model repair',async()=>{
  for(const recovery of [false,true]){
    const f=fixture();if(recovery)f.ctx.lease.checkpoint.word_pair_delivery_recovery={attempt_no:1};
    const failure=f.rejected(recovery?undefined:['WORD_DOCUMENT_SIZE_REDUCED','WORD_BASELINE_CHANGED']);
    assert.deepEqual(await deliverWithSizeRepair(f.ctx,{...f.options,attempt:async()=>failure}),failure);
    assert.equal(f.sends(),0);assert.deepEqual(f.ctx.checkpoint,{});
  }
});

test('changed candidates or corrupt persisted reports cannot authorize a repair',async()=>{
  for(const mutation of ['candidate','report','foreign'] as const){
    const f=fixture();
    await deliverWithSizeRepair(f.ctx,{...f.options,pause:async()=>true,attempt:async()=>f.rejected()});
    const saved=f.ctx.checkpoint.word_size_review_0!;
    if(mutation==='candidate')(saved.candidate as FileAuthoringResult).input_hash='b'.repeat(64);
    else if(mutation==='foreign')(saved.report as {key:string}).key='owners/other/quality-report.json';
    else f.objects.set((saved.report as {key:string}).key,Buffer.from('changed'));
    await assert.rejects(deliverWithSizeRepair(f.ctx,{...f.options,attempt:async()=>assert.fail('saved rejection')}),/INPUT_REVISION_CONFLICT|WORD_OUTPUT_BLOB_MISMATCH/);
    assert.equal(f.sends(),0);
  }
});

test('a repaired candidate cannot bypass the other Word quality gates',async()=>{
  const f=fixture(),failure=f.rejected(['WORD_REVISION_MISMATCH']);
  const result=await deliverWithSizeRepair(f.ctx,{...f.options,attempt:async(_ctx,round)=>round?failure:f.rejected()});
  assert.deepEqual(result,failure);assert.equal(f.sends(),1);
});
