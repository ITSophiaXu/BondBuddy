import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {digest} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import type {ProviderCallIntent} from '@bondbuddy/api/provider-results';
import type {StageContext} from './run-pipeline.js';
import {captureExitedWorkspace,type WorkspaceExit} from './model-workspace-evidence.js';

const intent={call_id:'call-capture',logical_call_id:'m4-document-v1',attempt_no:1,owner_user_id:'owner',
 project_id:'project',run_id:'run',job_id:'job',prompt_snapshot_ref:'prompt'} as ProviderCallIntent;
const exit={completed:false,observation:{...intent,outcome:'pending_reconcile',error_code:'MODEL_TIMEOUT',
 finish_reason:'timeout',usage:{status:'unknown'}},runtime:{exit_code:null,exit_signal:'SIGTERM'}} as WorkspaceExit;
function fixture(latency=0){
 const objects=new Map<string,Buffer>(),evidence:{event:string;payload:Record<string,unknown>;hash:string}[]=[];
 const cancelled=new AbortController();cancelled.abort();
 const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_hash:'a'.repeat(64)},lease:{jobId:'job',checkpoint:{}},
  signal:cancelled.signal,blobs:{put:async(key:string,bytes:Buffer)=>{if(latency&&key.includes('/file-authoring/recovery/'))await delay(latency);objects.set(key,Buffer.from(bytes));},
   getIfExistsBounded:async(key:string,max:number)=>{if(latency&&key.includes('/file-authoring/recovery/'))await delay(latency);const b=objects.get(key);return b&&b.length<=max?b:null;}},
  pool:{query:async(sql:string,args:unknown[])=>{assert.match(sql,/^INSERT INTO bb_model_workspace_evidence/);
   evidence.push({event:args[1] as string,payload:JSON.parse(args[2] as string),hash:args[3] as string});return{rowCount:1};}}} as unknown as StageContext;
 return{ctx,objects,evidence};
}
async function workspace(root:string,extra=0){
 await mkdir(join(root,'scratch'));await mkdir(join(root,'output'));
 await writeFile(join(root,'input.json'),JSON.stringify({input_hash:'a'.repeat(64)}));
 await writeFile(join(root,'output/document.docx'),'terminated model document bytes');
 await Promise.all(Array.from({length:extra},(_,i)=>writeFile(join(root,'scratch',i+'.txt'),'source and saved work '+i)));
}

test('an exited 187-file workspace completes verified capture beyond thirty seconds despite the cancelled task signal',
 {timeout:80000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-slow-workspace-')),f=fixture(90);
 try{
  await workspace(root,185);const started=Date.now();await captureExitedWorkspace(f.ctx,root,intent,exit);
  assert.ok(Date.now()-started>30000,'exercise the former thirty-second capture cutoff');
  assert.equal(f.evidence.length,1);const saved=f.evidence[0];assert.equal(saved.event,'exit');
  assert.equal(saved.hash,inputManifestHash(saved.payload));
  const snapshot=(saved.payload.snapshot as {files:{path:string;key:string;sha256:string;byte_size:number}[]});
  assert.equal(snapshot.files.length,187);
  for(const file of snapshot.files){const original=await readFile(join(root,file.path)),stored=f.objects.get(file.key);
   assert.deepEqual(stored,original);assert.equal(file.byte_size,original.length);assert.equal(file.sha256,digest(original));}
  assert.equal((saved.payload.exit as WorkspaceExit).completed,false,'capture cannot turn a timeout into delivery');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a storage capture failure records a safe reason and never publishes an exit snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-capture-store-')),f=fixture();
 try{
  await workspace(root);f.ctx.blobs.put=async()=>{throw Error('private storage exception text');};
  await assert.rejects(captureExitedWorkspace(f.ctx,root,intent,exit),/WORKSPACE_CAPTURE_FAILED/);
  assert.deepEqual(f.evidence.map(e=>({event:e.event,payload:e.payload})),[
   {event:'capture_failure',payload:{code:'workspace_capture_failed',reason:'storage_failed'}}]);
  assert.equal(f.objects.size,0);assert.ok(!JSON.stringify(f.evidence).includes('private storage exception'));
 }finally{await rm(root,{recursive:true,force:true});}
});