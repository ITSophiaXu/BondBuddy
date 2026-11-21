import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sealDurableSpool,pendingDurableSpool,type DurableSpoolIdentity} from './durable-spool.js';
import type {TaskCallReleaseProof} from './task-execution.js';

test('each local fsync failure retains the only original capture without issuing a handoff receipt',async t=>{
 const identity:DurableSpoolIdentity={ownerUserId:'synthetic-owner',projectId:'synthetic-project',runId:'synthetic-run',jobId:'synthetic-job',attemptId:'synthetic-attempt',logicalCallId:'synthetic-call',attemptNo:1,leaseToken:'synthetic-token',inputHash:'a'.repeat(64),planHash:null,originalExecution:{nodeId:'synthetic-node',epoch:'synthetic-epoch',sessionId:'synthetic-session'}};
 const proof:TaskCallReleaseProof={version:'call_cgroup_v1',key:'b'.repeat(64),parentKey:'c'.repeat(64),identity:'synthetic-call-identity',parentIdentity:'synthetic-parent-identity',logicalCallId:identity.logicalCallId,generation:1,epoch:identity.originalExecution.epoch,sessionId:identity.originalExecution.sessionId,sealed:true,nativeProcesses:0};
 // The marker, input, candidate and final manifest each sync a file and its
 // directory. Inject through the actual FileHandle method; no production hook.
 for(let failureAt=1;failureAt<=8;failureAt++)await t.test('sync '+failureAt,async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-spool-fsync-')),source=join(root,'source');
  try{
   await mkdir(join(source,'scratch'),{recursive:true,mode:0o700});await mkdir(join(source,'output'),{mode:0o700});
   await writeFile(join(source,'input.json'),'{}',{mode:0o600});await writeFile(join(source,'output/candidate.txt'),'synthetic only copy',{mode:0o600});
   const handle=await open(join(source,'input.json'),'r'),prototype=Object.getPrototypeOf(handle),original=prototype.sync;await handle.close();
   let syncs=0;
   const replacement=t.mock.method(prototype,'sync',async function(this:unknown){if(++syncs===failureAt)throw Object.assign(Error('synthetic fsync IO failure'),{code:'EIO'});return original.call(this);});
   try{
    await assert.rejects(sealDurableSpool({root:join(root,'spool'),identity,exitProof:proof,usage:{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null},outcome:'cancelled',sourceDir:source,minFreeBytes:0}),/synthetic fsync IO failure/);
    assert.equal(syncs,failureAt);
   }finally{replacement.mock.restore();}
   assert.equal(await readFile(join(source,'output/candidate.txt'),'utf8'),'synthetic only copy');
   assert.equal(await readFile(join(source,'input.json'),'utf8'),'{}');
   const inventory=await pendingDurableSpool(join(root,'spool'));
   assert.ok(inventory.pending>0,'incomplete local responsibility remains discoverable');
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
