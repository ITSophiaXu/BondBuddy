import {fileURLToPath} from 'node:url';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {azureBlobs,type PrivateBlobs} from '@bondbuddy/api/data';
import {registerRecoveredCaptureEvidence} from '@bondbuddy/api/queue';
import {withExecutionControlPool,executionNodeForPool} from '@bondbuddy/api/execution-capacity';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {FILE_AUTHORING_RECOVERY_LIMITS} from '@bondbuddy/contracts';
import {withPerformanceSpan,recordPerformanceInterval} from '@bondbuddy/api/performance-trace';
import {spoolPerformanceAttributes,withSpoolReceiptTrace} from './workflow-observability.js';
import {spawn,withBackgroundTaskExecution} from './task-execution.js';
import {durableSpoolRoot,flushDurableSpool,pendingDurableSpool,readDurableSpool,readDurableSpoolForGc,gcDurableSpoolReceipts,registerDurableSpoolReceipt,gcDurableSpool,deferDurableSpoolRetry,dueDurableSpoolReceipts,type DurableSpoolReceipt,type DurableSpoolManifest} from './durable-spool.js';

const MAX_CHILD_MS=120000,MAX_PASS_MS=300000,MAX_READ_BYTES=2*1024*1024;
const consumerFile=fileURLToPath(import.meta.url);
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function collectRegisteredDurableSpool(root:string,dependencies:{verify:(manifest:DurableSpoolManifest,receipt:DurableSpoolReceipt)=>Promise<boolean>;remove?:(directory:string)=>Promise<void>;pool?:Pool;now?:()=>number},assertLock:()=>void=()=>{}){
 let collected=0,failed=0;
 const now=dependencies.now??Date.now;
 for(const receipt of (await dueDurableSpoolReceipts(root,await gcDurableSpoolReceipts(root),now(),true)).slice(0,3)){
  try{
   assertLock();const manifest=await readDurableSpoolForGc(root,receipt);
   await deferDurableSpoolRetry(root,receipt,now(),true);
   const work=async()=>{
    if(!await withPerformanceSpan('spool.registration.verify',spoolPerformanceAttributes(manifest,receipt),async span=>{
     const valid=await dependencies.verify(manifest,receipt);if(!valid)span.end('failed',{error_code:'DURABLE_SPOOL_REGISTRATION_MISSING'});return valid;
    }))throw Error('DURABLE_SPOOL_REGISTRATION_MISSING');
    assertLock();await gcDurableSpool(receipt,{root,remove:dependencies.remove});collected++;
   };
   if(dependencies.pool)await withSpoolReceiptTrace(dependencies.pool,manifest,receipt,work);else await work();
  }catch{failed++;}
 }
 return {collected,failed};
}
type SpoolIoObservation={step_key:'spool.upload'|'spool.readback';started_at:string;ended_at:string;status:'succeeded'|'failed';object_ref:string;byte_size:number};
type SpoolIoStart=Omit<SpoolIoObservation,'ended_at'|'status'>;
type SpoolIoEvent={version:'durable-spool-io-v2';operation_id:string}&(SpoolIoStart&{event:'start'}|SpoolIoObservation&{event:'end'});
export async function observeSpoolIo<T>(observations:SpoolIoObservation[],step:'spool.upload'|'spool.readback',key:string,byteSize:number,work:()=>Promise<T>,emit?:(event:SpoolIoEvent)=>void):Promise<T>{
 const started_at=new Date().toISOString();let status:SpoolIoObservation['status']='failed';
 const start:SpoolIoStart={step_key:step,started_at,object_ref:sha(Buffer.from(key)),byte_size:byteSize},operation_id=randomUUID();
 emit?.({version:'durable-spool-io-v2',event:'start',operation_id,...start});
 try{const value=await work();status='succeeded';return value;}finally{
  const row={...start,ended_at:new Date().toISOString(),status};observations.push(row);
  emit?.({version:'durable-spool-io-v2',event:'end',operation_id,...row});
 }
}
const maxIoOperations=(FILE_AUTHORING_RECOVERY_LIMITS.files+1)*2,maxIoLineBytes=1024;
const utc=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function validIoStart(row:SpoolIoStart){
 return !!row&&['spool.upload','spool.readback'].includes(row.step_key)&&utc.test(row.started_at)&&Number.isFinite(Date.parse(row.started_at))&&
  /^[a-f0-9]{64}$/.test(row.object_ref)&&Number.isSafeInteger(row.byte_size)&&row.byte_size>=0&&row.byte_size<=FILE_AUTHORING_RECOVERY_LIMITS.totalBytes;
}
/** Bounded child start/end records survive SIGKILL; close is never an SDK end observation. */
class SpoolIoStream {
 private active=new Map<string,SpoolIoStart>();private seen=new Set<string>();private completed:SpoolIoObservation[]=[];
 private resultSeen=false;
 accept(line:string){
  if(Buffer.byteLength(line)>maxIoLineBytes)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
  const row=JSON.parse(line) as SpoolIoObservation&{version:string;event:string;operation_id:string;registered:number;failed:number};
  if(row.version!=='durable-spool-io-v2'||this.resultSeen)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
  if(row.event==='result'){
   if(!Number.isSafeInteger(row.registered)||row.registered<0||row.registered>1||!Number.isSafeInteger(row.failed)||row.failed<0||row.failed>1)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
   this.resultSeen=true;return;
  }
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(row.operation_id)||!validIoStart(row))throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
  if(row.event==='start'){
   if(this.seen.has(row.operation_id)||this.seen.size>=maxIoOperations)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
   this.seen.add(row.operation_id);this.active.set(row.operation_id,{step_key:row.step_key,started_at:row.started_at,object_ref:row.object_ref,byte_size:row.byte_size});return;
  }
  const start=this.active.get(row.operation_id);
  if(row.event!=='end'||!start||row.step_key!==start.step_key||row.started_at!==start.started_at||row.object_ref!==start.object_ref||row.byte_size!==start.byte_size||
   !['succeeded','failed'].includes(row.status)||!utc.test(row.ended_at)||!Number.isFinite(Date.parse(row.ended_at))||Date.parse(row.ended_at)<Date.parse(row.started_at))throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
  this.active.delete(row.operation_id);this.completed.push({...start,ended_at:row.ended_at,status:row.status});
 }
 finish(joinedAt:string,attributes:Record<string,unknown>){
  const failed=replaySpoolIoObservations(Buffer.from(JSON.stringify({version:'durable-spool-io-v1',observations:this.completed})),attributes);
  for(const row of this.active.values())recordPerformanceInterval(row.step_key,{startedAt:row.started_at,endedAt:new Date(Math.max(Date.parse(joinedAt),Date.parse(row.started_at))).toISOString(),clockSource:'wall_clock_observation',status:'interrupted'},
   {...attributes,measurement_source:'private_blob_parent_interruption',result_status:'unknown',event_kind:'child_close',error_code:'DURABLE_SPOOL_IO_COMPLETION_UNKNOWN',object_ref:row.object_ref,byte_size:row.byte_size});
  return failed||this.active.size>0||!this.resultSeen;
 }
}
/** Child output is bounded and never contains private object keys or credentials. */
export function replaySpoolIoObservations(bytes:Buffer,attributes:Record<string,unknown>={}){
 const body=JSON.parse(bytes.toString()) as {version?:unknown;observations?:unknown};
 if(body.version!=='durable-spool-io-v1'||!Array.isArray(body.observations)||body.observations.length>(FILE_AUTHORING_RECOVERY_LIMITS.files+1)*2)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
 for(const row of body.observations as SpoolIoObservation[]){
  if(!row||!['spool.upload','spool.readback'].includes(row.step_key)||!['succeeded','failed'].includes(row.status)||!utc.test(row.started_at)||!utc.test(row.ended_at)||
   !Number.isFinite(Date.parse(row.started_at))||!Number.isFinite(Date.parse(row.ended_at))||Date.parse(row.ended_at)<Date.parse(row.started_at)||
   !/^[a-f0-9]{64}$/.test(row.object_ref)||!Number.isSafeInteger(row.byte_size)||row.byte_size<0||row.byte_size>FILE_AUTHORING_RECOVERY_LIMITS.totalBytes)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
 }
 for(const row of body.observations as SpoolIoObservation[])recordPerformanceInterval(row.step_key,{startedAt:row.started_at,endedAt:row.ended_at,clockSource:'wall_clock_observation',status:row.status},
  {...attributes,measurement_source:'private_blob_child_observation',object_ref:row.object_ref,byte_size:row.byte_size});
 return (body.observations as SpoolIoObservation[]).some(row=>row.status==='failed');
}
/** An immutable, exact prior registration authorizes cleanup across sessions. */
export async function recoveredSpoolRegistrationRecorded(pool:Pool,manifest:DurableSpoolManifest,receipt:DurableSpoolReceipt){
 const identity=manifest.identity,capture=manifest.remoteCapture;
 if(!capture||!manifest.registrationId)return false;
 const input={ownerUserId:identity.ownerUserId,projectId:identity.projectId,runId:identity.runId,jobId:identity.jobId,
  attemptId:identity.attemptId,logicalCallId:identity.logicalCallId,attemptNo:identity.attemptNo,originalExecution:identity.originalExecution,
  capture,manifestSha256:receipt.manifestSha256};
 const query={text:`SELECT id FROM bb_recovered_capture_evidence WHERE id=$1 AND evidence_sha256=$2 AND manifest_sha256=$3
  AND owner_user_id=$4 AND project_id=$5 AND run_id=$6 AND job_id=$7 AND attempt_id=$8 AND capture_ref=$9 AND capture_sha256=$10 AND byte_size=$11`,
  values:[manifest.registrationId,inputManifestHash(input),receipt.manifestSha256,identity.ownerUserId,identity.projectId,identity.runId,identity.jobId,identity.attemptId,capture.key,capture.sha256,capture.byteSize],query_timeout:5000};
 const row=await pool.query(query);
 return row.rowCount===1;
}
export async function childCommand(args:string[],timeoutMs:number,options:{command?:string[];attributes?:Record<string,unknown>}={}):Promise<Buffer>{
 if(timeoutMs<1||timeoutMs>MAX_CHILD_MS)throw Error('DURABLE_SPOOL_CHILD_BUDGET_INVALID');
 return withBackgroundTaskExecution(()=>new Promise((resolveResult,reject)=>{
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',
   AZURE_STORAGE_CONNECTION_STRING:process.env.AZURE_STORAGE_CONNECTION_STRING,AZURE_STORAGE_CONTAINER:process.env.AZURE_STORAGE_CONTAINER,
   HTTPS_PROXY:process.env.HTTPS_PROXY,https_proxy:process.env.https_proxy,NO_PROXY:process.env.NO_PROXY,no_proxy:process.env.no_proxy};
  // No enrollment/DB/model identity enters this isolated IO process.
  const command=options.command??[process.execPath,consumerFile,...args];
  const child=spawn(command[0]!,command.slice(1),{env,detached:true,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const chunks:Buffer[]=[],observer=args[0]==='upload'?new SpoolIoStream():undefined;let bytes=0,timedOut=false,overLimit=false,spawnError=false,invalidIo=false,buffer='';
  const stop=()=>{try{child.kill('SIGKILL');}catch{ /* close still establishes process completion */ }};
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  child.stdout.on('data',(chunk:Buffer)=>{
   bytes+=chunk.length;if(bytes>MAX_READ_BYTES*2){overLimit=true;stop();return;}chunks.push(Buffer.from(chunk));
   if(!observer||invalidIo)return;
   try{
    buffer+=chunk.toString();let end:number;
    while((end=buffer.indexOf('\n'))>=0){observer.accept(buffer.slice(0,end));buffer=buffer.slice(end+1);}
    if(Buffer.byteLength(buffer)>maxIoLineBytes)throw Error('DURABLE_SPOOL_IO_TIMING_INVALID');
   }catch{invalidIo=true;stop();}
  });
  child.stderr.on('data',()=>{ /* Never emit SDK diagnostics containing private URLs or credentials. */ });
  child.once('error',()=>{spawnError=true;});
  child.once('close',code=>{
   clearTimeout(timer);
   // Only close joins the child and provides an upper bound for interrupted IO.
   const ioFailed=observer?.finish(new Date().toISOString(),options.attributes??{})??false;
   if(timedOut||overLimit||spawnError||invalidIo||buffer||ioFailed||code!==0)return reject(Error(timedOut?'DURABLE_SPOOL_CHILD_TIMEOUT':'DURABLE_SPOOL_CHILD_FAILED'));
   resolveResult(Buffer.concat(chunks));
  });
 }));
}

/** SDK IO belongs to killed-and-joined children. Only this registered pool records evidence. */
export async function unlockedSpoolPass(pool:Pool,root:string,assertLock:()=>void,dependencies:{now?:()=>number;register?:(manifest:DurableSpoolManifest,receipt:DurableSpoolReceipt,blobs:PrivateBlobs)=>Promise<{id:string}>}={}):Promise<{registered:number;failed:number;pending:number;gcPending:number}>{
 const started=(dependencies.now??Date.now)();let failed=0,registered=0,registrationAttempts=0;
 const now=dependencies.now??Date.now;
 const gc=await collectRegisteredDurableSpool(root,{pool,now,verify:(manifest,receipt)=>recoveredSpoolRegistrationRecorded(pool,manifest,receipt)},assertLock);failed+=gc.failed;
 const before=await pendingDurableSpool(root);
 for(const receipt of (await dueDurableSpoolReceipts(root,before.receipts,started)).slice(0,3)){
  if(Date.now()-started>=MAX_PASS_MS)break;
  let manifest=await readDurableSpool(receipt);
  try{
   await withSpoolReceiptTrace(pool,manifest,receipt,async()=>{
   assertLock();
   if(manifest.state==='SEALED_LOCAL')await withPerformanceSpan('spool.io',{},async span=>{
    await childCommand(['upload',resolve(root),receipt.directory,receipt.spoolId,receipt.manifestSha256],Math.min(MAX_CHILD_MS,MAX_PASS_MS-(Date.now()-started)),{attributes:spoolPerformanceAttributes(manifest,receipt,executionNodeForPool(pool))});
   });
   assertLock();manifest=await readDurableSpool(receipt);
   if(manifest.state!=='REMOTE_VERIFIED'||!manifest.remoteCapture||registrationAttempts>=3||Date.now()-started>=MAX_PASS_MS)return;
   registrationAttempts++;
   assertLock();await deferDurableSpoolRetry(root,receipt,now());
   const read=async(key:string,maxBytes:number)=>{
    if(key!==manifest.remoteCapture!.key||maxBytes<manifest.remoteCapture!.byteSize||manifest.remoteCapture!.byteSize>MAX_READ_BYTES)throw Error('DURABLE_SPOOL_CAPTURE_SCOPE_MISMATCH');
    const remaining=Math.min(MAX_CHILD_MS,MAX_PASS_MS-(Date.now()-started));
    return withPerformanceSpan('spool.readback',{object_ref:sha(Buffer.from(key)),byte_size:manifest.remoteCapture!.byteSize},async()=>{
     const bytes=await childCommand(['read-capture',resolve(root),receipt.directory,receipt.spoolId,receipt.manifestSha256],remaining);
     if(bytes.length!==manifest.remoteCapture!.byteSize||sha(bytes)!==manifest.remoteCapture!.sha256||bytes.length>maxBytes)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');return bytes;
    });
   };
   const proxy={get:(key:string)=>read(key,MAX_READ_BYTES),getIfExistsBounded:(key:string,max:number)=>read(key,max)} as PrivateBlobs;
   const identity=manifest.identity;
   const result=await withPerformanceSpan('spool.register',{},()=>dependencies.register?dependencies.register(manifest,receipt,proxy):registerRecoveredCaptureEvidence(pool,{ownerUserId:identity.ownerUserId,projectId:identity.projectId,
    runId:identity.runId,jobId:identity.jobId,attemptId:identity.attemptId,logicalCallId:identity.logicalCallId,attemptNo:identity.attemptNo,
    originalExecution:identity.originalExecution,capture:manifest.remoteCapture!,manifestSha256:receipt.manifestSha256},{blobs:proxy}));
   assertLock();await registerDurableSpoolReceipt(receipt,result.id);registered++;await gcDurableSpool(receipt,{root});
   });
  }catch{failed++;}
 }
 const after=await pendingDurableSpool(root);return {registered,failed,pending:after.pending,gcPending:after.gcPending};
}

/** Kernel flock is released on process death; there is no TTL-based adoption. */
export async function runDurableSpoolPass(pool:Pool,root=durableSpoolRoot()):Promise<{registered:number;failed:number;pending:number;gcPending:number}>{
 return withDurableSpoolPumpLock(root,assertLock=>withExecutionControlPool(pool,control=>unlockedSpoolPass(control,resolve(root),assertLock)),
  async()=>{const inventory=await pendingDurableSpool(root);return {registered:0,failed:0,pending:inventory.pending,gcPending:inventory.gcPending};});
}
export async function withDurableSpoolPumpLock<T>(root:string,work:(assertLock:()=>void)=>Promise<T>,busy:()=>Promise<T>):Promise<T>{
 root=resolve(root);await mkdir(root,{recursive:true,mode:0o700});
 const directory=await lstat(root);
 if(!directory.isDirectory()||directory.isSymbolicLink()||await realpath(root)!==root||process.platform!=='linux')throw Error('DURABLE_SPOOL_PUMP_ROOT_UNSAFE');
 const lockFile=join(root,'.pump.lock');
 const descriptor=await open(lockFile,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 try{const info=await descriptor.stat();if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0)throw Error('DURABLE_SPOOL_PUMP_LOCK_UNSAFE');}
 finally{await descriptor.close();}
 return withBackgroundTaskExecution(async()=>{
  const child=spawn('/usr/bin/flock',['-n','-E','75','-F',lockFile,process.execPath,'-e',
   'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
   {detached:true,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
  let code:number|null=null,lockClosed=false;
  const closed=new Promise<void>(resolveClose=>child.once('close',value=>{code=value;lockClosed=true;resolveClose();}));
  let buffer='';
  try{
   const acquired=await new Promise<boolean>((resolveLock,reject)=>{
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}reject(Error('DURABLE_SPOOL_PUMP_LOCK_TIMEOUT'));},5000);
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer==='locked\n'){clearTimeout(timer);resolveLock(true);}else if(buffer.length>64){clearTimeout(timer);reject(Error('DURABLE_SPOOL_PUMP_LOCK_INVALID'));}});
    child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(Error('DURABLE_SPOOL_PUMP_LOCK_UNAVAILABLE'));});
    child.once('close',value=>{clearTimeout(timer);if(value===75)resolveLock(false);else if(buffer!=='locked\n')reject(Error('DURABLE_SPOOL_PUMP_LOCK_UNAVAILABLE'));});
   });
   if(!acquired)return await busy();
   return await work(()=>{if(lockClosed)throw Error('DURABLE_SPOOL_PUMP_LOCK_LOST');});
  }finally{
   child.stdin.end();await closed;
   if(code!==0&&code!==75&&buffer==='locked\n')throw Error('DURABLE_SPOOL_PUMP_LOCK_EXIT_FAILED');
  }
 });
}

async function main(args:string[]){
 const timer=setTimeout(()=>process.exit(124),MAX_CHILD_MS);timer.unref();
 const [mode,root,...receiptFields]=args;
 if(!root||!isAbsolute(root)||!['upload','read-capture'].includes(mode??''))throw Error('DURABLE_SPOOL_CHILD_ARGUMENTS_INVALID');
 const connectionString=process.env.AZURE_STORAGE_CONNECTION_STRING;
 if(!connectionString)throw Error('DURABLE_SPOOL_STORAGE_UNAVAILABLE');
 const blobs=azureBlobs(connectionString,process.env.AZURE_STORAGE_CONTAINER??'bondbuddy-private');
 if(mode==='upload'){
  const [directory,spoolId,manifestSha256]=receiptFields,rel=directory&&relative(resolve(root),resolve(directory));
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('DURABLE_SPOOL_CAPTURE_SCOPE_MISMATCH');
  const receipt={directory:directory!,spoolId:spoolId!,manifestSha256:manifestSha256!},manifest=await readDurableSpool(receipt);
  const expected=new Map(manifest.files.map(file=>[file.key,{sha256:file.sha256,byteSize:file.byteSize}]));
  const observations:SpoolIoObservation[]=[];
  const emit=(event:SpoolIoEvent)=>{process.stdout.write(JSON.stringify(event)+'\n');};
  const result=await flushDurableSpool(root,{upload:(key,bytes)=>observeSpoolIo(observations,'spool.upload',key,bytes.length,()=>blobs.put(key,bytes,'application/octet-stream'),emit),
   readback:(key,max)=>observeSpoolIo(observations,'spool.readback',key,max,async()=>{
    const bytes=await blobs.getIfExistsBounded(key,max),e=expected.get(key),hash=e?.sha256??receipt.manifestSha256,size=e?.byteSize??max;
    if(!bytes||bytes.length!==size||sha(bytes)!==hash)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');return bytes;
   },emit),register:async()=>{throw Error('DURABLE_SPOOL_PARENT_REGISTRATION_REQUIRED');}},
   {maxAttempts:1,totalMs:MAX_CHILD_MS,receipt});
  process.stdout.write(JSON.stringify({version:'durable-spool-io-v2',event:'result',...result})+'\n');return;
 }
 const [directory,spoolId,manifestSha256]=receiptFields;
 const rel=directory&&relative(resolve(root),resolve(directory));
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('DURABLE_SPOOL_CAPTURE_SCOPE_MISMATCH');
 const receipt:DurableSpoolReceipt={directory:directory!,spoolId:spoolId!,manifestSha256:manifestSha256!};
 const manifest=await readDurableSpool(receipt);
 if(manifest.state!=='REMOTE_VERIFIED'||!manifest.remoteCapture||manifest.remoteCapture.byteSize>MAX_READ_BYTES)throw Error('DURABLE_SPOOL_CAPTURE_SCOPE_MISMATCH');
 const bytes=await blobs.getIfExistsBounded(manifest.remoteCapture.key,MAX_READ_BYTES);
 if(!bytes||bytes.length!==manifest.remoteCapture.byteSize||sha(bytes)!==manifest.remoteCapture.sha256)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');
 process.stdout.write(bytes);
}
if(process.argv[1]&&resolve(process.argv[1])===consumerFile){
 main(process.argv.slice(2)).catch(()=>{process.stderr.write('Durable spool IO failed; retained local responsibility.\n');process.exitCode=1;});
}
