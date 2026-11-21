import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {connect} from 'node:net';
import {lstat} from 'node:fs/promises';
import {spawn as nativeSpawn,execFile as nativeExecFile,type SpawnOptions,type SpawnOptionsWithoutStdio,type SpawnOptionsWithStdioTuple,type StdioPipe,type StdioNull,type ChildProcess,type ChildProcessWithoutNullStreams,type ChildProcessByStdio,type ExecFileOptions} from 'node:child_process';
import type {Readable} from 'node:stream';
import {promisify} from 'node:util';
import type {Pool} from 'pg';
import {executionNodeForPool} from '@bondbuddy/api/execution-capacity';
import type {Lease,ManagedRunReleaseProof} from '@bondbuddy/api/queue';

export const TASK_CGROUP_PROTOCOL_VERSION=1;
type Scope={kind:'job'|'assistant'|'background';id:string;token:string};
type Receipt={key:string;identity:string;sealed:boolean;empty?:boolean;retireWhenEmpty?:boolean;retirementPending?:boolean};
const current=new AsyncLocalStorage<Receipt>();
const receipts=new Map<string,Receipt>();
const admitting=new Set<string>();
const socketPath='/run/bondbuddy/task-cgroups/broker.sock';
const runner='/opt/bondbuddy/task-runner.py';
let background:Receipt|undefined;
let managed=false;
let enrolledPool:Pool|undefined;
const keyFor=(scope:Scope)=>createHash('sha256').update(JSON.stringify(scope)).digest('hex');

async function request(input:Record<string,unknown>):Promise<Receipt&{nativeProcesses:number}>{
 const socket=await lstat(socketPath),parent=await lstat('/run/bondbuddy/task-cgroups');
 if(!socket.isSocket()||socket.uid!==0||socket.gid!==1000||(socket.mode&0o777)!==0o660||
   !parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||parent.gid!==1000||(parent.mode&0o777)!==0o750)
  throw Error('TASK_CGROUP_SOCKET_UNTRUSTED');
 return new Promise((resolve,reject)=>{
  const client=connect(socketPath);let text='',finished=false;
  const finish=(error?:Error,value?:Receipt&{nativeProcesses:number})=>{
   if(finished)return;finished=true;client.destroy();error?reject(error):resolve(value!);
  };
  client.setTimeout(5000,()=>finish(Error('TASK_CGROUP_UNAVAILABLE')));
  client.once('error',()=>finish(Error('TASK_CGROUP_UNAVAILABLE')));
  client.once('connect',()=>client.write(JSON.stringify(input)+'\n'));
  client.on('data',chunk=>{
   text+=chunk.toString();if(Buffer.byteLength(text)>4096)return finish(Error('TASK_CGROUP_INVALID_RESPONSE'));
   if(!text.endsWith('\n'))return;
   try{
    const value=JSON.parse(text);
    if(value.status!=='ok'||!/^([a-f0-9]{64})$/.test(value.key)||typeof value.identity!=='string'||
      !/^[a-f0-9-]+:[0-9]+:[0-9]+$/.test(value.identity)||typeof value.sealed!=='boolean'||
      !Number.isSafeInteger(value.nativeProcesses)||value.nativeProcesses<0)throw Error();
    finish(undefined,value);
   }catch{finish(Error('TASK_CGROUP_PROOF_UNAVAILABLE'));}
  });
  client.once('end',()=>{if(!finished)finish(Error('TASK_CGROUP_PROOF_UNAVAILABLE'));});
 });
}

/** Mandatory for an enrolled runtime. A restart does not adopt an old worker's scopes. */
export async function initializeTaskExecution(pool:Pool){
 const context=executionNodeForPool(pool);if(!context)return;
 if(enrolledPool)throw Error('TASK_CGROUP_ALREADY_INITIALIZED');
 for(let attempt=0;;attempt++){
  try{await request({action:'register',context});break;}
  catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(attempt>=59||code!=='ENOENT'&&!(error instanceof Error&&error.message==='TASK_CGROUP_UNAVAILABLE'))throw error;
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
 }
 managed=true;
 enrolledPool=pool;
 background=await request({action:'open',scope:{kind:'background',id:context.session_id,token:context.session_id}});
}

export function assertTaskExecution(pool:Pool){
 if(executionNodeForPool(pool)&&(enrolledPool!==pool||!managed||!background))throw Error('TASK_CGROUP_NOT_INITIALIZED');
}

export async function withTaskExecution<T>(pool:Pool,scope:Scope,work:()=>Promise<T>):Promise<T>{
 if(!executionNodeForPool(pool))return work();
 assertTaskExecution(pool);
 const key=keyFor(scope);
 if(receipts.has(key)||admitting.has(key))throw Error('TASK_EXECUTION_ALREADY_ENTERED');
 admitting.add(key);
 let receipt:Receipt;
 try{receipt=await request({action:'open',scope});}finally{admitting.delete(key);}
 if(receipt.key!==key||receipt.sealed)throw Error('TASK_CGROUP_SCOPE_MISMATCH');
 receipts.set(key,receipt);
 let result:T|undefined,completed=false;
 try{result=await current.run(receipt,work);completed=true;return result;}
 finally{
  // Seal admission before the empty proof. A late runner cannot execute business code.
  receipt.sealed=true;
  receipt.retireWhenEmpty=completed&&result!=='retry';
  const sealed=await request({action:'seal',key,identity:receipt.identity});
  if(sealed.key!==key||sealed.identity!==receipt.identity||!sealed.sealed)throw Error('TASK_CGROUP_SCOPE_MISMATCH');
  if(completed&&result!=='retry'&&sealed.nativeProcesses===0){
   await retireReceipt(receipt);
   receipts.delete(key);
  }
 }
}

export async function sweepCompletedTaskExecutions(){
 const results=await Promise.allSettled([...receipts.values()].filter(receipt=>receipt.retireWhenEmpty).map(async receipt=>{
  if(receipt.retirementPending){
   await retireReceipt(receipt);
   if(receipts.get(receipt.key)===receipt)receipts.delete(receipt.key);
   return;
  }
  const proof=await request({action:'seal',key:receipt.key,identity:receipt.identity});
  if(proof.key!==receipt.key||proof.identity!==receipt.identity||!proof.sealed)throw Error('TASK_CGROUP_SCOPE_MISMATCH');
  if(proof.nativeProcesses===0){
   await retireReceipt(receipt);
   if(receipts.get(receipt.key)===receipt)receipts.delete(receipt.key);
  }
 }));
 const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
 if(errors.length)throw new AggregateError(errors,'TASK_CGROUP_RETIRE_BLOCKED');
}

export async function withBackgroundTaskExecution<T>(work:()=>Promise<T>):Promise<T>{
 if(!managed)return work();
 if(!background||background.sealed)throw Error('TASK_BACKGROUND_ADMISSION_CLOSED');
 return current.run(background,work);
}

export async function taskNativeProcesses(lease:Lease){
 const receipt=receipts.get(keyFor({kind:'job',id:lease.jobId,token:lease.token}));
 if(!receipt?.sealed)throw Error('TASK_EXECUTION_NOT_SEALED');
 const proof=await request({action:'seal',key:receipt.key,identity:receipt.identity});
 if(!proof.sealed||proof.key!==receipt.key||proof.identity!==receipt.identity)throw Error('TASK_CGROUP_SCOPE_MISMATCH');
 receipt.empty=proof.nativeProcesses===0;
 return proof.nativeProcesses;
}

export function taskReleaseProof(pool:Pool,lease:Lease):ManagedRunReleaseProof{
 const context=executionNodeForPool(pool),receipt=receipts.get(keyFor({kind:'job',id:lease.jobId,token:lease.token}));
 if(!context||!receipt?.sealed||!receipt.empty)throw Error('TASK_EXECUTION_NOT_QUIESCENT');
 return {version:'task_cgroup_v1',nativeProcesses:0,activeExecutions:0,jobId:lease.jobId,token:lease.token,
  epoch:context.identity.epoch,sessionId:context.session_id,cgroupIdentity:receipt.identity};
}

export async function retireTaskExecution(lease:Lease){
 const key=keyFor({kind:'job',id:lease.jobId,token:lease.token}),receipt=receipts.get(key);
 if(!receipt?.sealed||!receipt.empty)throw Error('TASK_EXECUTION_NOT_QUIESCENT');
 await retireReceipt(receipt);
 receipts.delete(key);
}

async function retireReceipt(receipt:Receipt){
 receipt.retireWhenEmpty=true;
 receipt.retirementPending=true;
 const proof=await request({action:'retire',key:receipt.key,identity:receipt.identity});
 if(proof.key!==receipt.key||proof.identity!==receipt.identity||!proof.sealed||proof.nativeProcesses!==0)
  throw Error('TASK_CGROUP_SCOPE_MISMATCH');
}

function nativeCommand(command:string,args:readonly string[],env:NodeJS.ProcessEnv|undefined){
 if(!managed&&!process.env.BB_EXECUTION_ENROLLMENT_FILE)return {command,args:[...args],env};
 const receipt=current.getStore();
 if(!receipt||receipt.sealed)throw Error('TASK_NATIVE_ADMISSION_CLOSED');
 return {command:'/usr/bin/python3',args:['-I',runner,receipt.key,receipt.identity,'--',command,...args],
  env:{...(env??process.env),BB_TASK_CGROUP_KEY:receipt.key,BB_TASK_CGROUP_IDENTITY:receipt.identity}};
}

/** PID-preserving exec after the host moves the runner, never spawn-then-tag. */
export function spawn(command:string,args?:readonly string[],options?:SpawnOptionsWithoutStdio):ChildProcessWithoutNullStreams;
export function spawn(command:string,args:readonly string[],options:SpawnOptionsWithStdioTuple<StdioPipe,StdioPipe,StdioPipe>):ChildProcessWithoutNullStreams;
export function spawn(command:string,args:readonly string[],options:SpawnOptionsWithStdioTuple<StdioNull,StdioPipe,StdioPipe>):ChildProcessByStdio<null,Readable,Readable>;
export function spawn(command:string,args:readonly string[],options:SpawnOptionsWithStdioTuple<StdioNull,StdioPipe,StdioNull>):ChildProcessByStdio<null,Readable,null>;
export function spawn(command:string,args:readonly string[],options:SpawnOptions):ChildProcess;
export function spawn(command:string,args:readonly string[]=[],options:SpawnOptions={}){
 const launch=nativeCommand(command,args,options.env);
 return nativeSpawn(launch.command,launch.args,{...options,env:launch.env});
}

const exec=promisify(nativeExecFile);
export function taskExecFile(command:string,args:readonly string[],options:ExecFileOptions={}){
 const launch=nativeCommand(command,args,options.env);
 return exec(launch.command,launch.args,{...options,env:launch.env,encoding:'utf8' as const});
}

/** Playwright owns its spawn; its fixed wrapper uses the same admission protocol. */
export function taskBrowserExecutable(){
 if(!managed&&!process.env.BB_EXECUTION_ENROLLMENT_FILE)return undefined;
 const receipt=current.getStore();
 if(!receipt||receipt.sealed)throw Error('TASK_NATIVE_ADMISSION_CLOSED');
 return '/opt/bondbuddy/task-chromium';
}
export function taskBrowserEnvironment(env:Record<string,string>){
 const receipt=current.getStore();
 return receipt?{...env,BB_TASK_CGROUP_KEY:receipt.key,BB_TASK_CGROUP_IDENTITY:receipt.identity}:env;
}
