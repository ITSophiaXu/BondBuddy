import { Pool } from 'pg';
import { claim, checkpoint, finish, renew, type Lease } from '@bondbuddy/api/queue';

export type Processor = (lease:Lease, tools:{ checkpoint:(stage:string,value:Record<string,unknown>)=>Promise<void>; renew:()=>Promise<void> })=>Promise<void>;

export async function runOnce(pool:Pool, processor:Processor, leaseSeconds=30) {
  const lease=await claim(pool,leaseSeconds);
  if(!lease)return false;
  const heartbeat=setInterval(()=>{void renew(pool,lease,leaseSeconds).catch(()=>clearInterval(heartbeat));},Math.max(1000,leaseSeconds*400));
  try {
    await processor(lease,{checkpoint:(stage,value)=>checkpoint(pool,lease,stage,value),renew:()=>renew(pool,lease,leaseSeconds)});
    // The synthetic seam cannot publish an artifact or a successful terminal state.
    await finish(pool,lease,'failed',{errorCode:'CAPABILITY_NOT_READY'});
  } catch(error) {
    // A process crash or expired lease leaves the durable checkpoint for recovery.
    if(error instanceof Error && error.message==='SYNTHETIC_CRASH')throw error;
    try { await finish(pool,lease,'failed',{errorCode:'DATA_UNAVAILABLE'}); } catch { /* another terminal state or lease owner won */ }
    throw error;
  } finally {clearInterval(heartbeat);}
  return true;
}

// Production has no processor until #16 provider reconciliation, #79 logs, and Word delivery are integrated.
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href) {
  if(process.env.BB_SYNTHETIC_QUEUE_TEST!=='1' || !process.env.DATABASE_URL) throw new Error('No production processor is installed');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try { await runOnce(pool,async (lease,tools)=>{await tools.checkpoint('synthetic',{step:'completed',attempt:lease.attempts});}); }
  finally {await pool.end();}
}
