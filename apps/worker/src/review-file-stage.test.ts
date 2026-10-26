import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { ReviewEditorSnapshot } from '@bondbuddy/contracts';
import type { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { reviewFileStage, reviewFileDeliveryStage, validReviewFileResult, type ReviewFileInput } from './review-file-stage.js';
import type { StageContext } from './run-pipeline.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  const writes:Parameters<typeof writeRunWorkingFile>[0][]=[];
  const writer:typeof writeRunWorkingFile=async value=>{writes.push({...value,bytes:Buffer.from(value.bytes)});await value.blobs.put(value.key,value.bytes,value.mediaType);};
  return { directory, source, store, input, ctx, writes, writer };
}

test('malformed saved export pins cannot fall through to a model call or reuse a correction checkpoint',async()=>{
  const f=await fixture();
  try{
    const base={source_run_id:'synthetic-source-run',editor_sha256:'a'.repeat(64),decisions:[]};
    const invalid=[null,false,0,'',{...base,source_execution:null},{...base,source_execution:false},
      {...base,source_execution:{}},{...base,unknown:true}];
    for(const saved of invalid){
      f.input.manifest.review.file_delivery={version:'review-correction-v2',knowledge:[],export:saved as never};
      f.ctx.checkpoint={model_generation:{correction_result:{version:'codex-review-file-v1',input_hash:f.ctx.run.input_hash,files:{}}}};
      const stage=reviewFileStage({load:async()=>f.input,writer:async()=>assert.fail('Malformed export reached output IO'),
        model:()=>assert.fail('Malformed export constructed a model call')});
      await assert.rejects(stage.run(f.ctx),{message:'INPUT_REVISION_CONFLICT'});
      assert.deepEqual(f.writes,[]);assert.equal(f.store.size,1);
    }
  }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('CLI Word is delivered without a structured report, JSON response, or second call', async () => {
  const f = await fixture();
  try {
    const word = makeWorkerDocxFixture({ externalLink: false });
    let calls = 0;
    const stage = reviewFileStage({ load: async () => f.input, config: loadCodexAdapterConfig({}), writer:f.writer, model: options => ({ name: options.name, run: async () => {
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
    assert.deepEqual(f.writes.map(write=>write.name),['final-response.md','report.docx']);
    for(const write of f.writes){assert.deepEqual(write.source,{kind:'provider',attemptId:'call-synthetic',resultSchemaVersion:'codex-review-file-v1'});assert.equal(write.projectId,'project');assert.equal(digest(write.bytes),result.value.files[write.name]!.sha256);}
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
      const stage = reviewFileStage({ load: async () => f.input, config: loadCodexAdapterConfig({}), writer:f.writer, model: options => ({ name: options.name, run: async () => {
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
    const stage = reviewFileStage({ load: async () => f.input, config: loadCodexAdapterConfig({}), writer:f.writer, model: options => ({ name: options.name, run: async () => {
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
    const stage=reviewFileStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),writer:f.writer,model:options=>({name:options.name,run:async()=>{
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

for (const output of ['absent', 'progress-markdown', 'invalid-word'] as const) test(`correction delivery rejects ${output} and retains diagnostics without publishing an unchanged pair`, async () => {
  const f=await fixture();
  try {
    f.input.manifest.review.file_delivery!.version='review-correction-v2';
    const progress='BB_REVIEW_PROGRESS:read_materials:started';
    const stage=reviewFileStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),writer:f.writer,model:options=>({name:options.name,run:async()=>{
      await options.fileWorkspace!.prepare(f.directory);
      if(output==='progress-markdown')await writeFile(join(f.directory,'output/report.md'),'\uFEFF'+progress+'\n');
      if(output==='invalid-word')await writeFile(join(f.directory,'output/report.docx'),'not a Word report');
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'progress-only'} as never,{text:progress})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('result');
    assert.ok(validReviewFileResult(result.value,f.ctx));assert.equal(result.value.error,'WORD_DELIVERY_UNAVAILABLE');
    assert.ok(result.value.files['final-response.md']);assert.equal(result.value.files['revision.docx'],undefined);assert.equal(result.value.files['editor.json'],undefined);
    assert.ok(f.writes.length>0);for(const write of f.writes)assert.deepEqual(write.source,{kind:'provider',attemptId:'progress-only',resultSchemaVersion:'codex-review-file-v1'});
    f.ctx.values.set('model_generation',result.value);
    assert.deepEqual(await reviewFileDeliveryStage().run(f.ctx),{kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'});
  }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('correction delivery reads actual Word report fields when Markdown is absent and preserves final response',async()=>{
  const f=await fixture();
  try{
    f.input.manifest.review.file_delivery!.version='review-correction-v2';
    const original=makeWorkerDocxFixture({externalLink:false});f.store.set('source',original);f.input.materials[0].pin.sha256=digest(original);
    f.input.materials[0].media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document';f.input.materials[0].filename='synthetic.docx';
    // This unit exercises the actual Word conversion; real database and lease
    // authorization are covered by the execution-editor PostgreSQL tests.
    const registeredSnapshots:ReviewEditorSnapshot[]=[];
    const stage=reviewFileStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),writer:f.writer,
      registerEditor:async(pool,lease,projectId,snapshot)=>{
        assert.equal(pool,f.ctx.pool);assert.equal(lease,f.ctx.lease);assert.equal(projectId,f.ctx.run.project_id);
        assert.equal(snapshot.source_sha256,digest(original));assert.equal(snapshot.source_format,'docx');
        registeredSnapshots.push(structuredClone(snapshot));
      },model:options=>({name:options.name,run:async()=>{
      await options.fileWorkspace!.prepare(f.directory);
      const code="import sys;from docx import Document;d=Document();d.add_heading('Synthetic review',0);d.add_heading('Confirmed correction',2);fields=[('复核类别','文字一致性'),('问题说明','合成修订验证'),('原文披露','Synthetic worker upload fixture'),('核对依据','合成依据'),('处理方式','直接修改'),('替换文本','Synthetic reviewed fixture'),('缺少材料','无')];t=d.add_table(rows=0,cols=2);[(setattr(r.cells[0],'text',k),setattr(r.cells[1],'text',v)) for k,v in fields for r in [t.add_row()]];d.save(sys.argv[1])";
      await promisify(execFile)(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',['-c',code,join(f.directory,'output/report.docx')]);
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'word-only'} as never,{text:'报告已保存'})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('result');
    assert.ok(validReviewFileResult(result.value,f.ctx));assert.equal(result.value.error,undefined);
    assert.ok(result.value.files['model-report.docx']);assert.ok(result.value.files['final-response.md']);
    assert.deepEqual(f.writes.filter(write=>write.key.includes('/correction/')).map(write=>write.name),['revision.docx','clean.docx','baseline.docx','report.docx','report.md','editor.json']);
    for(const write of f.writes)assert.deepEqual(write.source,{kind:'provider',attemptId:'word-only',resultSchemaVersion:'codex-review-file-v1'});
    const editor=JSON.parse(f.store.get(result.value.files['editor.json'].key)!.toString());assert.equal(editor.issues.length,1);assert.equal(editor.issues[0].applied,true);
    assert.equal(editor.issues[0].replacement,'Synthetic reviewed fixture');
    assert.equal(registeredSnapshots.length,1);assert.deepEqual(registeredSnapshots[0],editor);
    assert.equal(inputManifestHash(registeredSnapshots[0]),inputManifestHash(editor));
    assert.equal(f.store.get(result.value.files['final-response.md'].key)!.toString(),'报告已保存');
    f.ctx.values.set('model_generation',result.value);assert.equal((await reviewFileDeliveryStage().run(f.ctx)).kind,'deliver');
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
