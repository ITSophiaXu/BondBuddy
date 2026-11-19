import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {FILE_AUTHORING_SEED_STAGE,validFileAuthoringSeed,zeroChargeSeedReservation,type FileAuthoringSeed} from './file-authoring-seed.js';
import {authorizedFileAuthoringRecovery,fileAuthoringContextDeadline,fileAuthoringUsesSmallBatches,recoverFileAuthoringInput,restoreFileAuthoringWork} from './file-authoring-recovery.js';
import type {StageContext} from './run-pipeline.js';
function fixture(){
 const scope={owner:'owner',project:'project',run:'new-run',job:'new-job',revision:2,inputHash:'a'.repeat(64)};
 const source='failed-run',attempt='call-timeout',seedId=`seed-${inputManifestHash({source,attempt,target:scope.run}).slice(0,40)}`;
 const input=Buffer.from(JSON.stringify({version:'test',input_hash:scope.inputHash,format_tools:{},revision_date:'2026-11-18T00:00:00.000Z'}));
 const objects=new Map<string,Buffer>();
 const refs=[['input.json',input],['scratch/工作记录.md',Buffer.from('已保存财务表，继续核对审计主体。')],['output/operations.json',Buffer.from('{"operations":[{"id":"prior-edit"}]}')]] as [string,Buffer][];
 const files=refs.map(([path,bytes])=>{const sha256=digest(bytes),key=`owners/${scope.owner}/projects/${scope.project}/runs/${scope.run}/file-authoring/recovery/${seedId}/${sha256}/${path}`;objects.set(key,bytes);return{path,key,sha256,byte_size:bytes.length};});
 const authorized_at=new Date(Date.now()-1000).toISOString(),deadline_at=new Date(Date.parse(authorized_at)+60000).toISOString();
 const snapshot={version:'file-authoring-recovery-v1' as const,input_hash:scope.inputHash,attempt_id:seedId,logical_call_id:'file-authoring-v1',deadline_at,files};
 const seed:FileAuthoringSeed={version:'file-authoring-new-run-seed-v1',owner_user_id:scope.owner,project_id:scope.project,run_id:scope.run,job_id:scope.job,input_revision:scope.revision,input_hash:scope.inputHash,
  source_run_id:source,source_job_id:'failed-job',source_attempt_id:attempt,source_snapshot_sha256:'b'.repeat(64),actor:'local-acceptance',authorized_at,deadline_at,budget_ms:60000,small_batches:true,snapshot,snapshot_sha256:inputManifestHash(snapshot)};
 const ctx={run:{id:scope.run,owner_user_id:scope.owner,project_id:scope.project,input_revision:scope.revision,input_hash:scope.inputHash},lease:{jobId:scope.job,checkpoint:{stages:{[FILE_AUTHORING_SEED_STAGE]:seed}}},signal:new AbortController().signal,
  blobs:{getIfExistsBounded:async(key:string,max:number)=>{const bytes=objects.get(key);return bytes&&bytes.length<=max?bytes:null;}}} as unknown as StageContext;
 return {scope,input,objects,seed,ctx};
}
test('new-run seed restores exact saved work and timestamp after restart with an independent fixed deadline',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-prior-seed-'));
 try{
  const ctx={...f.ctx,lease:{...f.ctx.lease,checkpoint:structuredClone(f.ctx.lease.checkpoint)}};
  const saved=authorizedFileAuthoringRecovery(ctx,'file-authoring-v1');assert.ok(saved);
  assert.equal(fileAuthoringContextDeadline(ctx,'file-authoring-v1'),f.seed.deadline_at);
  assert.equal(fileAuthoringUsesSmallBatches(ctx,saved),true);
  const current=Buffer.from(JSON.stringify({...JSON.parse(f.input.toString()),revision_date:new Date().toISOString()}));
  assert.deepEqual(await recoverFileAuthoringInput(ctx,saved,current),f.input);
  await mkdir(join(root,'scratch'));await mkdir(join(root,'output'));await writeFile(join(root,'task.md'),'current trusted instructions');
  await restoreFileAuthoringWork(ctx,root,saved);
  assert.equal(await readFile(join(root,'output/operations.json'),'utf8'),'{"operations":[{"id":"prior-edit"}]}');
  assert.equal(await readFile(join(root,'task.md'),'utf8'),'current trusted instructions');
  assert.equal(authorizedFileAuthoringRecovery(ctx,'file-authoring-size-repair-1'),null);
  // The next interrupted invocation uses its usual reconciliation authorization,
  // while all future rotations must keep this new run's original deadline.
  const next={...saved,attempt_id:'call-next',files:saved.files.map(ref=>({...ref,key:ref.key.replace('/'+saved.attempt_id+'/','/call-next/')}))};
  (ctx.lease.checkpoint.stages as any).file_authoring_recovery=next;
  ctx.lease.checkpoint.operator_reconciliations={'call-next':{attempt_id:'call-next',logical_call_id:'file-authoring-v1',reason_code:'file_authoring_context_rotation',decision:'retry_unknown_usage',deadline_at:f.seed.deadline_at}};
  assert.deepEqual(authorizedFileAuthoringRecovery(ctx,'file-authoring-v1'),next);
  ctx.lease.checkpoint.file_authoring_recovery_captures={'call-next':{logical_call_id:'file-authoring-v1',deadline_at:new Date(Date.parse(f.seed.deadline_at)+1).toISOString()}};
  assert.throws(()=>authorizedFileAuthoringRecovery(ctx,'file-authoring-v1'),/AUTHORING_RECOVERY_UNSAFE/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('seed cannot import a foreign run or reset an expired or current budget by altering its receipt',()=>{
 const f=fixture();assert.equal(validFileAuthoringSeed(f.seed,f.scope),true);
 for(const change of [
  (s:FileAuthoringSeed)=>{s.run_id=s.source_run_id;},(s:FileAuthoringSeed)=>{s.job_id='other-job';},
  (s:FileAuthoringSeed)=>{s.owner_user_id='other';},(s:FileAuthoringSeed)=>{s.input_revision++;},
  (s:FileAuthoringSeed)=>{s.input_hash='c'.repeat(64);},(s:FileAuthoringSeed)=>{s.budget_ms=91*60000;},
  (s:FileAuthoringSeed)=>{s.deadline_at=new Date(Date.parse(s.deadline_at)+1).toISOString();},
  (s:FileAuthoringSeed)=>{s.snapshot.files[0].key=s.snapshot.files[0].key.replace('/new-run/','/failed-run/');s.snapshot_sha256=inputManifestHash(s.snapshot);},
  (s:FileAuthoringSeed)=>{s.snapshot.files[1].path='task.md';s.snapshot_sha256=inputManifestHash(s.snapshot);},
 ]){const seed=structuredClone(f.seed);change(seed);assert.equal(validFileAuthoringSeed(seed,f.scope),false);const ctx={...f.ctx,lease:{...f.ctx.lease,checkpoint:{stages:{[FILE_AUTHORING_SEED_STAGE]:seed}}}};assert.throws(()=>fileAuthoringContextDeadline(ctx,'file-authoring-v1'),/AUTHORING_RECOVERY_UNSAFE/);}
});

test('seed requires zero net charge proven by the original exact failure refund ledger',()=>{
 const zero={ledger_settled:'0',ledger_refunded:'0',refund_complete:false};
 for(const policy of ['on_delivery','authoring_balance_v2'])for(const state of ['released','held'] as const){
  assert.equal(zeroChargeSeedReservation({...zero,state,billing_policy:policy,charged_points:'0'},state),true);
  for(const charged of ['1','-1',undefined])assert.equal(zeroChargeSeedReservation({...zero,state,billing_policy:policy,charged_points:charged},state),false);
  assert.equal(zeroChargeSeedReservation({...zero,state,billing_policy:policy,charged_points:null},state),policy==='on_delivery'&&state==='held');
  assert.equal(zeroChargeSeedReservation({...zero,state:'settled',billing_policy:policy,charged_points:'0'},state),false);
 }
 const refunded={state:'released',billing_policy:'authoring_balance_v2',charged_points:'20',ledger_settled:'20',ledger_refunded:'20',refund_complete:true};
 assert.equal(zeroChargeSeedReservation(refunded,'released'),true);
 for(const change of [{ledger_refunded:'19'},{ledger_refunded:'21'},{ledger_settled:'0'},{refund_complete:false},{state:'held'},{billing_policy:'on_delivery'},{billing_policy:'unknown'}])
  assert.equal(zeroChargeSeedReservation({...refunded,...change},'released'),false);
 assert.equal(zeroChargeSeedReservation({...zero,state:'released',billing_policy:'unknown',charged_points:'0'},'released'),false);
});
