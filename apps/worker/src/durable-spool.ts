import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,rename,rm,rmdir,statfs} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {FILE_AUTHORING_RECOVERY_LIMITS} from '@bondbuddy/contracts';
import type {ProviderUsage} from '@bondbuddy/api/provider-results';
import type {TaskCallReleaseProof} from './task-execution.js';
import {withPerformanceSpan} from '@bondbuddy/api/performance-trace';
import {spoolPerformanceAttributes} from './workflow-observability.js';

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
type GcTicket={version:'durable-spool-gc-v1';receipt:DurableSpoolReceipt;manifest:DurableSpoolManifest};
export type DurableSpoolGcOptions={root?:string;remove?:(directory:string)=>Promise<void>};

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
 return validateManifest(receipt,manifest);
}
function validateManifest(receipt:DurableSpoolReceipt,manifest:DurableSpoolManifest){
 validateIdentity(manifest.identity);
 if(manifest.version!=='durable-spool-v1'||manifest.spoolId!==receipt.spoolId||durableSpoolManifestSha256(manifest)!==receipt.manifestSha256||
  !['SEALED_LOCAL','REMOTE_VERIFIED','REGISTERED','GC_ELIGIBLE'].includes(manifest.state)||!Number.isSafeInteger(manifest.attempts)||manifest.attempts<0||
  typeof manifest.nextDueAt!=='string'||!Number.isFinite(Date.parse(manifest.nextDueAt))||!Array.isArray(manifest.files)||
  manifest.files.some(f=>!safePath(f.path)||!sha(f.sha256)||!Number.isSafeInteger(f.byteSize)||f.byteSize<0||
   f.key!==`users/${manifest.identity.ownerUserId}/projects/${manifest.identity.projectId}/recovered-captures/${manifest.identity.attemptId}/${f.sha256}/${f.path}`))throw Error('DURABLE_SPOOL_MANIFEST_INVALID');
 return manifest;
}
function checkedGcManifest(root:string,receipt:DurableSpoolReceipt,manifest:DurableSpoolManifest){
 validateManifest(receipt,manifest);
 const identity=manifest.identity,expected=join(resolve(root),identity.ownerUserId,identity.runId,identity.jobId,hash(identity.logicalCallId),identity.attemptId,String(identity.attemptNo));
 const envelope=Buffer.from(JSON.stringify(captureEnvelope(manifest)));
 if(resolve(receipt.directory)!==expected||!within(root,expected)||manifest.spoolId!==hash(JSON.stringify(identity))||!['REGISTERED','GC_ELIGIBLE'].includes(manifest.state)||!id(manifest.registrationId)||
  !manifest.remoteCapture||manifest.remoteCapture.sha256!==receipt.manifestSha256||manifest.remoteCapture.byteSize!==envelope.length||
  manifest.remoteCapture.key!==`users/${identity.ownerUserId}/projects/${identity.projectId}/recovered-captures/${identity.attemptId}-${receipt.manifestSha256}.json`)
  throw Error('DURABLE_SPOOL_NOT_REGISTERED');
 return manifest;
}
const gcTicketPath=(root:string,spoolId:string)=>join(resolve(root),'.gc',spoolId+'.json');
const gcName=(name:string)=>/^([a-f0-9]{64})\.json(?:\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.new)?$/.exec(name);
const sameGcTicket=(left:GcTicket,right:GcTicket)=>left.receipt.directory===right.receipt.directory&&left.receipt.spoolId===right.receipt.spoolId&&
 left.receipt.manifestSha256===right.receipt.manifestSha256&&left.manifest.registrationId===right.manifest.registrationId;
async function readGcTicket(root:string,path:string):Promise<GcTicket>{
 const ticket=JSON.parse((await regularBytes(path,2*1024*1024)).toString()) as GcTicket;
 const rel=relative(join(resolve(root),'.gc'),path),name=gcName(rel);
 if(ticket.version!=='durable-spool-gc-v1'||!ticket.receipt||!sha(ticket.receipt.spoolId)||!name||name[1]!==ticket.receipt.spoolId)throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
 checkedGcManifest(root,ticket.receipt,ticket.manifest);return ticket;
}
export async function readDurableSpoolForGc(root:string,receipt:DurableSpoolReceipt):Promise<DurableSpoolManifest>{
 const inventory=await gcTickets(root);
 if(inventory.blocked.has(receipt.spoolId))throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
 const ticket=inventory.tickets.find(t=>t.receipt.spoolId===receipt.spoolId);
 if(ticket){
  if(ticket.receipt.directory!==receipt.directory||ticket.receipt.manifestSha256!==receipt.manifestSha256)throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
  return ticket.manifest;
 }
 return checkedGcManifest(root,receipt,await readDurableSpool(receipt));
}
async function gcTickets(root:string){
 const result={tickets:[] as GcTicket[],unsafe:0,blocked:new Set<string>(),temporaries:[] as {path:string;spoolId:string}[],truncated:new Set<string>()},directory=join(resolve(root),'.gc');
 try{await privateDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error;}
 const names=await readdir(directory);if(names.length>65536)throw Error('DURABLE_SPOOL_INVENTORY_UNBOUNDED');
 const candidates=new Map<string,GcTicket>();
 for(const name of names){
  const match=gcName(name),path=join(directory,name),temporary=!!match&&name.endsWith('.new');
  if(!match){result.unsafe++;continue;}
  try{
   const ticket=await readGcTicket(root,path),prior=candidates.get(match[1]);
   if(prior&&!sameGcTicket(prior,ticket))throw Error('DURABLE_SPOOL_GC_TICKET_CONFLICT');
   if(!prior||Date.parse(ticket.manifest.nextDueAt)>Date.parse(prior.manifest.nextDueAt)||ticket.manifest.attempts>prior.manifest.attempts)candidates.set(match[1],ticket);
   if(temporary)result.temporaries.push({path,spoolId:match[1]});
  }catch(error){
   // Only a bounded regular file with syntactically unfinished JSON is a
   // recoverable write-before-rename remainder. Independent registered proof
   // must still exist before a consumer may remove it.
   if(temporary&&error instanceof SyntaxError){result.temporaries.push({path,spoolId:match[1]});result.truncated.add(match[1]);}
   else{result.unsafe++;result.blocked.add(match[1]);}
  }
 }
 result.tickets=[...candidates.values()].filter(t=>!result.blocked.has(t.receipt.spoolId));
 return result;
}
export async function pendingDurableSpool(root=durableSpoolRoot()):Promise<{pending:number;unsafe:number;oldestPendingAt:string|null;oldestGcAt:string|null;receipts:DurableSpoolReceipt[];gcPending:number;gcReceipts:DurableSpoolReceipt[]}>{
 root=resolve(root);
 const result={pending:0,unsafe:0,oldestPendingAt:null as string|null,oldestGcAt:null as string|null,receipts:[] as DurableSpoolReceipt[],gcPending:0,gcReceipts:[] as DurableSpoolReceipt[]};
 try{await privateDirectory(resolve(root));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error;}
 const tickets=await gcTickets(root),gcDirectories=new Set(tickets.tickets.map(t=>resolve(t.receipt.directory)));
 result.pending+=tickets.unsafe;result.unsafe+=tickets.unsafe;result.gcReceipts.push(...tickets.tickets.map(t=>t.receipt));
 for(const ticket of tickets.tickets)if(!result.oldestGcAt||ticket.manifest.sealedAt<result.oldestGcAt)result.oldestGcAt=ticket.manifest.sealedAt;
 let entries=0;
 const walk=async(directory:string):Promise<void>=>{
  if(++entries>65536)throw Error('DURABLE_SPOOL_INVENTORY_UNBOUNDED');
  if(gcDirectories.has(resolve(directory)))return;
  await privateDirectory(directory);const names=await readdir(directory);
  if(names.includes('capture-pending.json')||names.includes('manifest.json')){
   if(!names.includes('manifest.json')){result.pending++;result.unsafe++;return;}
   let receipt:DurableSpoolReceipt,manifest:DurableSpoolManifest;
   try{
    const raw=JSON.parse((await regularBytes(join(directory,'manifest.json'),2*1024*1024)).toString()) as DurableSpoolManifest;
    receipt={directory,spoolId:raw.spoolId,manifestSha256:durableSpoolManifestSha256(raw)};
    manifest=await readDurableSpool(receipt);
   }catch{result.pending++;result.unsafe++;return;}
   if(['REGISTERED','GC_ELIGIBLE'].includes(manifest.state)){
    try{checkedGcManifest(root,receipt,manifest);if(!tickets.blocked.has(receipt.spoolId)){result.gcReceipts.push(receipt);if(!result.oldestGcAt||manifest.sealedAt<result.oldestGcAt)result.oldestGcAt=manifest.sealedAt;}}catch{result.pending++;result.unsafe++;}
   }else{
    result.pending++;result.receipts.push(receipt);
    if(!result.oldestPendingAt||manifest.sealedAt<result.oldestPendingAt)result.oldestPendingAt=manifest.sealedAt;
   }
   return;
  }
  for(const name of names){
   if(directory===root&&name==='.gc')continue;
   const child=join(directory,name),info=await lstat(child);
   if(info.isSymbolicLink())throw Error('DURABLE_SPOOL_DIRECTORY_UNSAFE');
   if(info.isDirectory())await walk(child);
   else if(/^(?:capture-pending|manifest)\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.new$/.test(name)){
    // A failed fsync before the first marker rename still leaves a .new file.
    // Treat that interrupted capture write as debt. Unrelated sibling files
    // remain untouched; their presence is not an unregistered capture receipt.
    result.pending++;result.unsafe++;
   }
  }
 };
 await walk(root);
 for(const spoolId of tickets.truncated)if(!result.gcReceipts.some(r=>r.spoolId===spoolId)){result.pending++;result.unsafe++;}
 result.gcPending=result.gcReceipts.length;return result;
}
/** Registered debt is independently discoverable even after partial deletion. */
export async function gcDurableSpoolReceipts(root=durableSpoolRoot()){
 return (await pendingDurableSpool(root)).gcReceipts;
}
/** Persist before an attempt, including GC whose local manifest may already be gone. */
export async function deferDurableSpoolRetry(root:string,receipt:DurableSpoolReceipt,now=Date.now(),gc=false){
 if(!Number.isSafeInteger(now)||now<0)throw Error('DURABLE_SPOOL_RETRY_CLOCK_INVALID');
 const manifest=gc?await readDurableSpoolForGc(root,receipt):await readDurableSpool(receipt);
 manifest.attempts=Math.min(Number.MAX_SAFE_INTEGER,manifest.attempts+1);
 manifest.nextDueAt=new Date(now+Math.min(300000,1000*2**Math.min(manifest.attempts,8))).toISOString();
 if(gc){
  // Existing tickets remain the authority through partial rm and restart.
  const tickets=await gcTickets(root);
  if(tickets.blocked.has(receipt.spoolId))throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
  if(tickets.tickets.some(ticket=>ticket.receipt.spoolId===receipt.spoolId))await atomicJson(gcTicketPath(root,receipt.spoolId),{version:'durable-spool-gc-v1',receipt,manifest} satisfies GcTicket);
  try{
   const local=checkedGcManifest(root,receipt,await readDurableSpool(receipt));
   if(local.registrationId!==manifest.registrationId)throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
   await atomicJson(join(receipt.directory,'manifest.json'),manifest);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }else await atomicJson(join(receipt.directory,'manifest.json'),manifest);
}
/** Oldest due work goes first; advancing due before work rotates failures behind untried debt. */
export async function dueDurableSpoolReceipts(root:string,receipts:DurableSpoolReceipt[],now=Date.now(),gc=false){
 const tickets=gc?await gcTickets(root):undefined,ticketById=new Map(tickets?.tickets.map(ticket=>[ticket.receipt.spoolId,ticket])??[]);
 const rows:{receipt:DurableSpoolReceipt;manifest:DurableSpoolManifest}[]=[];
 for(const receipt of receipts){
  const ticket=ticketById.get(receipt.spoolId);
  if(tickets?.blocked.has(receipt.spoolId))throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
  if(ticket&&(ticket.receipt.directory!==receipt.directory||ticket.receipt.manifestSha256!==receipt.manifestSha256))throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
  const manifest=ticket?.manifest??await readDurableSpool(receipt);if(gc)checkedGcManifest(root,receipt,manifest);
  rows.push({receipt,manifest});
 }
 return rows.filter(row=>Date.parse(row.manifest.nextDueAt)<=now).sort((a,b)=>Date.parse(a.manifest.nextDueAt)-Date.parse(b.manifest.nextDueAt)||
  a.manifest.sealedAt.localeCompare(b.manifest.sealedAt)||a.receipt.directory.localeCompare(b.receipt.directory)).map(row=>row.receipt);
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
 limits:{maxAttempts?:number;totalMs?:number;now?:()=>number;receipt?:DurableSpoolReceipt}={}):Promise<{registered:number;failed:number}>{
 const now=limits.now??Date.now,started=now(),maxAttempts=limits.maxAttempts??3,totalMs=limits.totalMs??300000;
 if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>3||totalMs<1||totalMs>300000)throw Error('DURABLE_SPOOL_BUDGET_INVALID');
 const inventory=await pendingDurableSpool(root);let registered=0,failed=0,attempts=0;
 for(const receipt of inventory.receipts){
  if(limits.receipt&&(receipt.directory!==limits.receipt.directory||receipt.spoolId!==limits.receipt.spoolId||receipt.manifestSha256!==limits.receipt.manifestSha256))continue;
  let manifest=await readDurableSpool(receipt);
  const attributes=spoolPerformanceAttributes(manifest,receipt);
  if(Date.parse(manifest.nextDueAt)>now())continue;
  while(attempts<maxAttempts&&now()-started<totalMs){
   attempts++;manifest.attempts++;manifest.nextDueAt=new Date(now()+Math.min(300000,1000*2**Math.min(manifest.attempts,8))).toISOString();
   await atomicJson(join(receipt.directory,'manifest.json'),manifest);
   try{
    if(manifest.state==='SEALED_LOCAL'){
     for(const file of manifest.files){
      const bytes=await regularBytes(join(receipt.directory,file.path),FILE_AUTHORING_RECOVERY_LIMITS.fileBytes);
      if(bytes.length!==file.byteSize||hash(bytes)!==file.sha256)throw Error('DURABLE_SPOOL_LOCAL_INTEGRITY_FAILED');
      await withPerformanceSpan('spool.upload',{...attributes,object_ref:hash(file.key),byte_size:bytes.length},()=>dependencies.upload(file.key,bytes));
      const remote=await withPerformanceSpan('spool.readback',{...attributes,object_ref:hash(file.key),byte_size:file.byteSize},()=>dependencies.readback(file.key,file.byteSize));
      if(!remote||remote.length!==file.byteSize||hash(remote)!==file.sha256)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');
     }
     const bytes=Buffer.from(JSON.stringify(captureEnvelope(manifest))),sha256=hash(bytes);
     const key=`users/${manifest.identity.ownerUserId}/projects/${manifest.identity.projectId}/recovered-captures/${manifest.identity.attemptId}-${sha256}.json`;
     await withPerformanceSpan('spool.upload',{...attributes,object_ref:hash(key),byte_size:bytes.length},()=>dependencies.upload(key,bytes));const remote=await withPerformanceSpan('spool.readback',{...attributes,object_ref:hash(key),byte_size:bytes.length},()=>dependencies.readback(key,bytes.length));
     if(!remote||remote.length!==bytes.length||hash(remote)!==sha256)throw Error('DURABLE_SPOOL_REMOTE_INTEGRITY_FAILED');
     manifest.remoteCapture={key,sha256,byteSize:bytes.length};manifest.state='REMOTE_VERIFIED';
     await atomicJson(join(receipt.directory,'manifest.json'),manifest);
    }
    const registration=await withPerformanceSpan('spool.register',attributes,()=>dependencies.register(manifest,receipt));
    if(!id(registration.id))throw Error('DURABLE_SPOOL_REGISTRATION_INVALID');
    manifest.registrationId=registration.id;manifest.state='REGISTERED';manifest.nextDueAt=new Date(now()).toISOString();
    await atomicJson(join(receipt.directory,'manifest.json'),manifest);registered++;break;
   }catch{failed++;break;}
  }
 }
 return {registered,failed};
}
export async function gcDurableSpool(receipt:DurableSpoolReceipt,options:DurableSpoolGcOptions={}){
 const root=resolve(options.root??resolve(receipt.directory,'../../../../../../'));await privateDirectory(root);
 const manifest=await readDurableSpoolForGc(root,receipt);
 return withPerformanceSpan('spool.gc',spoolPerformanceAttributes(manifest,receipt),async()=>{
 // Keep the complete receipt outside the deleted tree. A partial rm may remove
 // manifest.json first; the next pass can still recheck the original DB record.
 await privateDirectory(join(root,'.gc'),true);
 manifest.state='GC_ELIGIBLE';await atomicJson(gcTicketPath(root,receipt.spoolId),{version:'durable-spool-gc-v1',receipt,manifest} satisfies GcTicket);
 try{
  const local=checkedGcManifest(root,receipt,await readDurableSpool(receipt));
  if(local.registrationId!==manifest.registrationId)throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
  await atomicJson(join(receipt.directory,'manifest.json'),manifest);
 }
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{await privateDirectory(receipt.directory);await(options.remove?.(receipt.directory)??rm(receipt.directory,{recursive:true,force:true}));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{await lstat(receipt.directory);throw Error('DURABLE_SPOOL_GC_INCOMPLETE');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 let parent=resolve(receipt.directory,'..');
 while(within(root,parent)){
  const above=resolve(parent,'..');
  try{await privateDirectory(parent);await rmdir(parent);await syncDirectory(above);}
  catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ENOTEMPTY'||code==='EEXIST'){await syncDirectory(parent);break;}if(code!=='ENOENT')throw error;}
  parent=above;
 }
 const remnants=await gcTickets(root);
 if(remnants.blocked.has(receipt.spoolId))throw Error('DURABLE_SPOOL_GC_TICKET_INVALID');
 for(const temporary of remnants.temporaries.filter(t=>t.spoolId===receipt.spoolId))await rm(temporary.path);
 await syncDirectory(join(root,'.gc'));
 await rm(gcTicketPath(root,receipt.spoolId));await syncDirectory(join(root,'.gc'));
 });
}
export async function registerDurableSpoolReceipt(receipt:DurableSpoolReceipt,registrationId:string){
 const manifest=await readDurableSpool(receipt);
 if(!id(registrationId)||manifest.state!=='REMOTE_VERIFIED'||!manifest.remoteCapture)throw Error('DURABLE_SPOOL_NOT_REMOTE_VERIFIED');
 manifest.registrationId=registrationId;manifest.state='REGISTERED';manifest.nextDueAt=new Date().toISOString();await atomicJson(join(receipt.directory,'manifest.json'),manifest);
}
