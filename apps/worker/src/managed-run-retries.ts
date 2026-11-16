import type {Lease} from '@bondbuddy/api/queue';

/** A process-local barrier, not a TTL sweep. Only leases whose exact pipeline
 * returned retry may enter it. All claim-capable loops share the same barrier;
 * restart loses this authority and requires the existing cloud/session fence. */
export class ManagedRunRetries {
 private active=0;
 private readonly pending=new Map<string,Lease>();
 private flushing:Promise<void>|undefined;
 constructor(private readonly inventory:()=>Promise<number>,private readonly release:(lease:Lease)=>Promise<string>){}
 get pendingCount(){return this.pending.size;}
 enter(): (()=>void)|null {
  if(this.pending.size||this.flushing)return null;
  this.active++;let ended=false;
  return ()=>{if(!ended){ended=true;this.active--;}};
 }
 defer(lease:Lease){this.pending.set(lease.jobId,lease);}
 async flush(){
  if(this.flushing)return this.flushing;
  if(this.active||!this.pending.size)return;
  const work=async()=>{
   // No execution can enter while pending is nonempty, including during I/O.
   if(await this.inventory()!==0)return;
   for(const [id,lease] of this.pending){
    const result=await this.release(lease);
    if(result!=='blocked')this.pending.delete(id);
   }
  };
  this.flushing=work();
  try{await this.flushing;}finally{this.flushing=undefined;}
 }
}
