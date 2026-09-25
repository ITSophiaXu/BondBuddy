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
