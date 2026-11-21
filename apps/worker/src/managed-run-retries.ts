import type {Lease} from '@bondbuddy/api/queue';

/** Exact execution receipts only, never a TTL sweep. Sealed task containment,
 * not unrelated active work, proves release. Restart still loses authority. */
export class ManagedRunRetries {
 private readonly pending=new Map<string,Lease>();
 private readonly flushing=new Map<string,Promise<void>>();
 constructor(private readonly inventory:(lease:Lease)=>Promise<number>,private readonly release:(lease:Lease)=>Promise<string>){}
 get pendingCount(){return this.pending.size;}
 enter():()=>void {return ()=>{};}
 defer(lease:Lease){const key=JSON.stringify([lease.jobId,lease.token]);if(!this.pending.has(key))this.pending.set(key,lease);}
 async flush(){
  const results=await Promise.allSettled([...this.pending].map(([key,lease])=>{
   const running=this.flushing.get(key);if(running)return running;
   const work=Promise.resolve().then(async()=>{
    if(await this.inventory(lease)!==0)return;
    const result=await this.release(lease);
    if(result!=='blocked'&&this.pending.get(key)===lease)this.pending.delete(key);
   }).finally(()=>{this.flushing.delete(key);});
   this.flushing.set(key,work);return work;
  }));
  const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
  if(errors.length)throw new AggregateError(errors,'TASK_RETRY_RELEASE_BLOCKED');
 }
}
