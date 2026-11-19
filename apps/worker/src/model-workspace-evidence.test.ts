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
import {captureExitedWorkspace,collectionDiagnostic,writeWorkspaceEvidence,type WorkspaceExit} from './model-workspace-evidence.js';
import {m4CollectionRepairFeedback} from './m4-workspace-recovery.js';

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

test('link repair feedback contains only bounded host span identifiers and points at the actual association file',()=>{
 const raw={code:'WORKPAPER_CONTENT_LINKS_MISSING',file:'file-links.json',field:'/links',rule:'each_used_source_requires_verified_link',
  source_span_ids:['p4106','header1-p0'],source_span_count:40,private_quote:'private customer fact'};
 const safe=collectionDiagnostic({collectionDiagnostic:raw});
 assert.deepEqual(safe,{code:raw.code,file:raw.file,field:raw.field,rule:raw.rule,source_span_ids:raw.source_span_ids,source_span_count:40});
 const feedback=m4CollectionRepairFeedback(safe);assert.match(feedback,/output\/file-links\.json/);assert.match(feedback,/p4106/);
 assert.match(feedback,/不能只修改 workpaper-coverage/);assert.match(feedback,/最后一次编辑/);assert.match(feedback,/逐字且唯一/);
 assert.ok(!feedback.includes(raw.private_quote));
 for(const source_span_ids of [Array.from({length:33},(_,i)=>'p'+i),['p0','p0'],['p0 customer content'],['p'+'1'.repeat(129)]])
  assert.deepEqual(collectionDiagnostic({collectionDiagnostic:{...raw,source_span_ids}}),{code:'collection_failed'});
 for(const source_span_count of [-1,1.5,1000001,1])
  assert.deepEqual(collectionDiagnostic({collectionDiagnostic:{...raw,source_span_count}}),{code:'collection_failed'});
 assert.deepEqual(collectionDiagnostic({collectionDiagnostic:{code:'workpaper_file_missing',file:'document.docx'}}),{code:'workpaper_file_missing',file:'document.docx'});
});


test('combined repair issues remain bounded and describe the document and metadata together',()=>{
 const first={code:'WORKPAPER_TABLE_INCOMPLETE',file:'workpaper-coverage.json',field:'/used_span_ids',rule:'all_nonempty_cells_of_each_used_table',source_span_ids:['p2'],source_span_count:1};
 const second={code:'WORKPAPER_TABLE_OUTPUT_INCOMPLETE',file:'file-links.json',field:'/links',rule:'complete_source_table_to_distinct_target_cells',source_span_ids:['p1','p2'],source_span_count:2,private_quote:'private customer fact'};
 const safe=collectionDiagnostic({collectionDiagnostic:{...first,issues:[first,second],issue_count:2}});
 assert.equal(safe.issues?.length,2);const feedback=m4CollectionRepairFeedback(safe);
 assert.match(feedback,/output\/document\.docx/);assert.match(feedback,/全部issues/);assert.match(feedback,/不能只修第一个错误/);
 assert.ok(!feedback.includes(second.private_quote));
 for(const issues of [Array.from({length:9},()=>first),[{...first,source_span_ids:['private content']}]] )
  assert.deepEqual(collectionDiagnostic({collectionDiagnostic:{...first,issues,issue_count:issues.length}}),{code:'collection_failed'});
 assert.deepEqual(collectionDiagnostic({collectionDiagnostic:{...first,issues:[first,second],issue_count:1}}),{code:'collection_failed'});
 assert.deepEqual(collectionDiagnostic(null),{code:'collection_failed'});
});


test('legacy collection diagnostics remain immutable across an upgrade but conflicting evidence still fails closed',async()=>{
 const f=fixture(),old={code:'WORKPAPER_CONTENT_LINKS_MISSING',file:'workpaper-coverage.json',rule:'validateWorkpaperCoverage'};
 const next={code:old.code,file:'file-links.json',field:'/links',rule:'each_used_source_requires_verified_link',source_span_ids:['p0'],source_span_count:1};
 let saved:any={payload:old,payload_sha256:inputManifestHash(old),input_hash:'a'.repeat(64)};const calls:string[]=[];
 f.ctx.pool.query=(async(sql:string,args:unknown[])=>{calls.push(sql);if(sql.startsWith('INSERT'))return{rowCount:0,rows:[]};
  assert.match(sql,/a.prompt_snapshot_id=\$8/);assert.deepEqual(args,[intent.call_id,'collection_failure','owner','run','job','m4-document-v1',1,'prompt','project','a'.repeat(64)]);return{rows:[saved]};}) as never;
 await writeWorkspaceEvidence(f.ctx,intent,'collection_failure',next);assert.equal(calls.length,2);
 assert.deepEqual(saved.payload,old);assert.equal(saved.payload_sha256,inputManifestHash(old));assert.ok(calls.every(sql=>!/^UPDATE|^DELETE/.test(sql)));
 for(const row of [{...saved,input_hash:'b'.repeat(64)},{...saved,payload_sha256:'b'.repeat(64)},
  {payload:{...old,code:'WORKPAPER_TABLE_INCOMPLETE'},payload_sha256:inputManifestHash({...old,code:'WORKPAPER_TABLE_INCOMPLETE'}),input_hash:'a'.repeat(64)},
  {payload:next,payload_sha256:inputManifestHash(next),input_hash:'a'.repeat(64)}]){
  saved=row;await assert.rejects(writeWorkspaceEvidence(f.ctx,intent,'collection_failure',{...next,source_span_ids:['p1']}),/WORKSPACE_EVIDENCE_CONFLICT/);
 }
 saved={payload:old,payload_sha256:inputManifestHash(old),input_hash:'a'.repeat(64)};
 await assert.rejects(writeWorkspaceEvidence(f.ctx,intent,'collection_failure',{...next,private_quote:'unbounded customer text'}),/WORKSPACE_EVIDENCE_CONFLICT/);
});
