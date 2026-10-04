/** Synthetic cancellation at post-CLI/durable boundaries; never calls a provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { loadReviewAuditKnowledge } from './review-knowledge.js';
import { reviewPromptRecordId } from './review-record-context.js';
import type { ReviewToolData } from './review-tools.js';
import { DEFAULT_DISABLED_FEATURES, runContainedModelCall, runCodexProcess,
  type CodexAdapterConfig, type ContainedCallInput } from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';

const fake=fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs',import.meta.url));
const fakeReview=fileURLToPath(new URL('../test-fixtures/codex/fake-review-tools.mjs',import.meta.url));
async function setup(command=fake) {
  const root=await mkdtemp(join(tmpdir(),'bb-review-cancel-'));
  const config:CodexAdapterConfig={command:[process.execPath,command],model_id:'synthetic',model_provider:'synthetic',
    base_url:'https://example.invalid',wire_api:'responses',model_config_version:'synthetic-v1',reasoning_effort:null,
    credential:{kind:'env',name:'BB_SYNTHETIC_KEY'},work_root:join(root,'work'),timeout_ms:10000,kill_grace_ms:200,
    max_output_bytes:1<<20,max_schema_reasks:1,disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH??'/usr/bin:/bin'};
  return {root,config};
}
function call(extra:Partial<ContainedCallInput>={}):ContainedCallInput {
  return {owner_user_id:'synthetic-user',project_id:'synthetic-project',job_id:'synthetic-job',run_id:'synthetic-run',
    trace_id:'synthetic-run',logical_call_id:'synthetic-review',prompt_snapshot_ref:'synthetic-prompt',
    prompt:'SCENARIO:structured',result_schema_version:'synthetic-v1',
    output:{kind:'json',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},
      validate:value=>!!value&&typeof value==='object'&&typeof (value as {answer?:unknown}).answer==='string'},...extra};
}
async function reviewData():Promise<ReviewToolData> {
  const f=reviewFixture();f.addRecord('disclosed','Synthetic disclosure: 100.00');f.addRecord('audit','Synthetic audit: 120.00',false);
  const records=f.records.map(r=>({...r,source_kind:r.material_id===f.ctx.source_material.material_id?'disclosure' as const:'audit' as const}));
  return {input:{input_hash:'f'.repeat(64),evidence:{...f.ctx,records},rule_context:null,rule_packs:[],formatting_requirements:[],
    requirements:[],scope:{mode:'full_review',finding_ids:[]},report_version:1,created_at:'2026-10-04T00:00:00Z',limitations:[]},
    knowledge:await loadReviewAuditKnowledge(),allowed_target_ids:[reviewPromptRecordId(records[0]!)]};
}

test('an already cancelled contained call records no intent and starts no process',async()=>{
  const {root,config}=await setup(),abort=new AbortController(),journal=new MemoryCodexJournal();abort.abort();
  let events=0;journal.latestAttempt=async()=>{assert.fail('cancelled call must stop before journal lookup');};
  try {
    const result=await runContainedModelCall(call({signal:abort.signal,onEvent:()=>{events++;}}),journal,config);
    assert.equal(result.error_code,'MODEL_CANCELLED');assert.equal(result.attempts.length,0);
    assert.equal(journal.intents.length,0);assert.equal(journal.observations.length,0);assert.equal(events,0);
    assert.deepEqual(await readdir(root),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the process boundary never spawns with an already aborted signal',async()=>{
  const {root,config}=await setup(),abort=new AbortController();abort.abort();
  try {
    const result=await runCodexProcess({...config,command:['/synthetic-never-launch-binary']},
      {prompt:'synthetic',cwd:root,codexHome:root,home:root,schemaFile:null,ephemeral:true,resumeThreadId:null,signal:abort.signal});
    assert.equal(result.stop,'cancelled');assert.equal(result.exit_code,null);assert.equal(result.duration_ms,0);
    assert.equal(result.usage.status,'unknown');assert.equal(result.usage.total_tokens,null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('cancellation while recording intent prevents spawn and preserves unknown usage',async()=>{
  const {root,config}=await setup(),abort=new AbortController(),journal=new MemoryCodexJournal();let events=0;
  const recordIntent=journal.recordIntent.bind(journal);
  journal.recordIntent=async intent=>{await recordIntent(intent);abort.abort();};
  try {
    const result=await runContainedModelCall(call({signal:abort.signal,onEvent:()=>{events++;}}),journal,config);
    assert.equal(result.error_code,'MODEL_CANCELLED');assert.equal(result.status,'needs_reconcile');
    assert.equal(journal.intents.length,1);assert.equal(events,0);assert.equal(result.attempts.length,1);
    assert.equal(journal.observations[0]!.retryable,false);assert.equal(result.attempts[0]!.usage.status,'unknown');
    assert.equal(result.attempts[0]!.usage.total_tokens,null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('cancellation during post-CLI review replay preserves measured usage and never re-asks',async()=>{
  const {root,config}=await setup(fakeReview),abort=new AbortController(),journal=new MemoryCodexJournal(),data=await reviewData();
  let turnCompleted=false,replayStarted=false,startedThreads=0;
  const input=data.input;
  // Trigger an actual abort at the validator's first event-loop yield, after the
  // synthetic CLI has exited. The getter returns identical immutable contents.
  Object.defineProperty(data,'input',{enumerable:true,get:()=>{
    if(turnCompleted&&!replayStarted){replayStarted=true;setImmediate(()=>abort.abort());}
    return input;
  }});
  try {
    const result=await runContainedModelCall(call({prompt:'actual',reviewTools:data,signal:abort.signal,onEvent:event=>{
      if(event.type==='turn.completed')turnCompleted=true;
      if(event.type==='thread.started')startedThreads++;
    }}),journal,config);
    assert.equal(replayStarted,true);assert.equal(abort.signal.aborted,true);
    assert.equal(result.error_code,'MODEL_CANCELLED');assert.equal(result.status,'needs_reconcile');
    assert.equal(startedThreads,1);assert.equal(journal.intents.length,1);assert.equal(result.attempts.length,1);
    assert.equal(journal.observations[0]!.retryable,false);assert.equal(journal.observations[0]!.observation.outcome,'pending_reconcile');
    assert.equal(result.attempts[0]!.usage.status,'measured');assert.equal(result.attempts[0]!.usage.input_tokens,100);
    assert.equal(result.attempts[0]!.usage.output_tokens,30);assert.equal(result.attempts[0]!.usage.total_tokens,130);
    assert.equal(journal.results.size,0,'interrupted verification cannot accept the output');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('cancellation during a settled invalid observation prevents the next re-ask intent',async()=>{
  const {root,config}=await setup(),abort=new AbortController(),journal=new MemoryCodexJournal();let startedThreads=0;
  const recordObservation=journal.recordObservation.bind(journal);
  journal.recordObservation=async(observation,options)=>{await recordObservation(observation,options);abort.abort();};
  try {
    const result=await runContainedModelCall(call({prompt:'SCENARIO:invalid_json REASK_SCENARIO:structured',signal:abort.signal,
      onEvent:event=>{if(event.type==='thread.started')startedThreads++;}}),journal,config);
    assert.equal(result.error_code,'MODEL_CANCELLED');assert.equal(journal.intents.length,1);assert.equal(startedThreads,1);
    assert.equal(result.attempts.length,1);assert.equal(result.attempts[0]!.usage.status,'measured');
    assert.equal(result.attempts[0]!.error_code,'MODEL_OUTPUT_SCHEMA_INVALID','keep the already recorded settled evidence');
  }finally{await rm(root,{recursive:true,force:true});}
});
