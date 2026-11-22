import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelGenerationRouter } from './model-generation-router.js';
import type { NoHistoryStageAdapters } from './no-history-model-stage.js';
import type { RunStage, StageContext } from './run-pipeline.js';

function context(taskKind: string): StageContext {
  return {
    pool: {} as StageContext['pool'],
    blobs: {} as StageContext['blobs'],
    lease: {} as StageContext['lease'],
    run: {
      id: 'run-1',
      owner_user_id: 'owner-1',
      project_id: 'project-1',
      input_revision: 1,
      input_hash: 'a'.repeat(64),
      task_kind: taskKind,
    },
    signal: new AbortController().signal,
    checkpoint: {},
    values: new Map(),
  };
}

test('router sends update tasks to the existing historical stage without entering generation', async () => {
  let updateCalls = 0;
  const historical: RunStage = {
    name: 'model_generation',
    run: async (ctx) => {
      updateCalls++;
      assert.equal(ctx.run.task_kind, 'update');
      return { kind: 'done', value: { schema_version: 'historical-update-plan-v1' } };
    },
  };
  const result = await modelGenerationRouter({ historicalStage: historical }).run(
    context('update'),
  );
  assert.equal(result.kind, 'done');
  assert.equal(updateCalls, 1);
});

test('default generation route pauses needs_review before any provider call', async () => {
  const result = await modelGenerationRouter().run(context('generation'));
  assert.deepEqual(result, {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'needs_review:no_history_generation_adapters_not_installed',
  });
});

test('injected trusted adapters use the existing #33 stage and stop at its reviewed-profile gate', async () => {
  let profileReads = 0,
    ruleReads = 0,
    factReads = 0,
    providerConfigReads = 0;
  const adapters: NoHistoryStageAdapters = {
    loadReviewedIssuerProfile: async () => {
      profileReads++;
      return null;
    },
    loadTrustedRuleSelection: async () => {
      ruleReads++;
      throw new Error('Rule gate must follow reviewed issuer profile');
    },
    loadTargetFacts: async () => {
      factReads++;
      throw new Error('Facts must follow reviewed issuer profile');
    },
    selectReference: async () => {
      throw new Error('Reference must follow reviewed issuer profile');
    },
    loadReferenceOutline: async () => {
      throw new Error('Outline must follow reviewed issuer profile');
    },
    codexConfig: () => {
      providerConfigReads++;
      throw new Error('Provider config must not be read before gates pass');
    },
    templateVersion: 'synthetic-test-only',
  };
  const result = await modelGenerationRouter({ noHistoryAdapters: adapters }).run(
    context('generation'),
  );
  assert.deepEqual(result, {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'needs_review:issuer_annual_business_profile_missing_or_unreviewed',
  });
  assert.equal(profileReads, 1);
  assert.equal(ruleReads + factReads + providerConfigReads, 0);
});

test('unrecognized task kinds do not fall through to either generator', async () => {
  let updateCalls = 0;
  const historical: RunStage = {
    name: 'model_generation',
    run: async () => {
      updateCalls++;
      return { kind: 'done' };
    },
  };
  const result = await modelGenerationRouter({ historicalStage: historical }).run(
    context('review'),
  );
  assert.deepEqual(result, {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'unsupported_model_generation_task_kind',
  });
  assert.equal(updateCalls, 0);
});
test('accepted M3 revisions retain the bounded revision stage while ordinary authoring uses original files', async () => {
  let revisions = 0,
    files = 0;
  const router = modelGenerationRouter({
    revisionStage: {
      name: 'model_generation',
      run: async () => {
        revisions++;
        return { kind: 'done', value: 'revision' };
      },
    },
    fileStage: {
      name: 'model_generation',
      run: async () => {
        files++;
        return { kind: 'done', value: 'files' };
      },
    },
  });
  const revised = context('update');
  revised.values.set('input_lock', { authoring_mode: 'unified_v1', review_revision: true });
  assert.deepEqual(await router.run(revised), { kind: 'done', value: 'revision' });
  assert.equal(files, 0);
  const authored = context('update');
  authored.values.set('input_lock', { authoring_mode: 'unified_v1', review_revision: false });
  assert.deepEqual(await router.run(authored), { kind: 'done', value: 'files' });
  assert.equal(revisions, 1);
  assert.equal(files, 1);
});
test('review mode precedes ordinary authoring and continues to the independent public stage', async () => {
  let reviews = 0,
    publicChecks = 0,
    files = 0;
  const ctx = context('update');
  ctx.values.set('input_lock', { review_mode: 'review_v1', authoring_mode: 'unified_v1' });
  const result = await modelGenerationRouter({
    reviewStage: {
      name: 'model_generation',
      run: async () => {
        reviews++;
        return { kind: 'done', value: { version: 'review-analysis-v1' } };
      },
    },
    publicStage: {
      name: 'public_review',
      run: async () => {
        publicChecks++;
        return { kind: 'done', value: 'public-result' };
      },
    },
    fileStage: {
      name: 'model_generation',
      run: async () => {
        files++;
        return { kind: 'done' };
      },
    },
  }).run(ctx);
  assert.deepEqual(result, {
    kind: 'done',
    value: { version: 'review-analysis-v1', report: 'public-result' },
  });
  assert.equal(reviews, 1);
  assert.equal(publicChecks, 1);
  assert.equal(files, 0);
});

test('legacy revision recovery never starts a new CLI file task; mixed modes pause', async () => {
  let cli = 0,
    legacy = 0;
  const router = modelGenerationRouter({
    revisionStage: {
      name: 'model_generation',
      run: async () => {
        cli++;
        return { kind: 'done', value: 'cli' };
      },
    },
    legacyRevisionStage: {
      name: 'model_generation',
      run: async () => {
        legacy++;
        return { kind: 'done', value: 'legacy' };
      },
    },
  });
  const ctx = context('update');
  ctx.values.set('input_lock', { authoring_mode: 'unified_v1', review_revision: true });
  ctx.checkpoint.review_revision_0_prompt = { snapshot_id: 'saved' };
  assert.deepEqual(await router.run(ctx), { kind: 'done', value: 'legacy' });
  assert.equal(cli, 0);
  ctx.checkpoint.review_revision_cli_v1_prompt = { snapshot_id: 'other' };
  assert.deepEqual(await router.run(ctx), {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'revision_execution_mode_changed',
  });
  assert.equal(legacy, 1);
  assert.equal(cli, 0);
});

test('public review method pins survive the combined model-generation checkpoint', async () => {
  const ctx = context('review');
  ctx.values.set('input_lock', { review_mode: 'review_v1' });
  const publicPin = { execution_mode: 'cli-public-v2', public_context_sha256: 'a'.repeat(64) };
  const result = await modelGenerationRouter({
    reviewStage: {
      name: 'model_generation',
      run: async () => ({
        kind: 'done',
        value: { version: 'review-analysis-v1' },
        checkpoint: { execution_mode: 'cli-led-v3' },
      }),
    },
    publicStage: {
      name: 'public_review',
      run: async () => ({ kind: 'done', value: 'report', checkpoint: publicPin }),
    },
  }).run(ctx);
  assert.equal(result.kind, 'done');
  if (result.kind === 'done')
    assert.deepEqual(result.checkpoint, { execution_mode: 'cli-led-v3', public_review: publicPin });
});
