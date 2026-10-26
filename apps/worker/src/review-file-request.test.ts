import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import type { RunSupplementFilePreparation } from '@bondbuddy/api/run-supplement-preparation';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { buildReviewFileRequest, type ReviewFileInput } from './review-file-request.js';
import { reviewFileStage } from './review-file-stage.js';
import type { StageContext, codexModelStage } from './run-pipeline.js';

function fixture(operation: 'full_review' | 'differential_review' = 'full_review') {
  const source = Buffer.from('Candidate source'), evidence = Buffer.from('Replacement evidence');
  const oldReport = Buffer.from('Old report with unverified issue OLD-1'), oldMarkdown = Buffer.from('### OLD-1 must be checked again');
  const pin = { material_id: 'source', material_version: 2, sha256: digest(source), role: 'historical' };
  const added = { material_id: 'evidence', material_version: 1, sha256: digest(evidence), role: 'audit' };
  const selected = operation === 'full_review' ? [] : [{ finding_id: 'selected-1', text: 'Explicit selected finding' }];
  const input: ReviewFileInput = { manifest: { issuer_name: 'Synthetic', market: 'sse', offering: 'private', materials: [pin, added],
    review: { version: 'review_v1', operation, report_id: 'new-report', version_number: 2,
      source_report_id: operation === 'full_review' ? null : 'source-report', source_report_sha256: null,
      finding_ids: operation === 'full_review' ? [] : ['selected-1'],
      input: { source_material_ref: pin, material_versions: [pin, added], requirements: ['Exact submitted scope'], as_of: null },
      file_delivery: { version: 'review-file-v1', knowledge: [{ path: 'synthetic.md', markdown: 'Synthetic method', sha256: digest('Synthetic method') }] } } },
    materials: [{ pin, object_key: 'source-key', media_type: 'text/plain', filename: 'source.txt' },
      { pin: added, object_key: 'evidence-key', media_type: 'application/pdf', filename: 'evidence.pdf' }], selected_findings: selected };
  const store = new Map([['source-key', source], ['evidence-key', evidence]]);
  const blobs: PrivateBlobs = {
    put: async () => { throw Error('Unexpected private blob write'); },
    delete: async () => { throw Error('Unexpected private blob delete'); },
    get: async key => { const bytes = store.get(key); if (!bytes) throw Error('Missing private blob'); return bytes; },
    getIfExists: async key => store.get(key) ?? null,
    getIfExistsBounded: async (key, maxBytes) => {
      const bytes = store.get(key); if (bytes && bytes.length > maxBytes) throw Error('Private blob exceeds read bound');
      return bytes ?? null;
    },
    exists: async key => store.has(key),
  };
  const priorBytes = new Map([['report.docx', oldReport], ['report.md', oldMarkdown]]);
  const scoped = (value: typeof pin) => ({ ...value, source_project_id: 'project' });
  const preparation: RunSupplementFilePreparation = { version: 'run-supplement-file-preparation-v1', kind: 'review',
    owner: 'owner', projectId: 'project', runId: 'run', revision: 1, requestId: 'request', requestHash: 'b'.repeat(64),
    sourceExecution: { executionVersion: 1, inputRevision: 1, inputHash: 'a'.repeat(64) },
    checkpointHash: 'c'.repeat(64), candidateInputHash: 'd'.repeat(64), manifest: input.manifest,
    reviewSnapshot: { input: input.manifest.review.input }, materials: input.materials.map(item => ({ pin: scoped(item.pin),
      filename: item.filename, mediaType: item.media_type, objectKey: item.object_key })),
    delta: { additions: [scoped(added)], replacements: [{ previous: scoped({ ...pin, material_version: 1 }), current: scoped(pin) }],
      unchanged: [], sourceProspectuses: { previous: [], current: [] }, discardPreviousOutput: false },
    priorWork: { source: { kind: 'provider_result', resultId: 'saved-result', resultSchemaVersion: 'codex-review-file-v1' },
      resultHash: 'e'.repeat(64), metadata: {}, files: [...priorBytes].map(([name, bytes]) => ({
        version: 'captured-supplement-file-v1', owner: 'owner', projectId: 'project', runId: 'run', revision: 1,
        executionVersion: 1, inputRevision: 1, inputHash: 'a'.repeat(64), checkpointHash: 'c'.repeat(64), sourceHash: 'e'.repeat(64),
        source: { kind: 'provider_result', resultId: 'saved-result', resultSchemaVersion: 'codex-review-file-v1' }, name, key: `old/${name}`,
        sha256: digest(bytes), byteSize: bytes.length, mediaType: name.endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown' })) }, planHash: 'f'.repeat(64) };
  return { input, preparation, blobs, store, priorBytes };
}

async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-review-request-'));
  try { await visit(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('production V1 uses the extracted writer with its exact original prompt and input shape', async () => {
  const f = fixture(), config = { ...loadCodexAdapterConfig({}), web_search: 'disabled' as const };
  let calls = 0;
  const model = ((options: Parameters<typeof codexModelStage>[0]) => ({ name: 'fixture', run: async () => {
    calls++;
    // Golden hash from the pre-extraction production prompt, with this input lock.
    assert.equal(digest(await options.buildPrompt({} as StageContext)), '272bc14d315c08b3a5c9c9d6a8c989cc437295193d3e5c2e6ce00bf6c44326fb');
    assert.equal(options.templateVersion, 'review-file-progress-v3');
    await workspace(async cwd => {
      await options.fileWorkspace!.prepare(cwd);
      const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
      assert.deepEqual(data, { version: 'review-file-input-v1', input_hash: 'a'.repeat(64),
        project: { issuer_name: 'Synthetic', market: 'sse', offering: 'private' }, requirements: ['Exact submitted scope'], as_of: null,
        scope: { operation: 'full_review', selected_findings: [], source_report_id: null },
        materials: f.input.materials.map((item, i) => ({ ...item.pin, path: `materials/m${i}${i ? '.pdf' : '.txt'}`,
          filename: item.filename, review_source: i === 0 })), knowledge: [{ source: 'synthetic.md', path: 'knowledge/k0.md', sha256: digest('Synthetic method') }],
        public_search: config.web_search, output: { report: 'output/report.docx', text: 'output/report.md' } });
      assert.deepEqual(await readdir(join(cwd, 'output')), []);
    });
    return { kind: 'done', value: 'prepared-only' } as const;
  } })) as typeof codexModelStage;
  const ctx = { run: { input_hash: ` ${'a'.repeat(64)} ` }, blobs: f.blobs } as StageContext;
  assert.deepEqual(await reviewFileStage({ model, config, load: async () => f.input }).run(ctx), { kind: 'done', value: 'prepared-only' });
  assert.equal(calls, 1);
});

for (const operation of ['full_review', 'differential_review'] as const) test(`${operation} continuation preserves candidate source and scope while old report remains a separate unverified reference`, async () => {
  const f = fixture(operation);
  const request = buildReviewFileRequest({ input: f.input, inputHash: f.preparation.candidateInputHash, blobs: f.blobs,
    continuation: { preparation: f.preparation, readFile: async pin => f.priorBytes.get(pin.name)! } });
  await workspace(async cwd => {
    await request.prepare(cwd); await request.verifyOriginals(cwd);
    const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    assert.equal(data.input_hash, f.preparation.candidateInputHash);
    assert.deepEqual(data.scope, { operation, selected_findings: f.input.selected_findings, source_report_id: f.input.manifest.review.source_report_id });
    assert.equal(data.materials.filter((item: any) => item.review_source).length, 1);
    assert.equal(data.materials.find((item: any) => item.review_source).material_version, 2);
    assert.equal(JSON.stringify(data.scope).includes('OLD-1'), false);
    assert.equal(data.continuation.previous_work.status, 'unverified_reference');
    assert.deepEqual(data.continuation.delta, f.preparation.delta);
    for (const pin of f.preparation.priorWork.files) {
      assert.deepEqual(await readFile(join(cwd, `previous_work/${pin.name}`)), f.priorBytes.get(pin.name));
      assert.equal(data.continuation.previous_work.files.find((item: any) => item.name === pin.name).use, 'source_reference');
    }
    assert.deepEqual(await readdir(join(cwd, 'output')), []);
    assert.match(await request.buildPrompt(), /所有拟保留的问题及核验结论都须按候选材料重新核实/);
    assert.match(await request.buildPrompt(), /不得把旧问题自动加入 selected_findings/);
    assert.match(await request.buildPrompt(), /不能声称恢复未保存的复核进度/);
  });
});

test('candidate materials, old report and continuation metadata reject changed bytes', async () => {
  for (const path of ['materials/m0.txt', 'previous_work/report.docx', 'previous_work/report.md', 'continuation.json', 'input.json']) {
    const f = fixture();
    const request = buildReviewFileRequest({ input: f.input, inputHash: f.preparation.candidateInputHash, blobs: f.blobs,
      continuation: { preparation: f.preparation, readFile: async pin => f.priorBytes.get(pin.name)! } });
    await workspace(async cwd => {
      await request.prepare(cwd); await chmod(join(cwd, path), 0o600); await writeFile(join(cwd, path), 'changed');
      await assert.rejects(request.verifyOriginals(cwd), /INPUT_REVISION_CONFLICT/);
    });
  }
});

test('changed old captured bytes or missing candidate material reject preparation', async () => {
  for (const target of ['prior', 'candidate']) {
    const f = fixture(); if (target === 'candidate') f.store.delete('evidence-key');
    const request = buildReviewFileRequest({ input: f.input, inputHash: f.preparation.candidateInputHash, blobs: f.blobs,
      continuation: { preparation: f.preparation, readFile: async pin => target === 'prior' ? Buffer.from('changed') : f.priorBytes.get(pin.name)! } });
    await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /INPUT_REVISION_CONFLICT/); });
  }
});

test('revision, accepted proposal and export inputs cannot be prepared as a supplement review', () => {
  for (const target of ['revision', 'accepted', 'export']) {
    const f = fixture();
    if (target === 'revision') f.input.manifest.review.operation = 'revision';
    if (target === 'accepted') f.input.manifest.review.origin = { accepted_proposal: {} } as never;
    if (target === 'export') f.input.manifest.review.file_delivery!.export = {} as never;
    assert.throws(() => buildReviewFileRequest({ input: f.input, inputHash: f.preparation.candidateInputHash, blobs: f.blobs,
      continuation: { preparation: f.preparation, readFile: async pin => f.priorBytes.get(pin.name)! } }), /INPUT_REVISION_CONFLICT/);
  }
});
