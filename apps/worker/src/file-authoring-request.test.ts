import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import type { RunSupplementAuthoringPreparation } from '@bondbuddy/api/run-supplement-preparation';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { buildFileAuthoringRequest } from './file-authoring-request.js';
import { fileAuthoringStage } from './file-authoring-stage.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import type { UnifiedInput } from './unified-input.js';
import type { StageContext, codexModelStage } from './run-pipeline.js';
import type { CompleteRunSupplementProcessingPreparation } from './run-supplement-processing-request.js';

const hash = (value: string) => digest(value);
function fixture() {
  const bytes = makeWorkerDocxFixture({ externalLink: false });
  const source = { material_id: 'source', material_version: 1, role: 'historical', sha256: digest(bytes) };
  const input = { manifest: { issuer_name: '合成目标企业', market: 'sse', offering: 'private',
    update_details: emptyUpdateDetails(), materials: [source],
    authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [],
      knowledge: [{ path: 'synthetic.md', markdown: '合成编制要求', sha256: hash('合成编制要求') }] } },
    materials: [{ pin: source, filename: '原稿.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      objectKey: 'source-object', records: [] }], requirements: ['准确保存的原始要求'] } as unknown as UnifiedInput;
  const blobs = { getIfExistsBounded: async () => bytes } as unknown as PrivateBlobs;
  // This is a builder fixture only, not a persisted receipt or an executable V2.
  const preparation = { version: 'run-supplement-authoring-preparation-v1', owner: 'owner', projectId: 'project',
    runId: 'run', revision: 2, requestId: 'receipt-2', requestHash: hash('request'),
    sourceExecution: { executionVersion: 1, inputRevision: 1, inputHash: hash('old-input') },
    checkpointHash: hash('checkpoint'), candidateInputHash: hash('candidate'), planHash: hash('plan'),
    delta: { additions: [], replacements: [], unchanged: [],
      sourceProspectuses: { previous: [], current: [] }, discardPreviousOutput: false },
    priorWork: { source: { kind: 'provider_result', resultId: 'result', resultSchemaVersion: 'codex-file-word-v1' },
      resultHash: hash('result'), files: ['tracked.docx', 'clean.docx', 'baseline.docx', 'delivery.md'].map(name => ({
        version: 'captured-supplement-file-v1', owner: 'owner', projectId: 'project', runId: 'run', revision: 2,
        executionVersion: 1, inputRevision: 1, inputHash: hash('old-input'), checkpointHash: hash('checkpoint'),
        sourceHash: hash('result'), source: { kind: 'provider_result', resultId: 'result', resultSchemaVersion: 'codex-file-word-v1' },
        name, key: `old-work/${name}`, sha256: digest(bytes), byteSize: bytes.length,
        mediaType: name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown',
      })) } } as unknown as RunSupplementAuthoringPreparation;
  return { bytes, input, blobs, preparation };
}

async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-authoring-request-'));
  try { await visit(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('production V1 stage uses the shared request writer and retains its original baseline and prompt', async () => {
  const { input, blobs, bytes } = fixture();
  let calls = 0;
  const model = ((options: Parameters<typeof codexModelStage>[0]) => ({ name: 'fixture', run: async () => {
    calls++;
    assert.match(await options.buildPrompt({} as StageContext), /输入锁：old-hash。$/);
    assert.doesNotMatch(await options.buildPrompt({} as StageContext), /previous_work|continuation/);
    await workspace(async cwd => {
      await options.fileWorkspace!.prepare(cwd);
      const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
      assert.equal(data.baseline_path, 'materials/m0.docx');
      assert.equal(data.baseline_kind, 'uploaded_source');
      assert.equal(data.continuation, undefined);
      assert.equal(data.previous_output, null);
      assert.deepEqual(await readFile(join(cwd, data.baseline_path)), bytes);
      assert.deepEqual(data.requirements, input.requirements);
    });
    return { kind: 'done', value: 'prepared-only' } as const;
  } })) as typeof codexModelStage;
  const ctx = { run: { input_hash: 'old-hash' }, lease: { checkpoint: {} }, blobs } as unknown as StageContext;
  assert.deepEqual(await fileAuthoringStage({ model, load: async () => input }).run(ctx), { kind: 'done', value: 'prepared-only' });
  assert.equal(calls, 1);
});

test('continuation writes exact old files and delta into the same real writer, with the saved clean baseline', async () => {
  const { input, blobs, bytes, preparation } = fixture();
  const request = buildFileAuthoringRequest({ input, blobs, inputHash: preparation.candidateInputHash,
    continuation: { preparation, readFile: async () => bytes } });
  await workspace(async cwd => {
    await request.prepare(cwd); await request.verifyOriginals(cwd);
    const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    assert.equal(data.input_hash, preparation.candidateInputHash);
    assert.equal(data.baseline_path, 'previous_work/clean.docx');
    assert.equal(data.baseline_kind, 'saved_clean_work');
    assert.equal(data.materials[0].editing_baseline, false);
    assert.equal(data.previous_output, null);
    assert.deepEqual(data.continuation.delta, preparation.delta);
    assert.equal(data.continuation.previous_work.files.find((file: any) => file.name === 'baseline.docx').use, 'source_reference');
    assert.equal(data.continuation.revision_history, 'changes_from_saved_clean_only');
    assert.deepEqual(await readFile(join(cwd, 'previous_work/clean.docx')), bytes);
    assert.match(await request.buildPrompt(), /不重建从最初上传原稿开始的完整修订历史/);
    assert.equal(request.sourceHash, digest(bytes));
  });
});

test('discard intent keeps old clean out of the actual baseline and never fabricates previous_output', async () => {
  const { input, blobs, bytes, preparation } = fixture(); preparation.delta.discardPreviousOutput = true;
  const request = buildFileAuthoringRequest({ input, blobs, inputHash: preparation.candidateInputHash,
    continuation: { preparation, readFile: async () => bytes } });
  await workspace(async cwd => {
    await request.prepare(cwd);
    const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    assert.equal(data.baseline_path, 'materials/m0.docx');
    assert.equal(data.baseline_kind, 'uploaded_source');
    assert.equal(data.continuation.previous_work.files.every((file: any) => file.use === 'source_reference'), true);
    assert.match(await request.buildPrompt(), /禁止把其中的 clean、tracked 或 baseline 用作本轮编辑基线/);
  });
});

test('all prior references and continuation metadata are original inputs whose mutation is rejected', async () => {
  for (const path of ['previous_work/clean.docx', 'previous_work/tracked.docx', 'previous_work/baseline.docx', 'continuation.json', 'input.json']) {
    const { input, blobs, bytes, preparation } = fixture();
    const request = buildFileAuthoringRequest({ input, blobs, inputHash: preparation.candidateInputHash,
      continuation: { preparation, readFile: async () => bytes } });
    await workspace(async cwd => {
      await request.prepare(cwd); await chmod(join(cwd, path), 0o600); await writeFile(join(cwd, path), 'changed');
      await assert.rejects(request.verifyOriginals(cwd), /INPUT_REVISION_CONFLICT/);
    });
  }
});

test('missing or changed input bytes reject preparation without producing new output', async () => {
  for (const kind of ['material', 'old_work'] as const) {
    const { input, blobs, bytes, preparation } = fixture();
    if (kind === 'material') blobs.getIfExistsBounded = async () => null;
    const request = buildFileAuthoringRequest({ input, blobs, inputHash: preparation.candidateInputHash,
      continuation: { preparation, readFile: async () => kind === 'old_work' ? Buffer.from('changed') : bytes } });
    await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /INPUT_REVISION_CONFLICT/); });
  }
});

test('durable processing provenance enters the real M1 continuation without changing its saved clean baseline', async () => {
  const { input, blobs, bytes, preparation } = fixture();
  const durable = { ...preparation, version: 'run-supplement-processing-basis-v1', kind: 'authoring',
    reviewSnapshot: null, priorWorkStatus: 'captured_complete', basisHash: hash('basis'), processingPlanId: 'persisted-plan',
    priorWork: { ...preparation.priorWork, metadata: {} } } as CompleteRunSupplementProcessingPreparation;
  const request = buildFileAuthoringRequest({ input, blobs, inputHash: durable.candidateInputHash,
    continuation: { preparation: durable, readFile: async () => bytes } });
  await workspace(async cwd => {
    await request.prepare(cwd); await request.verifyOriginals(cwd);
    const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    assert.equal(data.continuation.version, durable.version);
    assert.equal(data.continuation.processing_plan_id, durable.processingPlanId);
    assert.equal(data.continuation.plan_hash, durable.planHash);
    assert.equal(data.continuation.basis_hash, durable.basisHash);
    assert.equal(data.baseline_path, 'previous_work/clean.docx');
    await chmod(join(cwd, 'continuation.json'), 0o600);
    await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ ...data.continuation, basis_hash: hash('different basis') }));
    await assert.rejects(request.verifyOriginals(cwd), /INPUT_REVISION_CONFLICT/);
  });
});
