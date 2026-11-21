import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sealDurableSpool,pendingDurableSpool,readDurableSpool,flushDurableSpool,gcDurableSpool,type DurableSpoolIdentity} from './durable-spool.js';
import type {TaskCallReleaseProof} from './task-execution.js';
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
