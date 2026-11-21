import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,rename,rm,statfs} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {FILE_AUTHORING_RECOVERY_LIMITS} from '@bondbuddy/contracts';
import type {ProviderUsage} from '@bondbuddy/api/provider-results';
import type {TaskCallReleaseProof} from './task-execution.js';

const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safePath=(value:string)=>value.length<=1024&&!/[\\:\x00-\x1f\x7f]/.test(value)&&value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p));
const within=(root:string,path:string)=>{const rel=relative(resolve(root),resolve(path));return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel);};
export type DurableSpoolIdentity={ownerUserId:string;projectId:string;runId:string;jobId:string;attemptId:string;
 logicalCallId:string;attemptNo:number;leaseToken:string;inputHash:string;planHash:string|null;
 originalExecution:{nodeId:string;epoch:string;sessionId:string}};
export type DurableSpoolManifest={version:'durable-spool-v1';spoolId:string;identity:DurableSpoolIdentity;
 exitProof:TaskCallReleaseProof;usage:ProviderUsage;outcome:string;deadlineAt:string|null;sealedAt:string;
 files:{path:string;sha256:string;byteSize:number;key:string}[];
 state:'SEALED_LOCAL'|'REMOTE_VERIFIED'|'REGISTERED'|'GC_ELIGIBLE';attempts:number;nextDueAt:string;
 remoteCapture:{key:string;sha256:string;byteSize:number}|null;registrationId:string|null};
export type DurableSpoolReceipt={directory:string;spoolId:string;manifestSha256:string};

export function durableSpoolRoot(workRoot=process.env.BB_CODEX_WORK_ROOT??'/tmp/bondbuddy-codex'){
 return resolve(process.env.BB_DURABLE_SPOOL_ROOT??join(workRoot,'spool'));
}
/** Pin an incomplete capture without claiming files are sealed or native is empty. */
export async function retainUnsealedDurableSpool(root:string,sourceDir:string){
 root=resolve(root);sourceDir=resolve(sourceDir);
 const rootInfo=await privateDirectory(root,true),sourceInfo=await privateDirectory(sourceDir);
 if(rootInfo.dev!==sourceInfo.dev)throw Error('DURABLE_SPOOL_REQUIRES_SAME_DURABLE_VOLUME');
 const directory=join(root,'unsealed',hash(sourceDir));await privateDirectory(directory,true);
 await atomicJson(join(directory,'capture-pending.json'),{version:'unsealed-native-pending-v1',sourceDir,
  reason:'native_or_capture_incomplete',createdAt:new Date().toISOString()});
}
function validateIdentity(identity:DurableSpoolIdentity){
 if(!identity||![identity.ownerUserId,identity.projectId,identity.runId,identity.jobId,identity.attemptId,identity.logicalCallId,identity.leaseToken,
  identity.originalExecution?.nodeId,identity.originalExecution?.epoch,identity.originalExecution?.sessionId].every(id)||
  !Number.isSafeInteger(identity.attemptNo)||identity.attemptNo<1||!sha(identity.inputHash)||identity.planHash!==null&&!sha(identity.planHash))
  throw Error('DURABLE_SPOOL_IDENTITY_INVALID');
}
function captureEnvelope(manifest:DurableSpoolManifest){
 // Mutable retry state never changes the identity of the sealed capture.
 return {version:manifest.version,spoolId:manifest.spoolId,identity:manifest.identity,exitProof:manifest.exitProof,
  usage:manifest.usage,outcome:manifest.outcome,deadlineAt:manifest.deadlineAt,sealedAt:manifest.sealedAt,files:manifest.files};
}
export function durableSpoolManifestSha256(manifest:DurableSpoolManifest){return hash(JSON.stringify(captureEnvelope(manifest)));}
async function privateDirectory(path:string,create=false){
 if(create)await mkdir(path,{recursive:true,mode:0o700});
 const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==resolve(path)||process.platform!=='win32'&&(info.mode&0o077)!==0)
  throw Error('DURABLE_SPOOL_DIRECTORY_UNSAFE');
 return info;
}
async function syncDirectory(path:string){
 const handle=await open(path,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}
}
async function atomicJson(path:string,value:unknown){
 const temporary=path+'.'+randomUUID()+'.new';
 const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 await rename(temporary,path);await syncDirectory(resolve(path,'..'));
}
async function regularBytes(path:string,maxBytes:number){
 const before=await lstat(path);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maxBytes||await realpath(path)!==resolve(path))throw Error('DURABLE_SPOOL_FILE_UNSAFE');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const opened=await handle.stat();
  if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1)throw Error('DURABLE_SPOOL_FILE_CHANGED');
  const bytes=await handle.readFile();const after=await handle.stat();
  if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('DURABLE_SPOOL_FILE_CHANGED');
  return bytes;
 }finally{await handle.close();}
}

/** Node-only after an exact call empty proof. Copy, fsync and manifest form the handoff. */
export async function sealDurableSpool(input:{root:string;identity:DurableSpoolIdentity;exitProof:TaskCallReleaseProof;usage:ProviderUsage;
 outcome:string;sourceDir?:string;files?:{path:string;bytes:Buffer}[];deadlineAt?:string;minFreeBytes?:number}):Promise<DurableSpoolReceipt>{
 validateIdentity(input.identity);
 const proof=input.exitProof;
 if(proof?.version!=='call_cgroup_v1'||proof.sealed!==true||proof.nativeProcesses!==0||proof.logicalCallId!==input.identity.logicalCallId||
  proof.generation!==input.identity.attemptNo||proof.epoch!==input.identity.originalExecution.epoch||proof.sessionId!==input.identity.originalExecution.sessionId||
  !sha(proof.key)||!sha(proof.parentKey)||typeof proof.identity!=='string'||typeof proof.parentIdentity!=='string')throw Error('DURABLE_SPOOL_EXIT_PROOF_INVALID');
 const root=resolve(input.root),rootInfo=await privateDirectory(root,true);
 const capacity=await statfs(root);const minimum=input.minFreeBytes??256*1024*1024;
 if(!Number.isSafeInteger(minimum)||minimum<0||Number(capacity.bavail)*Number(capacity.bsize)<minimum)throw Error('DURABLE_SPOOL_LOW_DISK');
 const sources:{path:string;bytes?:Buffer;source?:string}[]=[];
 if(input.sourceDir){
  const source=resolve(input.sourceDir),sourceInfo=await privateDirectory(source);
  if(sourceInfo.dev!==rootInfo.dev)throw Error('DURABLE_SPOOL_REQUIRES_SAME_DURABLE_VOLUME');
  let entries=0,total=0;
  const walk=async(path:string):Promise<void>=>{
   if(!safePath(path)||++entries>FILE_AUTHORING_RECOVERY_LIMITS.files*4+8)throw Error('DURABLE_SPOOL_CAPACITY_EXCEEDED');
   const absolute=join(source,path),info=await lstat(absolute);
   if(info.isSymbolicLink()||await realpath(absolute)!==absolute)throw Error('DURABLE_SPOOL_FILE_UNSAFE');
   if(info.isDirectory()){for(const name of (await readdir(absolute)).sort())await walk(path+'/'+name);}
   else{
    if(!info.isFile()||info.nlink!==1||info.size>FILE_AUTHORING_RECOVERY_LIMITS.fileBytes)throw Error('DURABLE_SPOOL_FILE_UNSAFE');
    total+=info.size;sources.push({path:'workspace/'+path,source:absolute});
    if(sources.length>FILE_AUTHORING_RECOVERY_LIMITS.files||total>FILE_AUTHORING_RECOVERY_LIMITS.totalBytes)throw Error('DURABLE_SPOOL_CAPACITY_EXCEEDED');
   }
  };
  for(const path of ['input.json','scratch','output'])await walk(path);
 }
 for(const file of input.files??[]){
  if(!safePath(file.path)||!Buffer.isBuffer(file.bytes)||file.bytes.length>FILE_AUTHORING_RECOVERY_LIMITS.fileBytes)throw Error('DURABLE_SPOOL_FILE_UNSAFE');
  sources.push({path:'evidence/'+file.path,bytes:file.bytes});
 }
 if(!sources.length||sources.length>FILE_AUTHORING_RECOVERY_LIMITS.files||new Set(sources.map(f=>f.path)).size!==sources.length)throw Error('DURABLE_SPOOL_CAPACITY_EXCEEDED');
 const {identity}=input;
 const directory=join(root,identity.ownerUserId,identity.runId,identity.jobId,hash(identity.logicalCallId),identity.attemptId,String(identity.attemptNo));
 if(!within(root,directory))throw Error('DURABLE_SPOOL_DIRECTORY_UNSAFE');
 await privateDirectory(directory,true);
 // A durable in-progress marker pins the node even if a crash precedes manifest.
 await atomicJson(join(directory,'capture-pending.json'),{version:'durable-spool-pending-v1',identity});
 const manifest:DurableSpoolManifest={version:'durable-spool-v1',spoolId:hash(JSON.stringify(identity)),identity,exitProof:proof,
  usage:structuredClone(input.usage),outcome:input.outcome,deadlineAt:input.deadlineAt??null,sealedAt:new Date().toISOString(),files:[],
  state:'SEALED_LOCAL',attempts:0,nextDueAt:new Date().toISOString(),remoteCapture:null,registrationId:null};
 let total=0;
 for(const source of sources){
  const bytes=source.bytes??await regularBytes(source.source!,FILE_AUTHORING_RECOVERY_LIMITS.fileBytes);
  total+=bytes.length;if(total>FILE_AUTHORING_RECOVERY_LIMITS.totalBytes)throw Error('DURABLE_SPOOL_CAPACITY_EXCEEDED');
  const sha256=hash(bytes),file=join(directory,source.path);
  await privateDirectory(resolve(file,'..'),true);
  const descriptor=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await descriptor.writeFile(bytes);await descriptor.sync();}finally{await descriptor.close();}
  await syncDirectory(resolve(file,'..'));
  manifest.files.push({path:source.path,sha256,byteSize:bytes.length,
   key:`users/${identity.ownerUserId}/projects/${identity.projectId}/recovered-captures/${identity.attemptId}/${sha256}/${source.path}`});
 }
 await atomicJson(join(directory,'manifest.json'),manifest);
 return {directory,spoolId:manifest.spoolId,manifestSha256:durableSpoolManifestSha256(manifest)};
}

export async function readDurableSpool(receipt:DurableSpoolReceipt):Promise<DurableSpoolManifest>{
 await privateDirectory(receipt.directory);
 const manifest=JSON.parse((await regularBytes(join(receipt.directory,'manifest.json'),2*1024*1024)).toString()) as DurableSpoolManifest;
 validateIdentity(manifest.identity);
 if(manifest.version!=='durable-spool-v1'||manifest.spoolId!==receipt.spoolId||durableSpoolManifestSha256(manifest)!==receipt.manifestSha256||
  !['SEALED_LOCAL','REMOTE_VERIFIED','REGISTERED','GC_ELIGIBLE'].includes(manifest.state)||!Array.isArray(manifest.files)||
  manifest.files.some(f=>!safePath(f.path)||!sha(f.sha256)||!Number.isSafeInteger(f.byteSize)||f.byteSize<0||
   f.key!==`users/${manifest.identity.ownerUserId}/projects/${manifest.identity.projectId}/recovered-captures/${manifest.identity.attemptId}/${f.sha256}/${f.path}`))throw Error('DURABLE_SPOOL_MANIFEST_INVALID');
 return manifest;
}
export async function pendingDurableSpool(root=durableSpoolRoot()):Promise<{pending:number;unsafe:number;oldestPendingAt:string|null;receipts:DurableSpoolReceipt[]}>{
 const result={pending:0,unsafe:0,oldestPendingAt:null as string|null,receipts:[] as DurableSpoolReceipt[]};
 try{await privateDirectory(resolve(root));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error;}
 let entries=0;
 const walk=async(directory:string):Promise<void>=>{
  if(++entries>65536)throw Error('DURABLE_SPOOL_INVENTORY_UNBOUNDED');
  await privateDirectory(directory);const names=await readdir(directory);
  if(names.includes('capture-pending.json')){
   if(!names.includes('manifest.json')){result.pending++;result.unsafe++;return;}
   let receipt:DurableSpoolReceipt,manifest:DurableSpoolManifest;
   try{
    const raw=JSON.parse((await regularBytes(join(directory,'manifest.json'),2*1024*1024)).toString()) as DurableSpoolManifest;
    receipt={directory,spoolId:raw.spoolId,manifestSha256:durableSpoolManifestSha256(raw)};
    manifest=await readDurableSpool(receipt);
   }catch{result.pending++;result.unsafe++;return;}
   if(!['REGISTERED','GC_ELIGIBLE'].includes(manifest.state)){
    result.pending++;result.receipts.push(receipt);
    if(!result.oldestPendingAt||manifest.sealedAt<result.oldestPendingAt)result.oldestPendingAt=manifest.sealedAt;
   }
   return;
  }
  for(const name of names){const child=join(directory,name),info=await lstat(child);if(info.isSymbolicLink())throw Error('DURABLE_SPOOL_DIRECTORY_UNSAFE');if(info.isDirectory())await walk(child);}
 };
 await walk(resolve(root));return result;
}
export async function durableSpoolHealth(root=durableSpoolRoot(),workRoot=resolve(root,'..'),minFreeBytes=256*1024*1024){
 if(!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0)throw Error('DURABLE_SPOOL_HEALTH_BUDGET_INVALID');
 const inventory=await pendingDurableSpool(root);let retained=0;
 try{for(const name of await readdir(workRoot))if(name.startsWith('retained-attempt-'))retained++;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 let availableBytes=0;
 try{const capacity=await statfs(root);availableBytes=Number(capacity.bavail)*Number(capacity.bsize);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){const capacity=await statfs(workRoot);availableBytes=Number(capacity.bavail)*Number(capacity.bsize);}else throw error;}
 return {...inventory,unsafe:inventory.unsafe+retained,retained,availableBytes,lowDisk:availableBytes<minFreeBytes};
}

/** Call only inside an owned, independently time-limited IO consumer process. */
export async function flushDurableSpool(root:string,dependencies:{upload:(key:string,bytes:Buffer)=>Promise<void>;
 readback:(key:string,maxBytes:number)=>Promise<Buffer|null>;register:(manifest:DurableSpoolManifest,receipt:DurableSpoolReceipt)=>Promise<{id:string}>},
 limits:{maxAttempts?:number;totalMs?:number;now?:()=>number}={}):Promise<{registered:number;failed:number}>{
 const now=limits.now??Date.now,started=now(),maxAttempts=limits.maxAttempts??3,totalMs=limits.totalMs??300000;
 if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>3||totalMs<1||totalMs>300000)throw Error('DURABLE_SPOOL_BUDGET_INVALID');
 const inventory=await pendingDurableSpool(root);let registered=0,failed=0,attempts=0;
 for(const receipt of inventory.receipts){
  let manifest=await readDurableSpool(receipt);
  if(Date.parse(manifest.nextDueAt)>now())continue;
  while(attempts<maxAttempts&&now()-started<totalMs){
   attempts++;manifest.attempts++;manifest.nextDueAt=new Date(now()+Math.min(300000,1000*2**Math.min(manifest.attempts,8))).toISOString();
   await atomicJson(join(receipt.directory,'manifest.json'),manifest);
   try{
    if(manifest.state==='SEALED_LOCAL'){
     for(const file of manifest.files){
      const bytes=await regularBytes(join(receipt.directory,file.path),FILE_AUTHORING_RECOVERY_LIMITS.fileBytes);
      if(bytes.length!==file.byteSize||hash(bytes)!==file.sha256)throw Error('DURABLE_SPOOL_LOCAL_INTEGRITY_FAILED');
      await dependencies.upload(file.key,bytes);
      const remote=await dependencies.readback(file.key,file.byteSize);
      if(!remote||remote.length!==file.byteSize||hash(remote)!==file.sha256)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');
     }
     const bytes=Buffer.from(JSON.stringify(captureEnvelope(manifest))),sha256=hash(bytes);
     const key=`users/${manifest.identity.ownerUserId}/projects/${manifest.identity.projectId}/recovered-captures/${manifest.identity.attemptId}-${sha256}.json`;
     await dependencies.upload(key,bytes);const remote=await dependencies.readback(key,bytes.length);
     if(!remote||remote.length!==bytes.length||hash(remote)!==sha256)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');
     manifest.remoteCapture={key,sha256,byteSize:bytes.length};manifest.state='REMOTE_VERIFIED';
     await atomicJson(join(receipt.directory,'manifest.json'),manifest);
    }
    const registration=await dependencies.register(manifest,receipt);
    if(!id(registration.id))throw Error('DURABLE_SPOOL_REGISTRATION_INVALID');
    manifest.registrationId=registration.id;manifest.state='REGISTERED';
    await atomicJson(join(receipt.directory,'manifest.json'),manifest);registered++;break;
   }catch{failed++;break;}
  }
 }
 return {registered,failed};
}
export async function gcDurableSpool(receipt:DurableSpoolReceipt){
 const manifest=await readDurableSpool(receipt);
 if(manifest.state!=='REGISTERED'||!manifest.remoteCapture||!manifest.registrationId)throw Error('DURABLE_SPOOL_NOT_REGISTERED');
 manifest.state='GC_ELIGIBLE';await atomicJson(join(receipt.directory,'manifest.json'),manifest);
 await rm(receipt.directory,{recursive:true});await syncDirectory(resolve(receipt.directory,'..'));
}
export async function registerDurableSpoolReceipt(receipt:DurableSpoolReceipt,registrationId:string){
 const manifest=await readDurableSpool(receipt);
 if(!id(registrationId)||manifest.state!=='REMOTE_VERIFIED'||!manifest.remoteCapture)throw Error('DURABLE_SPOOL_NOT_REMOTE_VERIFIED');
 manifest.registrationId=registrationId;manifest.state='REGISTERED';await atomicJson(join(receipt.directory,'manifest.json'),manifest);
}
