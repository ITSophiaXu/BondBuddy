import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { reviewRevisionCliStage, reviewRevisionCliDeliveryStage, REVIEW_REVISION_CLI_CHECKPOINT,
  validReviewRevisionCliResult, type ReviewRevisionCliResult } from './review-revision-cli-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { revisionCliFixture as fixture } from './review-revision-cli-test-fixture.js';

const python = process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3';
const execute = promisify(execFile);
const config = { ...loadCodexAdapterConfig({}), work_root: tmpdir() };

const persist: NonNullable<Parameters<typeof reviewRevisionCliStage>[0]>['checkpoint'] = async (_pool, _lease, _name, _value) => {};

test('one CLI owns revision generation; collector verifies and delivery only reads durable artifacts', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, model: options => ({ name: options.name, run: async ctx => {
      calls++; assert.ok(ctx.checkpoint[REVIEW_REVISION_CLI_CHECKPOINT], 'method is persisted before the model send');
      assert.equal(options.logicalCallId, 'review-revision-cli-v1'); assert.ok(options.fileWorkspace);
      assert.match(await options.buildPrompt(ctx), /accepted revision/);
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      const locked = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
      assert.equal(locked.materials.length, 2); assert.equal(locked.records.length, 2); assert.deepEqual(locked.revision, f.pin);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-call' } as never);
      assert.ok(options.validate(value)); return { kind: 'done', value };
    } }) });
    const result = await stage.run(f.ctx); assert.equal(result.kind, 'done'); assert.equal(calls, 1);
    if (result.kind !== 'done') throw Error('expected completed CLI');
    const value = result.value as ReviewRevisionCliResult;
    assert.equal(value.error, undefined); assert.ok(validReviewRevisionCliResult(value, f.ctx, f.pin));
    assert.equal(value.handling?.items[0]?.status, 'modified'); assert.equal(value.handling?.items[1]?.status, 'not_modified');
    assert.equal(value.summary.method, 'review-revision-cli-v1');
    f.ctx.values.set('model_generation', value);
    const delivery = await reviewRevisionCliDeliveryStage().run(f.ctx);
    assert.equal(delivery.kind, 'deliver'); assert.equal(calls, 1);
    if (delivery.kind !== 'deliver') throw Error('expected delivery');
    assert.ok(delivery.cleanBytes?.length); assert.ok(delivery.baselineBytes?.length); assert.equal(delivery.deliveryPolicy, undefined);
    assert.deepEqual(delivery.wordSummary?.revision_handling, value.handling); assert.equal(delivery.wordSummary?.review_passed, false);
    assert.equal(result.checkpoint?.execution_mode, 'review-revision-cli-v1');
    const originalRef = value.files['clean.docx']!.key;
    value.files['clean.docx']!.key = originalRef.replace('owners/owner/', 'owners/other/');
    assert.equal(validReviewRevisionCliResult(value, f.ctx), false);
    value.files['clean.docx']!.key = originalRef;
    f.blobs.set(originalRef, Buffer.from('tampered stored file'));
    await assert.rejects(reviewRevisionCliDeliveryStage().run(f.ctx), /WORD_OUTPUT_BLOB_MISMATCH/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('post-tool mutation outside the accepted paragraph is durably rejected before any delivery', async () => {
  const f = await fixture();
  try {
    const result = await reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, model: options => ({ name: options.name, run: async () => {
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      await execute(python, ['-B', '-c', 'from docx import Document; import sys; d=Document(sys.argv[1]); d.paragraphs[1].text="Unauthorized replacement"; d.save(sys.argv[1])', join(cwd, 'output/clean.docx')]);
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-call' } as never);
      assert.ok(options.validate(value), 'settled rejection preserves provider result/usage');
      return { kind: 'done', value };
    } }) }).run(f.ctx);
    assert.equal(result.kind, 'done'); if (result.kind !== 'done') throw Error('expected settled rejection');
    const value = result.value as ReviewRevisionCliResult; assert.equal(value.error, 'WORD_QUALITY_REJECTED');
    assert.deepEqual(value.files, {}); f.ctx.values.set('model_generation', value);
    assert.deepEqual(await reviewRevisionCliDeliveryStage().run(f.ctx), { kind: 'fail', code: 'WORD_QUALITY_REJECTED' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('changed method pauses before another provider call and unknown result never reaches delivery', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, model: options => ({ name: options.name, run: async () => {
      calls++; return { kind: 'pause', stage: 'provider_reconcile', reason: 'provider_result_pending' };
    } }) });
    assert.deepEqual(await stage.run(f.ctx), { kind: 'pause', stage: 'provider_reconcile', reason: 'provider_result_pending' });
    assert.equal(calls, 1);
    f.ctx.checkpoint[REVIEW_REVISION_CLI_CHECKPOINT]!.helpers_sha256 = 'f'.repeat(64);
    assert.deepEqual(await stage.run(f.ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_cli_method_changed' });
    assert.equal(calls, 1); assert.equal(f.ctx.values.get('model_generation'), undefined);
    delete f.ctx.checkpoint[REVIEW_REVISION_CLI_CHECKPOINT];
    f.ctx.checkpoint.review_revision_cli_v1_prompt = { prompt_snapshot_ref: 'old-unpinned-prompt' };
    assert.deepEqual(await stage.run(f.ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_cli_method_missing' });
    assert.equal(calls, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('storage and verifier startup outages remain infrastructure failures rather than false quality rejections', async () => {
  for (const mode of ['storage', 'verifier']) {
  const f = await fixture();
  const priorPython = process.env.BONDBUDDY_WORD_PYTHON;
  try {
    if (mode === 'storage') f.ctx.blobs.put = async () => { throw Error('SYNTHETIC_BLOB_OUTAGE'); };
    const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, model: options => ({ name: options.name, run: async () => {
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      if (mode === 'verifier') process.env.BONDBUDDY_WORD_PYTHON = join(f.root, 'missing-python-binary');
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-outage' } as never);
      return { kind: 'done', value };
    } }) });
    await assert.rejects(stage.run(f.ctx), mode === 'storage' ? /SYNTHETIC_BLOB_OUTAGE/ : /ENOENT/);
    assert.equal(f.ctx.values.get('model_generation'), undefined);
  } finally {
    if (priorPython === undefined) delete process.env.BONDBUDDY_WORD_PYTHON; else process.env.BONDBUDDY_WORD_PYTHON = priorPython;
    await rm(f.root, { recursive: true, force: true });
  }
  }
});

test('no safe changes preserves actual handling and pauses instead of delivering an empty Word revision', async () => {
  const f = await fixture();
  try {
    f.proposal.edits = [];
    f.proposal.handling[0]!.status = 'needs_evidence';
    f.proposal.handling[0]!.reason = 'Original evidence does not establish the intended period.';
    const result = await reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, model: options => ({ name: options.name, run: async () => {
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-no-changes' } as never);
      assert.ok(options.validate(value)); return { kind: 'done', value };
    } }) }).run(f.ctx);
    assert.equal(result.kind, 'done'); if (result.kind !== 'done') throw Error('expected actual handling');
    const value = result.value as ReviewRevisionCliResult;
    assert.equal(value.error, undefined); assert.equal(value.summary.no_changes, true); assert.equal(value.files['tracked.docx'], undefined);
    assert.equal(value.handling?.items[0]?.status, 'needs_evidence');
    f.ctx.values.set('model_generation', value);
    assert.deepEqual(await reviewRevisionCliDeliveryStage().run(f.ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_no_verified_changes' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('delivery rejects a different execution method and invented error states', async () => {
  const f = await fixture();
  try {
    const rejected: ReviewRevisionCliResult = { version: 'review-revision-cli-v1', input_hash: f.ctx.run.input_hash,
      revision_pin_sha256: inputManifestHash(f.pin), skill_sha256: 'f'.repeat(64), files: {},
      summary: { validation_error: 'WORD_REVISION_SCOPE_OR_ARTIFACT_INVALID' }, error: 'WORD_QUALITY_REJECTED' };
    assert.equal(validReviewRevisionCliResult({ ...rejected, error: 'INVENTED_ERROR' }, f.ctx), false);
    assert.equal(validReviewRevisionCliResult({ ...rejected, input_hash: '0'.repeat(64) }, f.ctx), false);
    f.ctx.values.set('model_generation', { ...rejected, version: 'codex-file-word-v1' });
    assert.deepEqual(await reviewRevisionCliDeliveryStage().run(f.ctx), { kind: 'fail', code: 'VALIDATION_FAILED' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
