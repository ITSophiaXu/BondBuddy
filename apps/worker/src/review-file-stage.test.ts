import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@bondbuddy/api/data';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { reviewFileStage, reviewFileDeliveryStage, validReviewFileResult, type ReviewFileInput } from './review-file-stage.js';
import type { StageContext } from './run-pipeline.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'review-file-unit-'));
  const source = Buffer.from('Synthetic source, not customer data');
  const store = new Map<string, Buffer>([['source', source]]);
  const pin = { material_id: 'material', material_version: 1, sha256: digest(source), role: 'historical' };
  const input = { manifest: { issuer_name: 'Synthetic', market: 'sse', offering: 'private', materials: [pin],
    review: { operation: 'full_review', source_report_id: null, input: { source_material_ref: pin, requirements: ['Synthetic requirement'], as_of: null },
      file_delivery: { version: 'review-file-v1', knowledge: [{ path: 'synthetic.md', markdown: 'Synthetic method', sha256: digest('Synthetic method') }] } } },
    materials: [{ pin, object_key: 'source', media_type: 'text/plain', filename: 'synthetic.txt' }], selected_findings: [] } as unknown as ReviewFileInput;
  const ctx = { run: { id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64) }, checkpoint: {}, values: new Map(),
    signal: new AbortController().signal, blobs: { put: async (key: string, bytes: Buffer) => { store.set(key, bytes); },
      getIfExistsBounded: async (key: string) => store.get(key) ?? null } } as unknown as StageContext;
  return { directory, source, store, input, ctx };
}

test('CLI Word is delivered without a structured report, JSON response, or second call', async () => {
  const f = await fixture();
  try {
    const word = makeWorkerDocxFixture({ externalLink: false });
    let calls = 0;
    const stage = reviewFileStage({ load: async () => f.input, config: loadCodexAdapterConfig({}), model: options => ({ name: options.name, run: async () => {
      calls++; assert.ok(options.fileWorkspace); assert.equal(options.reviewTools, undefined);
      await options.fileWorkspace.prepare(f.directory);
      assert.equal((await readFile(join(f.directory, 'materials/m0.txt'))).toString(), f.source.toString());
      const received = JSON.parse(await readFile(join(f.directory, 'input.json'), 'utf8'));
      assert.deepEqual(received.requirements, ['Synthetic requirement']); assert.equal(received.knowledge.length, 1);
      await writeFile(join(f.directory, 'output/report.docx'), word);
      return { kind: 'done', value: await options.fileWorkspace.collect(f.directory, { call_id: 'call-synthetic' } as never, { text: '普通文字，不是 JSON。' }) };
    } }) });
    const result = await stage.run(f.ctx); assert.equal(result.kind, 'done');
    if (result.kind !== 'done') throw Error('expected result');
    assert.ok(validReviewFileResult(result.value, f.ctx));
    assert.ok(result.value.files['final-response.md']); assert.equal(calls, 1);
    f.ctx.values.set('model_generation', result.value);
    const delivered = await reviewFileDeliveryStage().run(f.ctx); assert.equal(delivered.kind, 'deliver');
    if (delivered.kind !== 'deliver') throw Error('expected delivery');
    assert.deepEqual(delivered.bytes, word); assert.equal(delivered.deliveryPolicy, 'generated_review_v1');
    assert.equal(delivered.wordSummary?.structured_report, 'not_requested');
    const saved = result.value.files['report.docx']!;
    saved.key = saved.key.replace('owners/owner/', 'owners/foreign/');
    assert.equal(validReviewFileResult(result.value, f.ctx), false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('missing output is recorded without inventing a report; immutable input tampering fails', async () => {
  for (const tamper of [false, true]) {
    const f = await fixture();
    try {
      const stage = reviewFileStage({ load: async () => f.input, config: loadCodexAdapterConfig({}), model: options => ({ name: options.name, run: async () => {
        await options.fileWorkspace!.prepare(f.directory);
        if (tamper) { await chmod(join(f.directory, 'materials/m0.txt'), 0o600); await writeFile(join(f.directory, 'materials/m0.txt'), 'changed'); }
        return { kind: 'done', value: await options.fileWorkspace!.collect(f.directory, { call_id: 'call-synthetic' } as never, { text: '' }) };
      } }) });
      if (tamper) await assert.rejects(stage.run(f.ctx), /INPUT_REVISION_CONFLICT/);
      else {
        const result = await stage.run(f.ctx); assert.equal(result.kind, 'done');
        if (result.kind !== 'done') throw Error('expected result');
        f.ctx.values.set('model_generation', result.value);
        assert.deepEqual(await reviewFileDeliveryStage().run(f.ctx), { kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE' });
      }
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});

test('report symlinks cannot publish outside files', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const stage = reviewFileStage({ load: async () => f.input, config: loadCodexAdapterConfig({}), model: options => ({ name: options.name, run: async () => {
      await options.fileWorkspace!.prepare(f.directory);
      await symlink(join(f.directory, 'materials/m0.txt'), join(f.directory, 'output/report.docx'));
      return { kind: 'done', value: await options.fileWorkspace!.collect(f.directory, { call_id: 'call-synthetic' } as never, { text: '' }) };
    } }) });
    const result = await stage.run(f.ctx);
    assert.equal(result.kind, 'done'); if (result.kind !== 'done') throw Error('expected result');
    assert.ok(validReviewFileResult(result.value, f.ctx)); assert.equal(result.value.files['report.docx'], undefined);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('pinned DOCX produces source comments and the same canonical report; missing comment bytes block delivery', async () => {
  const f = await fixture();
  try {
    const original = makeWorkerDocxFixture({externalLink:false});
    f.store.set('source',original);f.input.materials[0].pin.sha256=digest(original);
    f.input.materials[0].media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    f.input.materials[0].filename='synthetic.docx';
    let calls=0;
    const stage=reviewFileStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      calls++;await options.fileWorkspace!.prepare(f.directory);
      await writeFile(join(f.directory,'output/report.md'),'## 财务核对\n### 金额需核对\n**原文披露：** Synthetic worker upload fixture\n**核对依据：** 合成材料\n**修改建议：** 核实后修改\n');
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'call-annotations'} as never,{text:'已写好报告'})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('result');
    assert.ok(validReviewFileResult(result.value,f.ctx));assert.equal(result.value.error,undefined);
    const receipt=JSON.parse(f.store.get(result.value.files['annotations.json'].key)!.toString());
    assert.equal(receipt.placed.length,1);assert.equal(receipt.source.sha256,digest(original));
    assert.match(f.store.get(result.value.files['report.md'].key)!.toString(),/R001 · 金额需核对/);
    assert.deepEqual(f.store.get('source'),original);assert.equal(calls,1);
    f.ctx.values.set('model_generation',result.value);
    const delivery=await reviewFileDeliveryStage().run(f.ctx);assert.equal(delivery.kind,'deliver');
    if(delivery.kind!=='deliver')throw Error('delivery');assert.equal(delivery.attachments?.length,1);
    f.store.set(result.value.files['comments.docx'].key,Buffer.from('corrupted'));
    assert.deepEqual(await reviewFileDeliveryStage().run(f.ctx),{kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'});
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
