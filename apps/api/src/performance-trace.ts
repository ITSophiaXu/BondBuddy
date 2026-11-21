import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PERFORMANCE_ATTRIBUTE_CODES,PERFORMANCE_ATTRIBUTE_COUNTS,PERFORMANCE_ATTRIBUTE_FLAGS,type PerformanceAttributes,type PerformanceSpan,type PerformanceSession,type PerformanceSpanStatus} from '@bondbuddy/contracts';
import {createPerformanceBatchWriter} from './performance-store.js';

export interface PerformanceTraceScope {
 ownerUserId:string;projectId:string;runId:string;jobId?:string;traceId?:string;taskKind?:string;runExecutionId?:string;
 serviceRole?:string;workerInstanceId?:string;releaseSha?:string;imageDigest?:string;hostId?:string;processSessionId?:string;batchId?:string;groupId?:string;workItemId?:string;itemAttempt?:number;
}
export type PerformanceInterval={startedAt:string|Date;endedAt:string|Date;clockSource:'database_event_interval'|'wall_clock_observation';status?:PerformanceEndStatus};
export interface PerformanceObservation {stepKey:string;interval:PerformanceInterval;attributes?:PerformanceInputAttributes}
export type PerformanceInputAttributes=Readonly<Record<string,unknown>>;
export type PerformanceEndStatus=Exclude<PerformanceSpanStatus,'running'>;
export interface PerformanceSpanHandle {
 readonly spanId:string|null;
 end(status?:PerformanceEndStatus,attributes?:PerformanceInputAttributes):void;
 annotate(attributes:PerformanceInputAttributes):void;
}
export type PerformanceSessionRecord=PerformanceSession&{owner_user_id:string;project_id:string;run_id:string;job_id:string|null;trace_id:string;task_kind:string};
export type PerformanceSpanRecord=PerformanceSpan&{owner_user_id:string;sequence:number};
export type PerformanceBatchWriter=(sessions:PerformanceSessionRecord[],spans:PerformanceSpanRecord[])=>Promise<void>;
interface SessionState {row:PerformanceSessionRecord;finalAck:Set<string>;dropped:Set<string>;attempts:number;open:number}
interface Context {runtime:PerformanceTraceRuntime;session:SessionState;span:PerformanceSpanRecord;handle:PerformanceSpanHandle}
const context=new AsyncLocalStorage<Context|undefined>();
const processSessionId=randomUUID();
const safeId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const safeCode=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const codes=new Set<string>(PERFORMANCE_ATTRIBUTE_CODES),counts=new Set<string>(PERFORMANCE_ATTRIBUTE_COUNTS),flags=new Set<string>(PERFORMANCE_ATTRIBUTE_FLAGS);
const terminal=new Set<PerformanceEndStatus>(['succeeded','failed','cancelled','paused','reused','interrupted']);
const noop:PerformanceSpanHandle=Object.freeze({spanId:null,end(){},annotate(){}});
export function sanitizePerformanceAttributes(input:PerformanceInputAttributes):{attributes:PerformanceAttributes;links:string[];invalid:number}{
 const attributes:PerformanceAttributes={},links:string[]=[];let invalid=0;
 try{
  for(const [key,value] of Object.entries(input).slice(0,96)){
   if(key==='span_links'){if(Array.isArray(value)){for(const id of value.slice(0,16))if(safeId(id))links.push(id);else invalid++;invalid+=Math.max(0,value.length-16);}else invalid++;continue;}
   if(codes.has(key)&&safeCode(value)||counts.has(key)&&(value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0)||flags.has(key)&&typeof value==='boolean'||key==='ttft_ms'&&(value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0))attributes[key]=value as string|number|boolean|null;
   else invalid++;
  }
  invalid+=Math.max(0,Object.keys(input).length-96);
  if(JSON.stringify(attributes).length>6000){for(const key of Object.keys(attributes).slice(24)){delete attributes[key];invalid++;}}
 }catch{invalid++;}
 return {attributes,links:[...new Set(links)],invalid};
}
export class PerformanceTraceRuntime {
 private pending=new Map<string,PerformanceSpanRecord>();
 private sessions=new Map<string,SessionState>();
 private timer:ReturnType<typeof setTimeout>|undefined;
 private active:Promise<void>|undefined;
 private retryDelay=500;
 private readonly maxPending:number;private readonly maxSessions:number;private readonly maxSpans:number;private readonly batchSize:number;
 constructor(private readonly writer:PerformanceBatchWriter,options:{maxPending?:number;maxSessions?:number;maxSpans?:number;batchSize?:number}={}){
  this.maxPending=options.maxPending??1024;this.maxSessions=options.maxSessions??128;this.maxSpans=options.maxSpans??10000;this.batchSize=options.batchSize??100;
 }
 private touch(s:SessionState){
  if(!this.sessions.has(s.row.session_id)&&this.sessions.size>=this.maxSessions){for(const [id,p] of this.pending)if(p.session_id===s.row.session_id)this.pending.delete(id);return;}
  this.sessions.set(s.row.session_id,s);this.schedule();
 }
 private schedule(){if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},this.retryDelay);this.timer.unref();}}
 private drop(s:SessionState,id:string){if(!s.dropped.has(id)){s.dropped.add(id);s.row.dropped++;s.row.last_sequence++;}}
 private push(s:SessionState,span:PerformanceSpanRecord){
  span.sequence=++s.row.last_sequence;
  if(this.pending.has(span.span_id)||this.pending.size<this.maxPending)this.pending.set(span.span_id,structuredClone(span));
  else this.drop(s,span.span_id);
  this.touch(s);
 }
 private make(s:SessionState,parent:PerformanceSpanRecord|undefined,key:string,input:PerformanceInputAttributes,interval?:PerformanceInterval):{span:PerformanceSpanRecord;handle:PerformanceSpanHandle}|null{
  if(!/^[a-z][a-z0-9_.]{0,127}$/.test(key)){s.row.invalid_attributes++;this.touch(s);return null;}
  s.row.generated++;
  if(s.row.generated>this.maxSpans){s.row.dropped++;s.row.last_sequence++;this.touch(s);return null;}
  const inherited=parent?Object.fromEntries(Object.entries(parent.attributes).filter(([k])=>['chapter_id','spool_id','execution_node_id','execution_node_epoch','execution_session_id','original_execution_node_epoch','original_execution_session_id','lease_token_sha256','logical_call_id','parent_logical_call_id','author_run_id','call_id','attempt_no','model_id','model_provider','adapter','model_config_version','batch_id','group_id','work_item_id','item_attempt','repair_round','batch_index','material_index'].includes(k))):{};
  const clean=sanitizePerformanceAttributes({...inherited,...input});s.row.invalid_attributes+=clean.invalid;
  const now=new Date().toISOString(),start=interval?new Date(interval.startedAt).toISOString():now,end=interval?new Date(interval.endedAt).toISOString():null;
  const elapsed=end?Date.parse(end)-Date.parse(start):null;
  if(elapsed!==null&&(elapsed<0||interval?.status!==undefined&&!terminal.has(interval.status))){s.row.dropped++;s.row.invalid_attributes++;this.touch(s);return null;}
  const t0=process.hrtime.bigint();
  const span:PerformanceSpanRecord={span_id:randomUUID(),owner_user_id:s.row.owner_user_id,session_id:s.row.session_id,run_execution_id:s.row.run_execution_id,
   run_id:s.row.run_id,job_id:s.row.job_id,trace_id:s.row.trace_id,parent_span_id:parent?.span_id??null,
   stage:typeof clean.attributes.stage==='string'?clean.attributes.stage:parent?.stage??null,step_key:key,step_version:1,
   status:end?(interval?.status??'succeeded'):'running',started_at:start,ended_at:end,duration_ms:elapsed,last_activity_at:end??now,
   clock_source:interval?interval.clockSource:'monotonic',attributes:clean.attributes,span_links:clean.links,sequence:0};
  let finished=!!end;s.open+=finished?0:1;
  const annotate=(attrs:PerformanceInputAttributes)=>{
   if(finished)return;const c=sanitizePerformanceAttributes(attrs);s.row.invalid_attributes+=c.invalid;
   Object.assign(span.attributes,c.attributes);span.span_links=[...new Set([...span.span_links,...c.links])].slice(0,16);span.last_activity_at=new Date().toISOString();this.push(s,span);
  };
  const handle:PerformanceSpanHandle={spanId:span.span_id,annotate(attrs){try{annotate(attrs);}catch{}},
   end:(status='succeeded',attrs={})=>{try{if(finished)return;annotate(attrs);finished=true;s.open--;
    span.status=terminal.has(status)?status:'interrupted';
    span.duration_ms=Number(process.hrtime.bigint()-t0)/1e6;
    // A wall-clock adjustment must not invalidate a correctly measured monotonic interval.
    span.ended_at=new Date(Math.max(Date.parse(span.started_at),Date.now())).toISOString();span.last_activity_at=span.ended_at;this.push(s,span);
   }catch{}}
  };
  this.push(s,span);return {span,handle};
 }
 private session(scope:PerformanceTraceScope):SessionState {
  const now=new Date().toISOString(),runExecutionId=safeId(scope.runExecutionId)?scope.runExecutionId:randomUUID();
  const s:SessionState={row:{session_id:randomUUID(),run_execution_id:runExecutionId,owner_user_id:scope.ownerUserId,project_id:scope.projectId,run_id:scope.runId,job_id:scope.jobId??null,trace_id:scope.runId,
    task_kind:safeCode(scope.taskKind)?scope.taskKind:'unknown',service_role:safeCode(scope.serviceRole)?scope.serviceRole:null,worker_instance_id:safeId(scope.workerInstanceId)?scope.workerInstanceId:null,release_sha:safeCode(scope.releaseSha??process.env.BB_RELEASE_SHA)?(scope.releaseSha??process.env.BB_RELEASE_SHA)!:null,
    started_at:now,ended_at:null,last_flush_at:null,closed:false,generated:0,acknowledged:0,dropped:0,invalid_attributes:0,flush_errors:0,last_sequence:0,complete:false,purged_at:null,purged_span_count:0,purge_reason:null,purge_policy_version:null},finalAck:new Set(),dropped:new Set(),attempts:0,open:0};
  this.touch(s);return s;
 }
 private scopeAttributes(scope:PerformanceTraceScope):PerformanceInputAttributes {
  return Object.fromEntries(Object.entries({batch_id:scope.batchId,group_id:scope.groupId,work_item_id:scope.workItemId,item_attempt:scope.itemAttempt,image_digest:scope.imageDigest,host_id:scope.hostId,process_session_id:scope.processSessionId??processSessionId}).filter(([,value])=>value!==undefined));
 }
 /** Completed observations have no synthetic worker-execution span and never await storage. */
 observe(scope:PerformanceTraceScope,observations:ReadonlyArray<PerformanceObservation>):void {
  try{
   if(![scope.ownerUserId,scope.projectId,scope.runId].every(safeId)||scope.jobId!==undefined&&!safeId(scope.jobId)||scope.traceId!==undefined&&scope.traceId!==scope.runId||this.sessions.size>=this.maxSessions)return;
   const s=this.session(scope);
   for(const o of observations){try{this.make(s,undefined,o.stepKey,{...this.scopeAttributes(scope),...o.attributes},o.interval);}catch{s.row.invalid_attributes++;s.row.dropped++;}}
   s.row.closed=true;s.row.ended_at=new Date().toISOString();s.row.last_sequence++;this.touch(s);
  }catch{}
 }
 async trace<T>(scope:PerformanceTraceScope,fn:(span:PerformanceSpanHandle)=>T|Promise<T>):Promise<T>{
  if(![scope.ownerUserId,scope.projectId,scope.runId].every(safeId)||scope.jobId!==undefined&&!safeId(scope.jobId)||scope.traceId!==undefined&&scope.traceId!==scope.runId||this.sessions.size>=this.maxSessions)return context.run(undefined,()=>fn(noop));
  let made:{span:PerformanceSpanRecord;handle:PerformanceSpanHandle}|null=null,s:SessionState|undefined;
  try{
   s=this.session(scope);
   const attrs=this.scopeAttributes(scope);
   made=this.make(s,undefined,'run.execution',attrs);
  }catch{}
  if(!made||!s)return context.run(undefined,()=>fn(noop));
  const session=s,entry=made;
  try{return await context.run({runtime:this,session,span:entry.span,handle:entry.handle},async()=>{
   try{const result=await fn(entry.handle);entry.handle.end();return result;}catch(error){entry.handle.end('failed');throw error;}
  });}finally{try{session.row.closed=true;session.row.ended_at=new Date().toISOString();session.row.last_sequence++;this.touch(session);}catch{}}
 }
 start(key:string,attrs:PerformanceInputAttributes={}):{span:PerformanceSpanRecord;handle:PerformanceSpanHandle}|null{
  const c=context.getStore();if(!c)return null;try{return this.make(c.session,c.span,key,attrs);}catch{return null;}
 }
 interval(key:string,interval:PerformanceInterval,attrs:PerformanceInputAttributes={}){
  const c=context.getStore();if(!c)return;try{this.make(c.session,undefined,key,attrs,interval);}catch{c.session.row.invalid_attributes++;c.session.row.dropped++;this.touch(c.session);}
 }
 async flush():Promise<void>{
  if(this.active)return this.active;
  if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
  if(!this.sessions.size&&!this.pending.size)return;
  this.active=(async()=>{
   const batch=[...this.pending.values()].slice(0,this.batchSize),states=[...this.sessions.values()];
   const stamp=new Date().toISOString();
   const receipts=states.map(s=>{
    const acknowledged=new Set([...s.finalAck,...batch.filter(b=>b.session_id===s.row.session_id&&b.ended_at!==null).map(b=>b.span_id)]).size;
    return {...s.row,last_flush_at:stamp,acknowledged,complete:s.row.closed&&s.open===0&&acknowledged===s.row.generated&&s.row.dropped===0&&s.row.invalid_attributes===0&&s.row.flush_errors===0};
   });
   try{
    await this.writer(receipts,batch);this.retryDelay=500;
    for(const span of batch){const current=this.pending.get(span.span_id);if(current?.sequence===span.sequence)this.pending.delete(span.span_id);
     const s=this.sessions.get(span.session_id);if(s&&span.ended_at)s.finalAck.add(span.span_id);}
    for(const s of states){s.row.acknowledged=s.finalAck.size;s.row.last_flush_at=stamp;s.attempts=0;
     const sent=receipts.find(r=>r.session_id===s.row.session_id)!;
     if(s.row.closed&&!batch.some(b=>this.pending.has(b.span_id)&&b.session_id===s.row.session_id)&&![...this.pending.values()].some(b=>b.session_id===s.row.session_id)&&sent.last_sequence===s.row.last_sequence)this.sessions.delete(s.row.session_id);
    }
   }catch{
    this.retryDelay=Math.min(30000,this.retryDelay*2);
    for(const s of states){s.row.flush_errors++;s.row.last_sequence++;s.attempts++;}
    for(const span of batch){const s=this.sessions.get(span.session_id);if(s&&s.attempts>=3){this.drop(s,span.span_id);this.pending.delete(span.span_id);}}
    // A permanently invalid/unreachable session must not poison later telemetry.
    // If the final receipt cannot be stored, earlier open rows remain visibly incomplete.
    for(const s of states)if(s.attempts>=5){for(const [key,p] of this.pending)if(p.session_id===s.row.session_id)this.pending.delete(key);this.sessions.delete(s.row.session_id);}
   }
  })().catch(()=>{}).finally(()=>{this.active=undefined;if(this.sessions.size||this.pending.size)this.schedule();});
  return this.active;
 }
 async drain(timeoutMs=2000):Promise<void>{
  const end=Date.now()+Math.max(0,Math.min(10000,timeoutMs));
  while((this.sessions.size||this.pending.size||this.active)&&Date.now()<end){
   await Promise.race([this.flush(),new Promise<void>(resolve=>{const t=setTimeout(resolve,Math.max(1,end-Date.now()));t.unref();})]);
   if(this.retryDelay>500)break;
  }
 }
}
const runtimes=new WeakMap<Pool,PerformanceTraceRuntime>();
function runtime(pool:Pool){let r=runtimes.get(pool);if(!r){r=new PerformanceTraceRuntime(createPerformanceBatchWriter(pool));runtimes.set(pool,r);}return r;}
export async function withPerformanceTrace<T>(pool:Pool,scope:PerformanceTraceScope,fn:(span:PerformanceSpanHandle)=>T|Promise<T>):Promise<T>{
 let r:PerformanceTraceRuntime;try{r=runtime(pool);}catch{return fn(noop);}return r.trace(scope,fn);
}
export function startPerformanceSpan(key:string,attrs:PerformanceInputAttributes={}):PerformanceSpanHandle{return context.getStore()?.runtime.start(key,attrs)?.handle??noop;}
export async function withPerformanceSpan<T>(key:string,attrs:PerformanceInputAttributes,fn:(span:PerformanceSpanHandle)=>T|Promise<T>):Promise<T>{
 const c=context.getStore(),entry=c?.runtime.start(key,attrs);if(!c||!entry)return fn(noop);
 return context.run({...c,span:entry.span,handle:entry.handle},async()=>{try{const value=await fn(entry.handle);entry.handle.end();return value;}catch(error){entry.handle.end('failed');throw error;}});
}
export function currentPerformanceSpanId(){return context.getStore()?.span.span_id??null;}
export function recordPerformanceInterval(key:string,interval:PerformanceInterval,attrs:PerformanceInputAttributes={}):void{
 if(['database_event_interval','wall_clock_observation'].includes(interval.clockSource))context.getStore()?.runtime.interval(key,interval,attrs);
}
export async function flushPerformanceTraces(pool:Pool,timeoutMs=2000):Promise<void>{try{await runtimes.get(pool)?.drain(timeoutMs);}catch{}}

export function recordPerformanceObservations(pool:Pool,scope:PerformanceTraceScope,observations:ReadonlyArray<PerformanceObservation>):void {try{runtime(pool).observe(scope,observations);}catch{}}
