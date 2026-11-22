import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {executionNodeForPool} from '@bondbuddy/api/execution-capacity';
import type {DurableSpoolIdentity,DurableSpoolReceipt} from './durable-spool.js';
import type {TaskCallReleaseProof} from './task-execution.js';

type Owner={epoch:string;sessionId:string};
export type PendingSealedCaptureHandle={attempt():Promise<void>};
type Entry={key:string;identity:DurableSpoolIdentity;fingerprint:string;acknowledged:boolean;running?:Promise<void>;
 acknowledge():Promise<void>;release():Promise<void>;handle:PendingSealedCaptureHandle};

/** Process-local ownership of the original permit closure, never session adoption.
 * A crash loses this closure; the existing node/epoch Stop fence then owns recovery.
 * The durable spool remains the byte responsibility across either path. */
export class PendingSealedCaptureRegistry {
 private readonly entries=new Map<string,Entry>();
 retain(input:{identity:DurableSpoolIdentity;receipt:DurableSpoolReceipt;proof:TaskCallReleaseProof;
  acknowledge():Promise<void>;release():Promise<void>}):PendingSealedCaptureHandle{
  const {identity,receipt,proof}=input;
  if(proof.version!=='call_cgroup_v1'||!proof.sealed||proof.nativeProcesses!==0||proof.epoch!==identity.originalExecution.epoch||
   proof.sessionId!==identity.originalExecution.sessionId||proof.logicalCallId!==identity.logicalCallId||proof.generation!==identity.attemptNo||
   !/^[a-f0-9]{64}$/.test(receipt.spoolId)||!/^[a-f0-9]{64}$/.test(receipt.manifestSha256))throw Error('PENDING_SEALED_CAPTURE_IDENTITY_INVALID');
  const key=JSON.stringify([identity.originalExecution.sessionId,identity.originalExecution.epoch,identity.attemptId]);
  const fingerprint=createHash('sha256').update(JSON.stringify({identity,receipt,proof})).digest('hex'),prior=this.entries.get(key);
  if(prior){if(prior.fingerprint!==fingerprint)throw Error('PENDING_SEALED_CAPTURE_IDEMPOTENCY_CONFLICT');return prior.handle;}
  const entry:Entry={key,identity:structuredClone(identity),fingerprint,acknowledged:false,acknowledge:input.acknowledge,release:input.release,
   handle:{attempt:()=>{
    if(this.entries.get(key)!==entry)return Promise.resolve();
    if(entry.running)return entry.running;
    const attempt=(async()=>{
     // Preserve the exact original sealed ACK before invoking the exact original
     // permit's release. An uncertain ACK retries idempotently; an acknowledged
     // ACK is never resent when only the holder DELETE remains pending.
     if(!entry.acknowledged){await entry.acknowledge();entry.acknowledged=true;}
     await entry.release();this.entries.delete(key);
    })();
    entry.running=attempt;
    void attempt.finally(()=>{if(entry.running===attempt)entry.running=undefined;}).catch(()=>{});
    return attempt;
   }}};
  this.entries.set(key,entry);return entry.handle;
 }
 private owned(owner:Owner){return [...this.entries.values()].filter(e=>e.identity.originalExecution.epoch===owner.epoch&&e.identity.originalExecution.sessionId===owner.sessionId);}
 count(owner:Owner){return this.owned(owner).length;}
 async retry(owner:Owner,maxAttempts=3){
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw Error('PENDING_SEALED_CAPTURE_BUDGET_INVALID');
  let released=0,failed=0;
  for(const entry of this.owned(owner).slice(0,maxAttempts))try{await entry.handle.attempt();released++;}catch{
   failed++;
   // A blocked receipt must not occupy the head of every bounded pass.
   if(this.entries.get(entry.key)===entry){this.entries.delete(entry.key);this.entries.set(entry.key,entry);}
  }
  return {released,failed,pending:this.count(owner)};
 }
}

export const pendingSealedCaptures=new PendingSealedCaptureRegistry();
const ownerFor=(pool:Pool)=>{const c=executionNodeForPool(pool);return c?{epoch:c.identity.epoch,sessionId:c.session_id}:null;};
export function pendingSealedCaptureCount(pool:Pool){const owner=ownerFor(pool);return owner?pendingSealedCaptures.count(owner):0;}
export async function retryPendingSealedCaptures(pool:Pool){
 const owner=ownerFor(pool);return owner?pendingSealedCaptures.retry(owner):{released:0,failed:0,pending:0};
}
