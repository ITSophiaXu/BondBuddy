import {fileURLToPath} from 'node:url';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {azureBlobs,type PrivateBlobs} from '@bondbuddy/api/data';
import {registerRecoveredCaptureEvidence} from '@bondbuddy/api/queue';
import {spawn,withBackgroundTaskExecution} from './task-execution.js';
import {durableSpoolRoot,flushDurableSpool,pendingDurableSpool,readDurableSpool,registerDurableSpoolReceipt,gcDurableSpool,type DurableSpoolReceipt} from './durable-spool.js';

const MAX_CHILD_MS=120000,MAX_PASS_MS=300000,MAX_READ_BYTES=2*1024*1024;
const consumerFile=fileURLToPath(import.meta.url);
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function childCommand(args:string[],timeoutMs:number):Promise<Buffer>{
 if(timeoutMs<1||timeoutMs>MAX_CHILD_MS)throw Error('DURABLE_SPOOL_CHILD_BUDGET_INVALID');
 return withBackgroundTaskExecution(()=>new Promise((resolveResult,reject)=>{
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',
   AZURE_STORAGE_CONNECTION_STRING:process.env.AZURE_STORAGE_CONNECTION_STRING,AZURE_STORAGE_CONTAINER:process.env.AZURE_STORAGE_CONTAINER,
   HTTPS_PROXY:process.env.HTTPS_PROXY,https_proxy:process.env.https_proxy,NO_PROXY:process.env.NO_PROXY,no_proxy:process.env.no_proxy};
  // No enrollment/DB/model identity enters this isolated IO process.
  const child=spawn(process.execPath,[consumerFile,...args],{env,detached:true,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const chunks:Buffer[]=[];let bytes=0,timedOut=false,overLimit=false,spawnError=false;
  const stop=()=>{try{child.kill('SIGKILL');}catch{ /* close still establishes process completion */ }};
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_READ_BYTES*2){overLimit=true;stop();}else chunks.push(Buffer.from(chunk));});
  child.stderr.on('data',()=>{ /* Never emit SDK diagnostics containing private URLs or credentials. */ });
  child.once('error',()=>{spawnError=true;});
  child.once('close',code=>{
   clearTimeout(timer);
   if(timedOut||overLimit||spawnError||code!==0)return reject(Error(timedOut?'DURABLE_SPOOL_CHILD_TIMEOUT':'DURABLE_SPOOL_CHILD_FAILED'));
   resolveResult(Buffer.concat(chunks));
  });
 }));
}

/** SDK IO belongs to killed-and-joined children. Only this registered pool records evidence. */
async function unlockedSpoolPass(pool:Pool,root:string,assertLock:()=>void):Promise<{registered:number;failed:number;pending:number}>{
 const started=Date.now();let failed=0,registered=0,registrationAttempts=0;
 const before=await pendingDurableSpool(root),due=new Set<string>();
 for(const receipt of before.receipts)if(Date.parse((await readDurableSpool(receipt)).nextDueAt)<=started)due.add(receipt.spoolId);
 assertLock();
 try{await childCommand(['upload',resolve(root)],MAX_CHILD_MS);}catch{failed++;}
 assertLock();
 const inventory=await pendingDurableSpool(root);
 for(const receipt of inventory.receipts){
  const manifest=await readDurableSpool(receipt);
  if(manifest.state!=='REMOTE_VERIFIED'||!manifest.remoteCapture||!due.has(receipt.spoolId)||
    registrationAttempts>=3||Date.now()-started>=MAX_PASS_MS)continue;
  registrationAttempts++;
  try{
   assertLock();
   const read=async(key:string,maxBytes:number)=>{
    if(key!==manifest.remoteCapture!.key||maxBytes<manifest.remoteCapture!.byteSize||manifest.remoteCapture!.byteSize>MAX_READ_BYTES)throw Error('DURABLE_SPOOL_CAPTURE_SCOPE_MISMATCH');
    const remaining=Math.min(MAX_CHILD_MS,MAX_PASS_MS-(Date.now()-started));
    const bytes=await childCommand(['read-capture',resolve(root),receipt.directory,receipt.spoolId,receipt.manifestSha256],remaining);
    if(bytes.length!==manifest.remoteCapture!.byteSize||sha(bytes)!==manifest.remoteCapture!.sha256||bytes.length>maxBytes)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');
    return bytes;
   };
   const proxy={get:(key:string)=>read(key,MAX_READ_BYTES),getIfExistsBounded:(key:string,max:number)=>read(key,max)} as PrivateBlobs;
   const identity=manifest.identity;
   const result=await registerRecoveredCaptureEvidence(pool,{ownerUserId:identity.ownerUserId,projectId:identity.projectId,
    runId:identity.runId,jobId:identity.jobId,attemptId:identity.attemptId,logicalCallId:identity.logicalCallId,attemptNo:identity.attemptNo,
    originalExecution:identity.originalExecution,capture:manifest.remoteCapture,manifestSha256:receipt.manifestSha256},{blobs:proxy});
   assertLock();await registerDurableSpoolReceipt(receipt,result.id);await gcDurableSpool(receipt);registered++;
  }catch{failed++;}
 }
 return {registered,failed,pending:(await pendingDurableSpool(root)).pending};
}

/** Kernel flock is released on process death; there is no TTL-based adoption. */
export async function runDurableSpoolPass(pool:Pool,root=durableSpoolRoot()):Promise<{registered:number;failed:number;pending:number}>{
 return withDurableSpoolPumpLock(root,assertLock=>unlockedSpoolPass(pool,resolve(root),assertLock),
  async()=>({registered:0,failed:0,pending:(await pendingDurableSpool(root)).pending}));
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
  const result=await flushDurableSpool(root,{upload:(key,bytes)=>blobs.put(key,bytes,'application/octet-stream'),
   readback:(key,max)=>blobs.getIfExistsBounded(key,max),register:async()=>{throw Error('DURABLE_SPOOL_PARENT_REGISTRATION_REQUIRED');}},
   {maxAttempts:3,totalMs:MAX_CHILD_MS});
  process.stdout.write(JSON.stringify(result));return;
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
