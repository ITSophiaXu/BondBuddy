import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { editingSource, fileAuthoringStage, fileAuthoringDeliveryStage, type FileAuthoringResult } from './file-authoring-stage.js';
import { runFormatPython, type FormatDiagnostic } from './file-authoring-format.js';
import { diagnoseFormat, validFormatDiagnostic } from './word-format-diagnostic.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import type { UnifiedInput } from './unified-input.js';
import type { StageContext } from './run-pipeline.js';

const python = !!(process.env.BONDBUDDY_TEST_PYTHON || process.env.BONDBUDDY_WORD_PYTHON);
function fixture(controlled = true) {
  const source = makeWorkerDocxFixture({ externalLink: false, text: '截至2024年净资产100万元。' });
  const pin = { material_id: 'source', material_version: 1, sha256: digest(source), role: 'historical' };
  const input: UnifiedInput = { requirements: [], materials: [{ pin, filename: 'source.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'source', records: [], pending: [] }],
    manifest: { issuer_name: '合成发行人', market: 'sse', offering: 'private', update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' }, materials: [pin],
      authoring: { version: 'unified_v1', requirements: [], source_prospectuses: [], knowledge: [], knowledge_status: 'authoring_reference_not_compliance_approval',
        ...(controlled ? { format_policy: { version: 'source-format-v1', mode: 'preserve_docx', selection: 'automatic', template: { kind: 'material', material_id: pin.material_id, material_version: 1, sha256: pin.sha256 } } } : {}) } } };
  const objects = new Map<string, Buffer>([['source', source]]);
  const blobs = { getIfExistsBounded: async (key: string) => objects.get(key) ?? null,
    put: async (key: string, bytes: Buffer) => { objects.set(key, bytes); } } as unknown as PrivateBlobs;
  const ctx = { run: { id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64) },
    lease: { checkpoint: {} }, signal: new AbortController().signal, values: new Map(), blobs } as unknown as StageContext;
  return { source, input, objects, ctx, blobs };
}

test('explicit template choice is independent of random material ids; previous output remains the revision source', () => {
  const { input } = fixture();
  input.materials.unshift({ ...input.materials[0]!, pin: { ...input.materials[0]!.pin, material_id: 'aaa' } });
  assert.equal(editingSource(input)?.pin.material_id, 'source');
  input.manifest.authoring.previous_output = { artifact_id: 'prior', version: 1, sha256: 'b'.repeat(64), run_id: 'prior-run', input_revision: 1 };
  input.materials.push({ ...input.materials[0]!, pin: { ...input.materials[0]!.pin, material_id: 'prior', role: 'project_output' } });
  assert.equal(editingSource(input)?.pin.material_id, 'prior');
});

test('a pinned review source can use a non-historical material role', () => {
  const {input}=fixture();
  input.materials[0]!.pin.role='audit';
  input.manifest.authoring.review_result={version:'review-result-v1',run_id:'review-run',input_revision:1,input_hash:'b'.repeat(64),
    artifact_id:'review-artifact',artifact_version:1,sha256:'c'.repeat(64),requirements:'采用复核源稿',
    source_material:{material_id:'source',material_version:1,sha256:input.materials[0]!.pin.sha256}};
  input.manifest.authoring.format_policy={...input.manifest.authoring.format_policy!,selection:'review_source'} as NonNullable<typeof input.manifest.authoring.format_policy>;
  assert.equal(editingSource(input)?.pin.role,'audit');
});

for (const invalid of [false, true]) test(`trusted finalization ${invalid ? 'rejects wrong anchors without accepting model DOCX' : 'ignores arbitrary model DOCX and preserves the original package'}`, { skip: !python, timeout: 60000 }, async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), 'bb-format-stage-test-'));
  let calls = 0;
  try {
    const stage = fileAuthoringStage({ load: async () => f.input, model: options => ({ name: 'model_generation', run: async ctx => {
      calls++;
      await options.fileWorkspace!.prepare(root);
      const data = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
      assert.equal(data.format_tools.version, 'controlled-docx-v1');
      const inspected = JSON.parse((await runFormatPython(['inspect', '--input', join(root, 'input.json')], ctx.signal)).stdout);
      const node = inspected.nodes.find((n: { kind: string }) => n.kind === 'paragraph');
      assert.ok(node);
      await writeFile(join(root, 'output/operations.json'), JSON.stringify({ version: 'word-operations-v1', input_hash: data.input_hash,
        baseline_sha256: data.baseline_sha256, operations: [{ id: 'change-1', kind: 'replace_text', node_id: node.node_id,
          before: invalid ? '错误原文锚点' : node.text, after: '截至2025年净资产120万元。' }] }));
      for (const name of ['tracked.docx', 'clean.docx']) await writeFile(join(root, 'output', name), 'PK arbitrary model document');
      const value = await options.fileWorkspace!.collect(root, { call_id: 'call' } as Parameters<NonNullable<typeof options.fileWorkspace>['collect']>[1]);
      return { kind: 'done', value };
    } }) });
    const outcome = await stage.run(f.ctx);
    assert.equal(outcome.kind, 'done');
    if (outcome.kind !== 'done') throw Error('expected completion');
    const value = outcome.value as FileAuthoringResult;
    assert.equal(calls, 1);
    f.ctx.values.set('model_generation', value);
    assert.equal(value.error, undefined);
    assert.equal(value.summary.format_state, 'operations_ready');
    assert.equal(value.files['tracked.docx'], undefined);
    if (invalid) {
      assert.deepEqual(await fileAuthoringDeliveryStage().run(f.ctx), { kind: 'fail', code: 'WORD_QUALITY_REJECTED' });
    } else {
      assert.equal(value.files['baseline.docx']!.sha256, digest(f.source));
      // A process restart no longer needs the CLI workspace: only stored references remain.
      await rm(root, { recursive: true, force: true });
      const put=f.blobs.put.bind(f.blobs);
      let simulateStorageFailure=true;
      f.blobs.put=async(...args)=>{
        if(simulateStorageFailure && args[0].includes('/finalized/')){simulateStorageFailure=false;throw Error('SYNTHETIC_STORAGE_OUTAGE');}
        return put(...args);
      };
      await assert.rejects(fileAuthoringDeliveryStage().run(f.ctx),/SYNTHETIC_STORAGE_OUTAGE/);
      const delivery = await fileAuthoringDeliveryStage().run(f.ctx);
      assert.equal(delivery.kind, 'deliver');
      if(delivery.kind!=='deliver')throw Error('expected delivery');
      assert.notEqual(digest(delivery.cleanBytes!), digest(Buffer.from('PK arbitrary model document')));
      const diagnostic = delivery.wordSummary!.format_diagnostic as FormatDiagnostic;
      assert.equal(diagnostic.status, 'pending');
      const report = JSON.parse((await diagnoseFormat({ id: 'job', run_id: 'run', owner_user_id: 'owner', project_id: 'project',
        input_hash: 'a'.repeat(64), diagnostic }, f.blobs)).toString('utf8'));
      assert.equal(report.status, 'passed', JSON.stringify(report));
      assert.equal(calls, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing snapshot without format policy retains the original direct-file delivery path',async()=>{
  const f=fixture(false),root=await mkdtemp(join(tmpdir(),'bb-format-legacy-'));
  try{
    const stage=fileAuthoringStage({load:async()=>f.input,model:options=>({name:'model_generation',run:async()=>{
      await options.fileWorkspace!.prepare(root);
      assert.equal(JSON.parse(await readFile(join(root,'input.json'),'utf8')).format_tools,undefined);
      for(const name of ['tracked.docx','clean.docx'])await writeFile(join(root,'output',name),f.source);
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:'legacy-call'} as Parameters<NonNullable<typeof options.fileWorkspace>['collect']>[1])};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');
    if(result.kind!=='done')throw Error('expected result');
    f.ctx.values.set('model_generation',result.value);
    const delivery=await fileAuthoringDeliveryStage().run(f.ctx);
    assert.equal(delivery.kind,'deliver');
    if(delivery.kind==='deliver')assert.equal(delivery.wordSummary?.format_execution,undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnostics reject foreign or oversized references before reading storage', () => {
  const ref = { key: 'owners/owner/projects/project/runs/run/file-authoring/call/a', sha256: 'b'.repeat(64), byte_size: 20 };
  const row = { id: 'job', run_id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64), diagnostic: {
    version: 'word-format-diagnostic-v1' as const, status: 'pending' as const, input_hash: 'a'.repeat(64), revision_author: 'BondBuddy-a',
    files: { baseline: { ...ref }, tracked: { ...ref }, operations: { ...ref } } } };
  assert.ok(validFormatDiagnostic(row));
  row.diagnostic.files.baseline.key = 'owners/other/projects/project/runs/run/file-authoring/call/a';
  assert.equal(validFormatDiagnostic(row), false);
  row.diagnostic.files.baseline = { ...ref, byte_size: 101 * 1024 * 1024 };
  assert.equal(validFormatDiagnostic(row), false);
});
