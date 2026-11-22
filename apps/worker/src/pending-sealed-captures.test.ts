import test from 'node:test';
import assert from 'node:assert/strict';
import {PendingSealedCaptureRegistry} from './pending-sealed-captures.js';
import type {DurableSpoolIdentity} from './durable-spool.js';
import type {TaskCallReleaseProof} from './task-execution.js';
const identity:DurableSpoolIdentity={ownerUserId:'synthetic-owner',projectId:'synthetic-project',runId:'synthetic-run',jobId:'synthetic-job',
 attemptId:'synthetic-attempt',logicalCallId:'synthetic-call',attemptNo:1,leaseToken:'synthetic-token',inputHash:'a'.repeat(64),planHash:null,
 originalExecution:{nodeId:'synthetic-node',epoch:'synthetic-epoch',sessionId:'synthetic-session'}};
const proof:TaskCallReleaseProof={version:'call_cgroup_v1',key:'a'.repeat(64),parentKey:'b'.repeat(64),identity:'synthetic:1:2',parentIdentity:'synthetic:1:1',
 logicalCallId:identity.logicalCallId,generation:1,epoch:identity.originalExecution.epoch,sessionId:identity.originalExecution.sessionId,sealed:true,nativeProcesses:0};
const receipt={directory:'/synthetic/private/spool',spoolId:'c'.repeat(64),manifestSha256:'d'.repeat(64)},owner=identity.originalExecution;

test('only the original session retries ACK, then independently retries the original release',async()=>{
 const registry=new PendingSealedCaptureRegistry();let ack=0,releases=0,blocked=true,deleteBlocked=true;
 const handle=registry.retain({identity,receipt,proof,acknowledge:async()=>{ack++;if(blocked)throw Error('synthetic_ack_failure');},
  release:async()=>{releases++;if(deleteBlocked)throw Error('synthetic_delete_failure');}});
 await assert.rejects(handle.attempt(),/synthetic_ack_failure/);assert.equal(releases,0);
 assert.deepEqual(await registry.retry({...owner,sessionId:'another-session'}),{released:0,failed:0,pending:0});assert.equal(ack,1);
 blocked=false;assert.deepEqual(await registry.retry(owner),{released:0,failed:1,pending:1});assert.equal(ack,2);assert.equal(releases,1);
 deleteBlocked=false;assert.deepEqual(await registry.retry(owner),{released:1,failed:0,pending:0});assert.equal(ack,2);assert.equal(releases,2);
 await handle.attempt();assert.equal(releases,2,'a settled original permit cannot be released twice');
});

test('concurrent pumps join one original ACK/release and cannot replace its identity',async()=>{
 const registry=new PendingSealedCaptureRegistry();let ack=0,releases=0,resolveAck!:()=>void;
 const hold=new Promise<void>(resolve=>{resolveAck=resolve;});
 const input={identity,receipt,proof,acknowledge:async()=>{ack++;await hold;},release:async()=>{releases++;}};
 const handle=registry.retain(input);assert.equal(registry.retain({...input,release:async()=>assert.fail('original closure cannot be replaced')}),handle);
 assert.throws(()=>registry.retain({...input,receipt:{...receipt,manifestSha256:'e'.repeat(64)}}),/IDEMPOTENCY_CONFLICT/);
 const pending=[handle.attempt(),registry.retry(owner),registry.retry(owner)];assert.equal(ack,1);assert.equal(registry.count(owner),1);
 resolveAck();await Promise.all(pending);assert.equal(ack,1);assert.equal(releases,1);assert.equal(registry.count(owner),0);
});

test('wrong call or session empty proof cannot own a pending release',()=>{
 const registry=new PendingSealedCaptureRegistry(),input={identity,receipt,proof,acknowledge:async()=>assert.fail('not admitted'),release:async()=>assert.fail('not admitted')};
 assert.throws(()=>registry.retain({...input,proof:{...proof,sessionId:'foreign'}}),/IDENTITY_INVALID/);
 assert.throws(()=>registry.retain({...input,proof:{...proof,generation:2}}),/IDENTITY_INVALID/);
 assert.equal(registry.count(owner),0);
});

test('a bounded retry pass does not starve a ready receipt behind blocked peers',async()=>{
 const registry=new PendingSealedCaptureRegistry();let released=0;
 for(let i=0;i<4;i++)registry.retain({identity:{...identity,attemptId:'synthetic-attempt-'+i},receipt,proof,
  acknowledge:async()=>{if(i<3)throw Error('synthetic_peer_blocked');},release:async()=>{released++;}});
 assert.deepEqual(await registry.retry(owner),{released:0,failed:3,pending:4});
 assert.deepEqual(await registry.retry(owner),{released:1,failed:2,pending:3});assert.equal(released,1);
});
