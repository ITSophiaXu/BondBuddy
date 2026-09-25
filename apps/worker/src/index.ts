import { Pool } from 'pg';
import { claim, checkpoint, finish, promoteWordArtifact, renew, type Lease } from '@bondbuddy/api/queue';
import type { PrivateBlobs } from '@bondbuddy/api/data';

export type ProcessorResult={kind:'word_candidate';bytes:Buffer};
export type Processor = (lease:Lease, tools:{ checkpoint:(stage:string,value:Record<string,unknown>)=>Promise<void>; renew:()=>Promise<void> })=>Promise<void|ProcessorResult>;

export async function runOnce(pool:Pool, processor:Processor, leaseSeconds=30, blobs?:PrivateBlobs) {
  const lease=await claim(pool,leaseSeconds);
  if(!lease)return false;
  const heartbeat=setInterval(()=>{void renew(pool,lease,leaseSeconds).catch(()=>clearInterval(heartbeat));},Math.max(1000,leaseSeconds*400));
  try {
    const result=await processor(lease,{checkpoint:(stage,value)=>checkpoint(pool,lease,stage,value),renew:()=>renew(pool,lease,leaseSeconds)});
    if(result && result.kind==='word_candidate' && Buffer.isBuffer(result.bytes) && blobs){
      const delivered=await promoteWordArtifact(pool,lease,result.bytes,blobs);
      if(delivered.status==='available')await finish(pool,lease,'succeeded',{artifactId:delivered.artifactId,artifactVersion:delivered.artifactVersion,blobs});
      else await finish(pool,lease,'failed',{errorCode:delivered.failureCode});
    }else{
      // No installed processor is allowed to turn a checkpoint or an unchecked result into success.
      await finish(pool,lease,'failed',{errorCode:'CAPABILITY_NOT_READY'});
    }
  } catch(error) {
    // A process crash or expired lease leaves the durable checkpoint for recovery.
    if(error instanceof Error && error.message==='SYNTHETIC_CRASH')throw error;
    try { await finish(pool,lease,'failed',{errorCode:'DATA_UNAVAILABLE'}); } catch { /* another terminal state or lease owner won */ }
    throw error;
  } finally {clearInterval(heartbeat);}
  return true;
}

// Synthetic one-shot helper kept for the queue tests. The production entrypoint is runtime.ts (#17).
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href) {
  if(process.env.BB_SYNTHETIC_QUEUE_TEST!=='1' || !process.env.DATABASE_URL) throw new Error('No production processor is installed');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try { await runOnce(pool,async (lease,tools)=>{await tools.checkpoint('synthetic',{step:'completed',attempt:lease.attempts});}); }
  finally {await pool.end();}
}
