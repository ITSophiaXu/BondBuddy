import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sealDurableSpool,pendingDurableSpool,readDurableSpool,flushDurableSpool,gcDurableSpool,type DurableSpoolIdentity} from './durable-spool.js';
import type {TaskCallReleaseProof} from './task-execution.js';
import {collectRegisteredDurableSpool} from './durable-spool-consumer.js';
const identity:DurableSpoolIdentity={ownerUserId:'synthetic-owner',projectId:'synthetic-project',runId:'synthetic-run',jobId:'synthetic-job',
 attemptId:'synthetic-call',logicalCallId:'synthetic-chapter',attemptNo:1,leaseToken:'synthetic-token',inputHash:'a'.repeat(64),planHash:'b'.repeat(64),
 originalExecution:{nodeId:'synthetic-node',epoch:'synthetic-epoch',sessionId:'synthetic-session'}};
const proof:TaskCallReleaseProof={version:'call_cgroup_v1',key:'c'.repeat(64),identity:'synthetic:1:2',parentKey:'d'.repeat(64),parentIdentity:'synthetic:1:1',
 logicalCallId:identity.logicalCallId,generation:1,epoch:identity.originalExecution.epoch,sessionId:identity.originalExecution.sessionId,sealed:true,nativeProcesses:0};
const usage={status:'unknown' as const,input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'bb-durable-spool-')),cwd=join(root,'cwd');await mkdir(cwd,{mode:0o700});
 await mkdir(join(cwd,'scratch'),{mode:0o700});await mkdir(join(cwd,'output'),{mode:0o700});
 await writeFile(join(cwd,'input.json'),'{}',{mode:0o600});await writeFile(join(cwd,'output/candidate.txt'),'synthetic only candidate',{mode:0o600});
 return {root,cwd,seal:()=>sealDurableSpool({root:join(root,'spool'),identity,exitProof:proof,usage,outcome:'cancelled',sourceDir:cwd,
  files:[{path:'exec.log',bytes:Buffer.from('synthetic private trace')}],minFreeBytes:0})};
}
async function registeredFixture(){
 const f=await fixture(),receipt=await f.seal(),objects=new Map<string,Buffer>();let uploads=0,registrations=0;
 await flushDurableSpool(join(f.root,'spool'),{upload:async(key,bytes)=>{uploads++;objects.set(key,bytes);},readback:async key=>objects.get(key)??null,
  register:async()=>{registrations++;return {id:'synthetic-registration'};}});
 return {...f,receipt,counts:()=>({uploads,registrations})};
}

test('ticket rename crash leftovers cannot permanently close node admission after registered capture GC',{skip:process.platform!=='linux'},async()=>{
 const f=await registeredFixture();try{
  const root=join(f.root,'spool'),manifest=await readDurableSpool(f.receipt);manifest.state='GC_ELIGIBLE';
  const directory=join(root,'.gc');await mkdir(directory,{mode:0o700});
  const prefix=join(directory,f.receipt.spoolId+'.json.');
  await writeFile(prefix+'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.new',JSON.stringify({version:'durable-spool-gc-v1',receipt:f.receipt,manifest}),{mode:0o600});
  // A second crash may precede fsync/write completion. The independent original
  // registered manifest and exact DB check authorize removing only this format.
  await writeFile(prefix+'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.new','{"version":',{mode:0o600});
  let checked=0;
  assert.deepEqual(await collectRegisteredDurableSpool(root,{verify:async()=>{checked++;return true;}}),{collected:1,failed:0});
  assert.equal(checked,1);
  assert.deepEqual(await readdir(directory),[]);
  const after=await pendingDurableSpool(root);assert.equal(after.unsafe,0);assert.equal(after.pending,0);assert.equal(after.gcPending,0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('complete temporary GC ticket recovers even if a partial deletion removed original manifest',{skip:process.platform!=='linux'},async()=>{
 const f=await registeredFixture();try{
  const root=join(f.root,'spool'),manifest=await readDurableSpool(f.receipt);manifest.state='GC_ELIGIBLE';
  const directory=join(root,'.gc');await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,f.receipt.spoolId+'.json.cccccccc-cccc-4ccc-8ccc-cccccccccccc.new'),JSON.stringify({version:'durable-spool-gc-v1',receipt:f.receipt,manifest}),{mode:0o600});
  await rm(join(f.receipt.directory,'manifest.json'));await rm(join(f.receipt.directory,'capture-pending.json'));
  const before=await pendingDurableSpool(root);assert.equal(before.pending,0);assert.equal(before.unsafe,0);assert.equal(before.gcPending,1);
  let checked=0;const counts=f.counts();
  assert.deepEqual(await collectRegisteredDurableSpool(root,{verify:async(recovered,receipt)=>{
   checked++;assert.deepEqual(recovered,manifest);assert.deepEqual(receipt,f.receipt);return true;
  }}),{collected:1,failed:0});
  assert.equal(checked,1);assert.deepEqual(f.counts(),counts);assert.deepEqual(await readdir(directory),[]);
  assert.deepEqual(await readdir(root),['.gc'],'empty capture ancestry is pruned without removing spool root');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('truncated ticket write alone recovers from original REGISTERED evidence after DB verification',{skip:process.platform!=='linux'},async()=>{
 const f=await registeredFixture();try{
  const root=join(f.root,'spool'),directory=join(root,'.gc');await mkdir(directory,{mode:0o700});
  const path=join(directory,f.receipt.spoolId+'.json.ffffffff-ffff-4fff-8fff-ffffffffffff.new');await writeFile(path,'{"version":',{mode:0o600});
  const before=await pendingDurableSpool(root);assert.equal(before.unsafe,0);assert.equal(before.gcPending,1);
  assert.deepEqual(await collectRegisteredDurableSpool(root,{verify:async()=>false}),{collected:0,failed:1});
  assert.equal(await readFile(path,'utf8'),'{"version":','failed DB check cannot erase a remainder');
  let checked=0;
  assert.deepEqual(await collectRegisteredDurableSpool(root,{now:()=>Date.now()+300000,verify:async manifest=>{checked++;assert.equal(manifest.state,'REGISTERED');return true;}}),{collected:1,failed:0});
  assert.equal(checked,1);assert.deepEqual(await readdir(directory),[]);assert.equal((await pendingDurableSpool(root)).unsafe,0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('partial rm failure leaves an external GC receipt and the next session checks DB without uploading or registering',{skip:process.platform!=='linux'},async()=>{
 const f=await registeredFixture();try{
  const root=join(f.root,'spool'),counts=f.counts(),owner=join(root,identity.ownerUserId);let checked=0;
  await writeFile(join(root,'.pump.lock'),'',{mode:0o600});await mkdir(join(owner,'keep-sibling'),{mode:0o700});
  await writeFile(join(owner,'keep-sibling','live.txt'),'concurrent sibling',{mode:0o600});
  const verify=async(manifest:Awaited<ReturnType<typeof readDurableSpool>>,receipt:typeof f.receipt)=>{
   checked++;assert.equal(manifest.registrationId,'synthetic-registration');assert.deepEqual(receipt,f.receipt);return true;
  };
  assert.deepEqual(await collectRegisteredDurableSpool(root,{verify,remove:async directory=>{
   await rm(join(directory,'manifest.json'));await rm(join(directory,'capture-pending.json'));await rm(join(directory,'evidence'),{recursive:true});
   throw Object.assign(Error('synthetic_partial_rm_failed'),{code:'EIO'});
  }}),{collected:0,failed:1});
  await assert.rejects(readDurableSpool(f.receipt),{code:'ENOENT'});
  const afterCrash=await pendingDurableSpool(root);assert.equal(afterCrash.pending,0);assert.equal(afterCrash.unsafe,0);assert.equal(afterCrash.gcPending,1);
  assert.deepEqual(await collectRegisteredDurableSpool(root,{verify,now:()=>Date.now()+300000}),{collected:1,failed:0});
  assert.equal(checked,2);assert.deepEqual(f.counts(),counts);
  await assert.rejects(readdir(f.receipt.directory),{code:'ENOENT'});
  assert.equal(await readFile(join(owner,'keep-sibling','live.txt'),'utf8'),'concurrent sibling');
  assert.deepEqual(await readdir(owner),['keep-sibling']);assert.equal(await readFile(join(root,'.pump.lock'),'utf8'),'');
  const after=await pendingDurableSpool(root);assert.equal(after.pending,0);assert.equal(after.gcPending,0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('missing DB registration, manifest changes and conflicting tickets never authorize deletion',{skip:process.platform!=='linux'},async t=>{
 for(const failure of ['db_missing','changed_manifest','ticket_conflict'] as const)await t.test(failure,async()=>{
  const f=await registeredFixture();try{
   const root=join(f.root,'spool'),manifest=await readDurableSpool(f.receipt);let checked=0;
   if(failure==='changed_manifest'){
    manifest.remoteCapture!.sha256='0'.repeat(64);await writeFile(join(f.receipt.directory,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
   }
   if(failure==='ticket_conflict'){
    const directory=join(root,'.gc');await mkdir(directory,{mode:0o700});manifest.state='GC_ELIGIBLE';
    await writeFile(join(directory,f.receipt.spoolId+'.json'),JSON.stringify({version:'durable-spool-gc-v1',receipt:f.receipt,manifest}),{mode:0o600});
    await writeFile(join(directory,f.receipt.spoolId+'.json.dddddddd-dddd-4ddd-8ddd-dddddddddddd.new'),JSON.stringify({version:'durable-spool-gc-v1',receipt:f.receipt,manifest:{...manifest,registrationId:'different-registration'}}),{mode:0o600});
   }
   const result=await collectRegisteredDurableSpool(root,{verify:async()=>{checked++;return false;},remove:async()=>assert.fail('unsafe capture must not be deleted')});
   assert.equal(result.collected,0);assert.equal(checked,failure==='db_missing'?1:0);
   if(failure==='db_missing')assert.equal(result.failed,1);
   assert.equal(await readFile(join(f.receipt.directory,'workspace/output/candidate.txt'),'utf8'),'synthetic only candidate');
   if(failure!=='db_missing')assert.ok((await pendingDurableSpool(root)).unsafe>0);
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
});

test('a truncated GC temporary without independent registered proof and unknown GC files stay unsafe',{skip:process.platform!=='linux'},async()=>{
 const f=await fixture();try{
  const receipt=await f.seal(),root=join(f.root,'spool'),directory=join(root,'.gc');await mkdir(directory,{mode:0o700});
  const temporary=join(directory,receipt.spoolId+'.json.eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.new');
  await writeFile(temporary,'{"version":',{mode:0o600});await writeFile(join(directory,'unknown-entry'),'keep',{mode:0o600});
  const inventory=await pendingDurableSpool(root);assert.equal(inventory.gcPending,0);assert.equal(inventory.unsafe,2);assert.equal(inventory.pending,3);
  assert.deepEqual(await collectRegisteredDurableSpool(root,{verify:async()=>assert.fail('no registered proof exists')}),{collected:0,failed:0});
  assert.equal(await readFile(temporary,'utf8'),'{"version":');assert.equal(await readFile(join(directory,'unknown-entry'),'utf8'),'keep');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('repeated registered capture GC prunes empty ancestor directories instead of exhausting inventory',{skip:process.platform!=='linux'},async()=>{
 const f=await fixture();try{
  const root=join(f.root,'spool');
  for(let round=0;round<8;round++){
   const receipt=await f.seal(),objects=new Map<string,Buffer>();
   await flushDurableSpool(root,{upload:async(key,bytes)=>{objects.set(key,bytes);},readback:async key=>objects.get(key)??null,register:async()=>({id:'synthetic-registration'})});
   assert.deepEqual(await collectRegisteredDurableSpool(root,{verify:async()=>true}),{collected:1,failed:0});
   assert.deepEqual(await readdir(root),['.gc']);assert.equal((await pendingDurableSpool(root)).gcPending,0);
   await assert.rejects(readdir(receipt.directory),{code:'ENOENT'});
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const state of ['REGISTERED','GC_ELIGIBLE'] as const)test(`${state} capture is collected next pass after only registration evidence is rechecked`,{skip:process.platform!=='linux'},async()=>{
 const f=await registeredFixture();try{
  if(state==='GC_ELIGIBLE'){
   // Crash after the GC state fsync (or removal failure) keeps the same capture
   // envelope/hash. A fresh consumer must find it without replaying upload.
   const manifest=await readDurableSpool(f.receipt);manifest.state=state;
   await writeFile(join(f.receipt.directory,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  }
  const counts=f.counts();let checked=0;
  assert.deepEqual(await collectRegisteredDurableSpool(join(f.root,'spool'),{verify:async(manifest,receipt)=>{
   checked++;assert.equal(manifest.registrationId,'synthetic-registration');assert.equal(receipt.manifestSha256,f.receipt.manifestSha256);return true;
  }}),{collected:1,failed:0});
  assert.equal(checked,1);assert.deepEqual(f.counts(),counts,'GC neither uploads nor registers again');
  await assert.rejects(readFile(join(f.receipt.directory,'manifest.json')),{code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('spool owns fsynced bytes before original deletion and cancellation never means completed',{skip:process.platform!=='linux'},async()=>{
 const f=await fixture();try{
  const receipt=await f.seal();await rm(f.cwd,{recursive:true});
  const manifest=await readDurableSpool(receipt);assert.equal(manifest.outcome,'cancelled');assert.equal(manifest.usage.status,'unknown');
  assert.equal(await readFile(join(receipt.directory,'workspace/output/candidate.txt'),'utf8'),'synthetic only candidate');
  assert.equal((await pendingDurableSpool(join(f.root,'spool'))).pending,1);
  await assert.rejects(gcDurableSpool(receipt),/NOT_REGISTERED/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('restart after remote verification retries registration without reupload or changing provider outcome',{skip:process.platform!=='linux'},async()=>{
 const f=await fixture();try{
  const receipt=await f.seal(),objects=new Map<string,Buffer>();let uploads=0,registrations=0;
  const dependencies={upload:async(key:string,bytes:Buffer)=>{uploads++;objects.set(key,bytes);},readback:async(key:string)=>objects.get(key)??null,
   register:async()=>{registrations++;throw Error('synthetic_database_unavailable');}};
  assert.deepEqual(await flushDurableSpool(join(f.root,'spool'),dependencies),{registered:0,failed:1});
  const firstUploads=uploads;assert.equal((await readDurableSpool(receipt)).state,'REMOTE_VERIFIED');
  assert.equal((await pendingDurableSpool(join(f.root,'spool'))).pending,1);
  const now=()=>Date.now()+300000;
  assert.deepEqual(await flushDurableSpool(join(f.root,'spool'),{...dependencies,register:async manifest=>{registrations++;assert.equal(manifest.outcome,'cancelled');return {id:'synthetic-registration'};}},{now}),{registered:1,failed:0});
  assert.equal(uploads,firstUploads);assert.equal(registrations,2);assert.equal((await pendingDurableSpool(join(f.root,'spool'))).pending,0);
  await gcDurableSpool(receipt);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('unsafe file, wrong generation and low disk fail before capture handoff',{skip:process.platform!=='linux'},async()=>{
 const f=await fixture();try{
  await assert.rejects(sealDurableSpool({root:join(f.root,'wrong'),identity,exitProof:{...proof,generation:2},usage,outcome:'timeout',sourceDir:f.cwd,minFreeBytes:0}),/EXIT_PROOF_INVALID/);
  await assert.rejects(sealDurableSpool({root:join(f.root,'low-disk'),identity,exitProof:proof,usage,outcome:'timeout',sourceDir:f.cwd,minFreeBytes:Number.MAX_SAFE_INTEGER}),/LOW_DISK/);
  await symlink(join(f.cwd,'input.json'),join(f.cwd,'output/unsafe'));
  await assert.rejects(f.seal(),/FILE_UNSAFE/);
  assert.equal(await readFile(join(f.cwd,'output/candidate.txt'),'utf8'),'synthetic only candidate');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('incomplete local handoff and failed readback pin node and preserve original bytes',{skip:process.platform!=='linux'},async()=>{
 const f=await fixture();try{
  const receipt=await f.seal();let uploads=0;
  assert.deepEqual(await flushDurableSpool(join(f.root,'spool'),{upload:async()=>{uploads++;},readback:async()=>null,
   register:async()=>{assert.fail('unverified capture must never register');}},{maxAttempts:1}),{registered:0,failed:1});
  assert.equal(uploads,1);assert.equal((await pendingDurableSpool(join(f.root,'spool'))).pending,1);
  assert.equal((await readDurableSpool(receipt)).state,'SEALED_LOCAL');
  const pending=join(f.root,'spool/incomplete');await mkdir(pending,{mode:0o700});await writeFile(join(pending,'capture-pending.json'),'{}',{mode:0o600});
  assert.equal((await pendingDurableSpool(join(f.root,'spool'))).pending,2);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
