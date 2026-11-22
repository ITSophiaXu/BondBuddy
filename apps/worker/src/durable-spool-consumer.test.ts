import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {unlockedSpoolPass,withDurableSpoolPumpLock,observeSpoolIo,replaySpoolIoObservations,collectRegisteredDurableSpool,childCommand} from './durable-spool-consumer.js';
import {PerformanceTraceRuntime,type PerformanceSpanRecord} from '@bondbuddy/api/performance-trace';
import {sealDurableSpool,flushDurableSpool,readDurableSpool,readDurableSpoolForGc,pendingDurableSpool,gcDurableSpool,type DurableSpoolIdentity} from './durable-spool.js';
import type {TaskCallReleaseProof} from './task-execution.js';

async function fairSpoolFixture(registered:boolean){
 const root=await mkdtemp(join(tmpdir(),'bb-spool-fair-')),objects=new Map<string,Buffer>();
 for(let index=0;index<4;index++){
  const identity:DurableSpoolIdentity={ownerUserId:'synthetic-owner',projectId:'synthetic-project',runId:'synthetic-run',jobId:'synthetic-job',attemptId:'synthetic-attempt-'+index,
   logicalCallId:'synthetic-logical',attemptNo:1,leaseToken:'synthetic-token',inputHash:'a'.repeat(64),planHash:null,
   originalExecution:{nodeId:'synthetic-node',epoch:'synthetic-epoch',sessionId:'synthetic-session'}};
  const proof:TaskCallReleaseProof={version:'call_cgroup_v1',key:'c'.repeat(64),identity:'synthetic:1:2',parentKey:'d'.repeat(64),parentIdentity:'synthetic:1:1',
   logicalCallId:identity.logicalCallId,generation:1,epoch:identity.originalExecution.epoch,sessionId:identity.originalExecution.sessionId,sealed:true,nativeProcesses:0};
  const receipt=await sealDurableSpool({root,identity,exitProof:proof,usage:{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null},
   outcome:'cancelled',files:[{path:'trace.log',bytes:Buffer.from('synthetic capture')}],minFreeBytes:0});
  await flushDurableSpool(root,{upload:async(key,bytes)=>{objects.set(key,bytes);},readback:async key=>objects.get(key)??null,
   register:async()=>{if(!registered)throw Error('synthetic initial registration deferred');return {id:'synthetic-registration'};}},{receipt});
  const manifest=await readDurableSpool(receipt);manifest.attempts=0;manifest.nextDueAt='2020-01-01T00:00:00.000Z';
  await writeFile(join(receipt.directory,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
 }
 return {root,receipts:registered?(await pendingDurableSpool(root)).gcReceipts:(await pendingDurableSpool(root)).receipts};
}

test('registration failures rotate four due receipts across passes and persist retry attempts without reupload (synthetic registrar)',{skip:process.platform!=='linux'},async()=>{
 const f=await fairSpoolFixture(false);let clock=Date.now();const calls:string[]=[],failureSet=new Set(f.receipts.slice(0,3).map(r=>r.spoolId));
 try{
  const pass=()=>unlockedSpoolPass({options:{port:1}} as unknown as Pool,f.root,()=>{}, {now:()=>clock,register:async(_manifest,receipt)=>{
   calls.push(receipt.spoolId);if(failureSet.has(receipt.spoolId))throw Error('synthetic persistent registration outage');return {id:'synthetic-registration'};
  }});
  assert.deepEqual(await pass(),{registered:0,failed:3,pending:4,gcPending:0});
  const firstDue=await Promise.all(f.receipts.slice(0,3).map(async receipt=>(await readDurableSpool(receipt)).nextDueAt));
  clock+=300000;
  assert.equal((await pass()).registered,1,'the untried fourth receipt must precede repeatedly failing registrations');
  assert.equal(calls[3],f.receipts[3].spoolId);assert.equal(calls.length,6,'each pass remains bounded at three registrations');
  for(let index=0;index<3;index++){
   const manifest=await readDurableSpool(f.receipts[index]);assert.ok(manifest.attempts>=1);assert.ok(Date.parse(firstDue[index])>clock-300000);
   assert.equal(manifest.state,'REMOTE_VERIFIED');assert.equal(manifest.outcome,'cancelled');assert.equal(manifest.usage.status,'unknown');
  }
  await assert.rejects(readDurableSpool(f.receipts[3]),{code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const failure of ['verification','partial_gc'] as const)test(`GC ${failure} failures rotate four receipts and retain durable backoff after restart`,{skip:process.platform!=='linux'},async()=>{
 const f=await fairSpoolFixture(true),failureSet=new Set(f.receipts.slice(0,3).map(r=>r.spoolId)),calls:string[]=[];let clock=Date.now();
 try{
  if(failure==='partial_gc')for(const receipt of f.receipts.slice(0,3)){
   await assert.rejects(gcDurableSpool(receipt,{root:f.root,remove:async directory=>{await rm(join(directory,'manifest.json'));throw Error('synthetic partial delete');}}));
  }
  const pass=()=>collectRegisteredDurableSpool(f.root,{now:()=>clock,verify:async(_manifest,receipt)=>{
   calls.push(receipt.spoolId);return failure!=='verification'||!failureSet.has(receipt.spoolId);
  },remove:async directory=>{if(failureSet.has(f.receipts.find(r=>r.directory===directory)!.spoolId))throw Error('synthetic persistent delete outage');await rm(directory,{recursive:true});}} as Parameters<typeof collectRegisteredDurableSpool>[1]);
  assert.deepEqual(await pass(),{collected:0,failed:3});
  const firstDue=await Promise.all(f.receipts.slice(0,3).map(async receipt=>(await readDurableSpoolForGc(f.root,receipt)).nextDueAt));
  clock+=300000;
  assert.equal((await pass()).collected,1,'fourth receipt cannot be starved by three permanent failures');assert.equal(calls[3],f.receipts[3].spoolId);
  assert.equal(calls.length,6);
  for(let index=0;index<3;index++){
   const manifest=await readDurableSpoolForGc(f.root,f.receipts[index]);assert.ok(manifest.attempts>=1);assert.ok(Date.parse(firstDue[index])>clock-300000);
  }
  assert.equal((await pendingDurableSpool(f.root)).gcPending,3);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const exit of ['timeout','nonzero'] as const)test(`real IO child ${exit} retains completed observations and marks active SDK work interrupted only after join`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-spool-child-')),pidFile=join(root,'pid'),spans=new Map<string,PerformanceSpanRecord>();
 const runtime=new PerformanceTraceRuntime(async(_sessions,rows)=>{for(const row of rows)spans.set(row.span_id,row);});
 const script=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const started_at=new Date().toISOString(),base={version:'durable-spool-io-v2',object_ref:'${'a'.repeat(64)}',byte_size:5,started_at};const emit=x=>process.stdout.write(JSON.stringify({...base,...x})+'\\n');emit({event:'start',operation_id:'upload',step_key:'spool.upload'});emit({event:'end',operation_id:'upload',step_key:'spool.upload',ended_at:new Date().toISOString(),status:'succeeded'});emit({event:'start',operation_id:'readback',step_key:'spool.readback'});${exit==='timeout'?'setInterval(()=>{},1000);':'process.exitCode=7;'} `;
 try{
  await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job'},async()=>{
   await assert.rejects(childCommand(['upload'],500,{command:[process.execPath,'-e',script],attributes:{spool_id:'b'.repeat(64),logical_call_id:'logical',call_id:'attempt'}}),new RegExp(exit==='timeout'?'CHILD_TIMEOUT':'CHILD_FAILED'));
  });await runtime.drain();
  const pid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'timeout rejects only after child is joined');
  const upload=[...spans.values()].find(s=>s.step_key==='spool.upload'),readback=[...spans.values()].find(s=>s.step_key==='spool.readback');
  assert.equal(upload?.status,'succeeded','completed child timings survive timeout/nonzero');assert.equal(readback?.status,'interrupted');
  assert.equal(readback?.attributes.result_status,'unknown');assert.equal(readback?.attributes.measurement_source,'private_blob_parent_interruption');
  assert.equal(readback?.attributes.event_kind,'child_close');assert.equal(upload?.attributes.spool_id,'b'.repeat(64));
  assert.equal(upload?.attributes.measurement_source,'private_blob_child_observation');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('IO emits a bounded start before pending SDK work and an end only after resolution',async()=>{
 const observations:Parameters<typeof observeSpoolIo>[0]=[],events:unknown[]=[];let release!:()=>void;
 const pending=observeSpoolIo(observations,'spool.upload','private/key',5,()=>new Promise<void>(resolve=>{release=resolve;}),event=>events.push(event));
 assert.equal(events.length,1);assert.equal((events[0] as {event:string}).event,'start');assert.equal(observations.length,0);
 assert.ok(!JSON.stringify(events).includes('private/key'));release();await pending;
 assert.equal(events.length,2);assert.equal((events[1] as {event:string}).event,'end');assert.equal(observations.length,1);
 assert.ok(events.every(event=>Buffer.byteLength(JSON.stringify(event))<=1024));
});

test('private child IO observations retain failed operation timing and reject missing, negative or oversized data',async()=>{
 const observations:Parameters<typeof observeSpoolIo>[0]=[],failure=Error('synthetic readback failed');
 await observeSpoolIo(observations,'spool.upload','private/object/key',5,async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
 await assert.rejects(observeSpoolIo(observations,'spool.readback','private/object/key',5,async()=>{throw failure;}),error=>error===failure);
 assert.equal(observations.length,2);assert.ok(!JSON.stringify(observations).includes('private/object/key'));
 const spans=new Map<string,PerformanceSpanRecord>(),runtime=new PerformanceTraceRuntime(async(_ss,rows)=>{for(const row of rows)spans.set(row.span_id,row);});
 await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job'},async()=>{
  assert.equal(replaySpoolIoObservations(Buffer.from(JSON.stringify({version:'durable-spool-io-v1',observations})),{spool_id:'a'.repeat(64),logical_call_id:'logical',call_id:'attempt'}),true);
  for(const invalid of [{}, {version:'durable-spool-io-v1',observations:[{...observations[0],ended_at:'2020-01-01T00:00:00.000Z'}]}, {version:'durable-spool-io-v1',observations:Array(10000).fill(observations[0])}])assert.throws(()=>replaySpoolIoObservations(Buffer.from(JSON.stringify(invalid))),/TIMING_INVALID/);
 });await runtime.drain();
 const upload=[...spans.values()].find(row=>row.step_key==='spool.upload')!,readback=[...spans.values()].find(row=>row.step_key==='spool.readback')!;
 assert.equal(upload.status,'succeeded');assert.ok(upload.duration_ms!>=1);assert.equal(readback.status,'failed');assert.equal(readback.clock_source,'wall_clock_observation');
 for(const row of [upload,readback]){assert.equal(row.attributes.call_id,'attempt');assert.equal(row.attributes.logical_call_id,'logical');assert.equal(row.attributes.spool_id,'a'.repeat(64));assert.equal(row.attributes.measurement_source,'private_blob_child_observation');}
});

test('GC-only work under the real kernel lock rechecks exact DB evidence and needs no storage credentials or child upload (mock PG)',{skip:process.platform!=='linux'},async t=>{
 for(const recorded of [true,false])await t.test(recorded?'recorded':'registration_missing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-spool-gc-only-')),connection=process.env.AZURE_STORAGE_CONNECTION_STRING;
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  try{
   const identity:DurableSpoolIdentity={ownerUserId:'synthetic-owner',projectId:'synthetic-project',runId:'synthetic-run',jobId:'synthetic-job',attemptId:'synthetic-attempt',
    logicalCallId:'synthetic-logical',attemptNo:1,leaseToken:'synthetic-token',inputHash:'a'.repeat(64),planHash:null,
    originalExecution:{nodeId:'synthetic-node',epoch:'synthetic-epoch',sessionId:'synthetic-session'}};
   const proof:TaskCallReleaseProof={version:'call_cgroup_v1',key:'c'.repeat(64),identity:'synthetic:1:2',parentKey:'d'.repeat(64),parentIdentity:'synthetic:1:1',
    logicalCallId:identity.logicalCallId,generation:1,epoch:identity.originalExecution.epoch,sessionId:identity.originalExecution.sessionId,sealed:true,nativeProcesses:0};
   const receipt=await sealDurableSpool({root,identity,exitProof:proof,usage:{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null},
    outcome:'cancelled',files:[{path:'trace.log',bytes:Buffer.from('synthetic capture')}],minFreeBytes:0}),objects=new Map<string,Buffer>();
   await flushDurableSpool(root,{upload:async(key,bytes)=>{objects.set(key,bytes);},readback:async key=>objects.get(key)??null,register:async()=>({id:'synthetic-registration'})});
   const manifest=await readDurableSpool(receipt),capture=manifest.remoteCapture!;
   const evidenceHash=inputManifestHash({ownerUserId:identity.ownerUserId,projectId:identity.projectId,runId:identity.runId,jobId:identity.jobId,attemptId:identity.attemptId,
    logicalCallId:identity.logicalCallId,attemptNo:identity.attemptNo,originalExecution:identity.originalExecution,capture,manifestSha256:receipt.manifestSha256});
   let reads=0;
   const pool={query:async(query:{text:string;values:unknown[];query_timeout:number})=>{
    reads++;assert.match(query.text,/^SELECT id FROM bb_recovered_capture_evidence WHERE id=\$1 AND evidence_sha256=\$2 AND manifest_sha256=\$3/);
    assert.deepEqual(query.values,['synthetic-registration',evidenceHash,receipt.manifestSha256,identity.ownerUserId,identity.projectId,identity.runId,identity.jobId,identity.attemptId,capture.key,capture.sha256,capture.byteSize]);
    assert.equal(query.query_timeout,5000);return {rowCount:recorded?1:0,rows:recorded?[{id:'synthetic-registration'}]:[]};
   }} as unknown as Pool;
   assert.deepEqual(await withDurableSpoolPumpLock(root,assertLock=>unlockedSpoolPass(pool,root,assertLock),async()=>assert.fail('synthetic GC must acquire kernel lock')),
    {registered:0,failed:recorded?0:1,pending:0,gcPending:recorded?0:1});
   assert.equal(reads,1,'GC reads an existing DB record once, never registers evidence again');
   if(recorded){assert.deepEqual((await readdir(root)).sort(),['.gc','.pump.lock']);assert.equal((await pendingDurableSpool(root)).gcPending,0);}
   else{assert.equal(await readFile(join(receipt.directory,'evidence/trace.log'),'utf8'),'synthetic capture');assert.equal((await pendingDurableSpool(root)).gcPending,1);}
  }finally{if(connection===undefined)delete process.env.AZURE_STORAGE_CONNECTION_STRING;else process.env.AZURE_STORAGE_CONNECTION_STRING=connection;await rm(root,{recursive:true,force:true});}
 });
});

test('kernel pump lock excludes another session and releases after failed owner work',{skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-spool-pump-lock-'));
 let entered!:()=>void,enterFailed!:(error:unknown)=>void,release!:()=>void;
 const entry=new Promise<void>((resolve,reject)=>{entered=resolve;enterFailed=reject;}),hold=new Promise<void>(resolve=>{release=resolve;});
 try{
  const first=withDurableSpoolPumpLock(root,async assertLock=>{assertLock();entered();await hold;assertLock();throw Error('synthetic_owner_failed');},async()=>{assert.fail('first owner acquires');});
  void first.catch(enterFailed);
  await entry;
  const second=await withDurableSpoolPumpLock(root,async()=>{assert.fail('concurrent owner cannot upload/register/GC');},async()=> 'busy');
  assert.equal(second,'busy');release();await assert.rejects(first,/synthetic_owner_failed/);
  assert.equal(await withDurableSpoolPumpLock(root,async assertLock=>{assertLock();return 'recovered';},async()=>{assert.fail('kernel lock released with owner');}),'recovered');
 }finally{release?.();await rm(root,{recursive:true,force:true});}
});
