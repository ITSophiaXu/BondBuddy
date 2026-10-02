import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelGenerationRouter } from './model-generation-router.js';
import type { NoHistoryStageAdapters } from './no-history-model-stage.js';
import type { RunStage, StageContext } from './run-pipeline.js';

function context(taskKind: string): StageContext {
  return {
    pool: {} as StageContext['pool'], blobs: {} as StageContext['blobs'], lease: {} as StageContext['lease'],
    run: { id: 'run-1', owner_user_id: 'owner-1', project_id: 'project-1', input_revision: 1, input_hash: 'a'.repeat(64), task_kind: taskKind },
    signal: new AbortController().signal, checkpoint: {}, values: new Map(),
  };
}

test('router sends update tasks to the existing historical stage without entering generation', async () => {
  let updateCalls = 0;
  const historical: RunStage = { name: 'model_generation', run: async ctx => {
    updateCalls++;
    assert.equal(ctx.run.task_kind, 'update');
    return { kind: 'done', value: { schema_version: 'historical-update-plan-v1' } };
  } };
  const result = await modelGenerationRouter({ historicalStage: historical }).run(context('update'));
  assert.equal(result.kind, 'done');
  assert.equal(updateCalls, 1);
});

test('default generation route pauses needs_review before any provider call', async () => {
  const result = await modelGenerationRouter().run(context('generation'));
  assert.deepEqual(result, {
    kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:no_history_generation_adapters_not_installed',
  });
});

test('injected trusted adapters use the existing #33 stage and stop at its reviewed-profile gate', async () => {
  let profileReads = 0, ruleReads = 0, factReads = 0, providerConfigReads = 0;
  const adapters: NoHistoryStageAdapters = {
    loadReviewedIssuerProfile: async () => { profileReads++; return null; },
    loadTrustedRuleSelection: async () => { ruleReads++; throw new Error('Rule gate must follow reviewed issuer profile'); },
    loadTargetFacts: async () => { factReads++; throw new Error('Facts must follow reviewed issuer profile'); },
    selectReference: async () => { throw new Error('Reference must follow reviewed issuer profile'); },
    loadReferenceOutline: async () => { throw new Error('Outline must follow reviewed issuer profile'); },
    codexConfig: () => { providerConfigReads++; throw new Error('Provider config must not be read before gates pass'); },
    templateVersion: 'synthetic-test-only',
  };
  const result = await modelGenerationRouter({ noHistoryAdapters: adapters }).run(context('generation'));
  assert.deepEqual(result, {
    kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:issuer_annual_business_profile_missing_or_unreviewed',
  });
  assert.equal(profileReads, 1);
  assert.equal(ruleReads + factReads + providerConfigReads, 0);
});

test('unrecognized task kinds do not fall through to either generator', async () => {
  let updateCalls = 0;
  const historical: RunStage = { name: 'model_generation', run: async () => { updateCalls++; return { kind: 'done' }; } };
  const result = await modelGenerationRouter({ historicalStage: historical }).run(context('review'));
  assert.deepEqual(result, { kind: 'pause', stage: 'capability_not_ready', reason: 'unsupported_model_generation_task_kind' });
  assert.equal(updateCalls, 0);
});

test('fresh unified authoring uses original files without entering legacy or revision generation',async()=>{
  const checkpoints:StageContext['checkpoint'][]=[{},{file_authoring_v1:{attempt:1}}];
  for(const checkpoint of checkpoints) {
    const ctx=context('update');ctx.checkpoint=checkpoint;
    ctx.values.set('input_lock',{authoring_mode:'unified_v1',review_revision:false});
    let fileCalls=0;
    const result=await modelGenerationRouter({
      unifiedStage:()=>{throw new Error('fresh M1 must use original-file authoring');},
      fileStage:()=>({name:'model_generation',run:async received=>{
        fileCalls++;assert.equal(received,ctx);return {kind:'done',value:{route:'file'}};
      }}),
    }).run(ctx);
    assert.deepEqual(result,{kind:'done',value:{route:'file'}});assert.equal(fileCalls,1);
  }
});

test('validated finding revisions take precedence over fresh and legacy authoring checkpoints',async()=>{
  const checkpoints:StageContext['checkpoint'][]=[{},{unified_v3_0:{attempt:1}},{unified_v4_0:{attempt:1}}];
  for(const checkpoint of checkpoints) {
    const ctx=context('update');ctx.checkpoint=checkpoint;
    ctx.values.set('input_lock',{authoring_mode:'unified_v1',review_revision:true});
    let revisionCalls=0;
    const result=await modelGenerationRouter({
      fileStage:()=>{throw new Error('finding revisions must never use full-document authoring');},
      unifiedStage:options=>{
        assert.equal(options,undefined,'the dedicated stage derives revision details from the locked manifest');
        return {name:'model_generation',run:async received=>{
          revisionCalls++;assert.equal(received,ctx);return {kind:'done',value:{route:'revision'}};
        }};
      },
    }).run(ctx);
    assert.deepEqual(result,{kind:'done',value:{route:'revision'}});assert.equal(revisionCalls,1);
  }
});

test('legacy unified v3 and v4 calls retain their original direct-mode selection on replay',async()=>{
  for(const [key,direct] of [['unified_v3_0',false],['unified_v4_0',true]] as const) {
    const ctx=context('update');ctx.checkpoint={[key]:{attempt:1}};
    ctx.values.set('input_lock',{authoring_mode:'unified_v1'});
    let legacyCalls=0;
    const result=await modelGenerationRouter({
      fileStage:()=>{throw new Error('old calls must keep their logical call IDs');},
      unifiedStage:options=>{
        assert.deepEqual(options,{direct});
        return {name:'model_generation',run:async()=>{legacyCalls++;return {kind:'done',value:{route:key}};}};
      },
    }).run(ctx);
    assert.deepEqual(result,{kind:'done',value:{route:key}});assert.equal(legacyCalls,1);
  }
});

test('review route retains its public stage and returns the resulting report',async()=>{
  const ctx=context('review');ctx.values.set('input_lock',{review_mode:'review_v1'});
  const reviewed={report:{report_id:'draft'},observations:['synthetic']};
  const published={report_id:'published'};
  const result=await modelGenerationRouter({
    reviewStage:{name:'model_generation',run:async()=>({kind:'done',value:reviewed})},
    publicStage:{name:'model_generation',run:async received=>{
      assert.equal(received.values.get('model_generation'),reviewed);return {kind:'done',value:published};
    }},
    fileStage:()=>{throw new Error('review is not full-document authoring');},
    unifiedStage:()=>{throw new Error('review is not finding revision');},
  }).run(ctx);
  assert.deepEqual(result,{kind:'done',value:{...reviewed,report:published}});
});
