import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const receipt=()=>({version:'database-restore-safety-v1',restore_id:'synthetic-restore',backup_sha256:'a'.repeat(64),
  control_epoch:'00000000-0000-4000-8000-000000000001',audit:{complete:true,backup_at:'2026-11-21T00:00:00Z',covered_until:'2026-11-21T02:00:00Z'},
  account_ids:['synthetic-owner'],fences:[],calls:[],billing:[{owner_user_id:'synthetic-owner',sha256:'b'.repeat(64),consistent:true}],
  never_sent_runs:['run-safe']});
function signed(){const r=receipt();return {...r,manifest_sha256:hash(r)};}

test('dry validation does not require DB credentials or touch DB, and rejects changed backup bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'bb-restore-dry-'));
  try{
    const path=join(root,'receipt.json');writeFileSync(path,JSON.stringify(signed()));
    const run=spawnSync(process.execPath,['db/verify-restore.mjs','--restore-safety-dry',path,'a'.repeat(64)],
      {encoding:'utf8',env:{...process.env,DATABASE_URL:'',RESTORE_DATABASE_URL:''}});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).state,'validated_frozen');
    const changed=spawnSync(process.execPath,['db/verify-restore.mjs','--restore-safety-dry',path,'c'.repeat(64)],
      {encoding:'utf8',env:{...process.env,DATABASE_URL:'',RESTORE_DATABASE_URL:''}});
    assert.notEqual(changed.status,0);assert.match(changed.stderr,/RESTORE_BACKUP_HASH_MISMATCH/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('lost intent, incomplete audit and absent billing are unknown, never not_sent',async()=>{
  const {classifyRestoreCalls}=await import('./verify-restore.mjs');
  const job={id:'job-one',run_id:'run-safe',owner_user_id:'synthetic-owner'};
  const r=signed();r.calls=[{attempt_id:'lost',job_id:'job-one',run_id:'run-safe',owner_user_id:'synthetic-owner',logical_call_id:'call-one',status:'completed_verified',result_ref:'synthetic/result',result_sha256:'c'.repeat(64)}];
  assert.equal(classifyRestoreCalls([job],[],r)[0].classification,'unknown');
  assert.ok(classifyRestoreCalls([job],[],r)[0].reasons.includes('lost_intent'));
  r.calls=[];r.audit.complete=false;
  assert.equal(classifyRestoreCalls([job],[],r)[0].classification,'unknown');
  r.audit.complete=true;r.billing=[];
  assert.equal(classifyRestoreCalls([job],[],r)[0].classification,'unknown');
});

test('only explicitly never_sent or matched verified call with billing can be a recovery candidate',async()=>{
  const {classifyRestoreCalls}=await import('./verify-restore.mjs');
  const job={id:'job-one',run_id:'run-safe',owner_user_id:'synthetic-owner'};
  assert.equal(classifyRestoreCalls([job],[],signed())[0].classification,'recovery_candidate');
  const r=signed();r.never_sent_runs=[];r.calls=[{attempt_id:'known',job_id:'job-one',run_id:'run-safe',owner_user_id:'synthetic-owner',logical_call_id:'call-one',status:'confirmed_not_sent'}];
  assert.equal(classifyRestoreCalls([job],[{id:'known',job_id:'job-one',owner_user_id:'synthetic-owner',logical_call_id:'call-one',status:'confirmed_not_sent'}],r)[0].classification,'recovery_candidate');
});

test('restore script has a credential-free validate-only path and never starts workers after import',()=>{
  const script=readFileSync('deploy/m1/scripts/restore.sh','utf8');
  assert.match(script,/--validate-only/);
  assert.doesNotMatch(script,/compose up.*worker/);
  assert.doesNotMatch(script,/DROP DATABASE IF EXISTS bondbuddy/);
});

test('storage isolation rejects reordered credentials and custom endpoint aliases for one account',async()=>{
  const {assertRestoreStorageIsolated}=await import('../deploy/m1/scripts/restore-control.mjs');
  const source='DefaultEndpointsProtocol=https;AccountName=syntheticsource;AccountKey=c3ludGhldGlj;EndpointSuffix=core.windows.net';
  assert.throws(()=>assertRestoreStorageIsolated(source,'AccountKey=bmV3a2V5;AccountName=syntheticsource;DefaultEndpointsProtocol=https;BlobEndpoint=https://alias.example.test'),/RESTORE_STORAGE_NOT_ISOLATED/);
  assert.throws(()=>assertRestoreStorageIsolated(source,'DefaultEndpointsProtocol=https;AccountName=syntheticdifferent;AccountKey=c3ludGhldGlj;BlobEndpoint=https://syntheticsource.blob.core.windows.net'),/RESTORE_STORAGE_NOT_ISOLATED/);
  assert.equal(assertRestoreStorageIsolated(source,'DefaultEndpointsProtocol=https;AccountName=synthetictarget;AccountKey=c3ludGhldGlj;EndpointSuffix=core.windows.net').state,'storage_isolated');
});

test('receipt rejects duplicate billing owners and duplicate never-sent declarations',async()=>{
  const {validateRestoreReceipt}=await import('./verify-restore.mjs');
  for(const field of ['billing','never_sent_runs']){
    const r=receipt();r[field].push(r[field][0]);r.manifest_sha256=hash(r);
    assert.throws(()=>validateRestoreReceipt(r,r.backup_sha256),/RESTORE_RECEIPT_INVALID/);
  }
});
