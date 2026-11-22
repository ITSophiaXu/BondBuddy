import {readFile} from 'node:fs/promises';

const SAMPLE_INTERVAL_MS=1000;

/** Observes the shared worker cgroup while one claimed job is executing. */
export function sampleRunMemory(options:{readMemory?:()=>Promise<number>;intervalMs?:number}={}){
 const readMemory=options.readMemory??(async()=>Number((await readFile('/sys/fs/cgroup/memory.current','utf8')).trim()));
 let peak:number|null=null,samples=0,errors=0,stopped=false,pending:Promise<void>|null=null;
 const sample=()=>{
  if(pending)return pending;
  pending=(async()=>{
   try{const bytes=await readMemory();if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('INVALID_MEMORY_SAMPLE');
    peak=Math.max(peak??0,bytes);samples++;
   }catch{errors++;}
  })().finally(()=>{pending=null;});
  return pending;
 };
 void sample();
 const timer=setInterval(()=>{if(!stopped)void sample();},options.intervalMs??SAMPLE_INTERVAL_MS);
 timer.unref();
 return {async stop(){
  if(!stopped){stopped=true;clearInterval(timer);if(pending)await pending;await sample();}
  return {resource_scope:'shared_worker_container',resource_availability:peak===null?'unavailable':'cgroup_v2',
   cgroup_memory_peak_bytes:peak,resource_sample_count:samples,resource_sample_error_count:errors};
 }};
}
