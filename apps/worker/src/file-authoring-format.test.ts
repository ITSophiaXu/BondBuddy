import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { editingSource, fileAuthoringStage, fileAuthoringDeliveryStage, type FileAuthoringResult } from './file-authoring-stage.js';
import { runFormatPython, type FormatDiagnostic } from './file-authoring-format.js';
import { verifyWordQuality } from './file-authoring-quality.js';
import { diagnoseFormat, validFormatDiagnostic } from './word-format-diagnostic.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import type { UnifiedInput } from './unified-input.js';
import { unifiedInputGate } from './unified-input.js';
import type { StageContext } from './run-pipeline.js';
import { FILE_AUTHORING_HOST_RENDER_HANDOFF, FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES } from './file-authoring-instructions.js';

const python = !!(process.env.BONDBUDDY_TEST_PYTHON || process.env.BONDBUDDY_WORD_PYTHON);
function fixture(controlled = true, text = '截至2024年净资产100万元。') {
  const source = makeWorkerDocxFixture({ externalLink: false, text });
  const pin = { material_id: 'source', material_version: 1, sha256: digest(source), role: 'historical' };
  const input: UnifiedInput = { requirements: [], materials: [{ pin, filename: 'source.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'source', records: [], pending: [] }],
    manifest: { issuer_name: '合成发行人', market: 'sse', offering: 'private', update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' }, materials: [pin],
      authoring: { version: 'unified_v1', requirements: [], source_prospectuses: [], knowledge: [], knowledge_status: 'authoring_reference_not_compliance_approval',
        ...(controlled ? { format_policy: { version: 'source-format-v1', mode: 'preserve_docx', selection: 'automatic', template: { kind: 'material', material_id: pin.material_id, material_version: 1, sha256: pin.sha256 } } } : {}) } } };
  const objects = new Map<string, Buffer>([['source', source]]);
  const blobs = { getIfExistsBounded: async (key: string) => objects.get(key) ?? null,
    put: async (key: string, bytes: Buffer) => { objects.set(key, bytes); } } as unknown as PrivateBlobs;
  const ctx = { run: { id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64) },
    lease: { checkpoint: {} }, checkpoint:{}, signal: new AbortController().signal, values: new Map(), blobs } as unknown as StageContext;
  const persisted={checkpoint:{} as StageContext['lease']['checkpoint'],writes:0};
  const checkpoint:NonNullable<Parameters<typeof fileAuthoringDeliveryStage>[0]>['checkpoint']=async(_pool,lease,stage,value,completed)=>{
    assert.match(stage,/^word_(?:format_plan(?:_repair_[12])?|size_review_[012])$/);assert.equal(completed,false);
    persisted.writes++;
    persisted.checkpoint=JSON.parse(JSON.stringify({...lease.checkpoint,stages:{...lease.checkpoint.stages as object,[stage]:value}}));
    lease.checkpoint=structuredClone(persisted.checkpoint);
  };
  const delivery=(options:Parameters<typeof fileAuthoringDeliveryStage>[0]={})=>fileAuthoringDeliveryStage({...options,checkpoint});
  return { source, input, objects, ctx, blobs, persisted, delivery };
}

test('real first, repair and recovery prompts retain full instructions within the byte budget', async () => {
  const task = await readFile(new URL('../../../python/bondbuddy_file_authoring/task.md', import.meta.url), 'utf8');
  const fixed = await readFile(new URL('../../../python/bondbuddy_file_authoring/fixed-edit.md', import.meta.url), 'utf8');
  for (const controlled of [false, true]) for (const repairing of [false, true]) for (const recovering of [false, true]) {
    const f = fixture(controlled), logicalCallId = repairing ? 'file-authoring-size-repair-2' : 'file-authoring-v1';
    const deadline = '2030-01-01T00:00:00.000Z';
    if (recovering) {
      const attempt = 'saved-attempt', hash = 'b'.repeat(64);
      f.ctx.lease.checkpoint = {
        stages: { file_authoring_recovery: { version: 'file-authoring-recovery-v1', input_hash: f.ctx.run.input_hash,
          attempt_id: attempt, logical_call_id: logicalCallId, deadline_at: deadline,
          files: [{ path: 'input.json', key: `owners/owner/projects/project/runs/run/file-authoring/recovery/${attempt}/${hash}/input.json`, sha256: hash, byte_size: 2 }] } },
        operator_reconciliations: { [attempt]: { decision: 'retry_unknown_usage', reason_code: 'file_authoring_context_rotation',
          attempt_id: attempt, logical_call_id: logicalCallId, deadline_at: deadline } },
      };
    }
    let inspected = false;
    const result = await fileAuthoringStage({ load: async () => f.input,
      config: { work_root: '/unused-synthetic-prompt-test' } as NonNullable<Parameters<typeof fileAuthoringStage>[0]>['config'],
      ...(repairing ? { repair: { round: 2, previous: { version: 'codex-file-word-v1', input_hash: f.ctx.run.input_hash, files: {}, summary: {} },
        report: { version: 'word-quality-v1', status: 'failed', issues: [], metrics: {}, limitations: [] }, reportRef: { key: 'unused', sha256: 'c'.repeat(64), byte_size: 1 } } as const } : {}),
      model: options => ({ name: options.name, run: async ctx => {
        const prompt = await options.buildPrompt(ctx);
        const preamble = prompt.slice(0, prompt.indexOf('----- BEGIN TRUSTED task.md -----'));
        inspected = true;
        for (const text of [task, ...(controlled ? [fixed] : [])]) {
          assert.ok(prompt.includes(text), 'complete trusted files must survive the real stage composition');
          assert.equal(prompt.indexOf(text), prompt.lastIndexOf(text));
        }
        assert.ok(Buffer.byteLength(prompt) <= FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES);
        assert.equal(prompt.includes('BEGIN TRUSTED fixed-edit.md'), controlled);
        assert.equal(prompt.includes(FILE_AUTHORING_HOST_RENDER_HANDOFF), controlled);
        assert.equal(preamble.includes('quality-feedback.json'), repairing);
        assert.equal(preamble.includes('本次为执行中断后的已授权续跑'), recovering);
        assert.equal(options.fileWorkspace!.recovery, recovering);
        assert.equal(options.fileWorkspace!.deadlineAt, recovering ? deadline : undefined);
        const modelConfig = typeof options.config === 'function' ? options.config() : options.config;
        assert.equal(modelConfig!.model_gateway, 'enforce');
        assert.equal(modelConfig!.model_max_request_bytes, 2 * 1024 * 1024);
        assert.match(options.templateVersion!, /host-handoff/);
        return { kind: 'done', value: 'synthetic prompt inspected; no provider call' };
      } }),
    }).run(f.ctx);
    assert.equal(result.kind, 'done');
    assert.equal(inspected, true);
  }
});

test('explicit template choice is independent of random material ids; previous output remains the revision source', () => {
  const { input } = fixture();
  input.materials.unshift({ ...input.materials[0]!, pin: { ...input.materials[0]!.pin, material_id: 'aaa' } });
  assert.equal(editingSource(input)?.pin.material_id, 'source');
  input.manifest.authoring.previous_output = { artifact_id: 'prior', version: 1, sha256: 'b'.repeat(64), run_id: 'prior-run', input_revision: 1 };
  input.materials.push({ ...input.materials[0]!, pin: { ...input.materials[0]!.pin, material_id: 'prior', sha256:'b'.repeat(64), role: 'project_output' } });
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
  // Old snapshots need the exact review pin even before format_policy existed.
  delete input.manifest.authoring.format_policy;
  assert.equal(editingSource(input)?.pin.role,'audit');
  input.materials[0]!.pin.sha256='d'.repeat(64);
  assert.throws(()=>editingSource(input),/INPUT_REVISION_CONFLICT/);
});

test('continuation requires the selected artifact version and hash, with no fallback to another original',()=>{
  const {input}=fixture();
  input.manifest.authoring.previous_output={artifact_id:'prior',version:2,sha256:'b'.repeat(64),run_id:'prior-run',input_revision:1};
  assert.throws(()=>editingSource(input),/INPUT_REVISION_CONFLICT/);
  input.materials.push({...input.materials[0]!,pin:{material_id:'prior',material_version:1,sha256:'b'.repeat(64),role:'project_output'}});
  assert.throws(()=>editingSource(input),/INPUT_REVISION_CONFLICT/);
  input.materials[1]!.pin.material_version=2;
  assert.equal(editingSource(input)?.pin.material_id,'prior');
  input.materials[1]!.pin.sha256='c'.repeat(64);
  assert.throws(()=>editingSource(input),/INPUT_REVISION_CONFLICT/);
});

test('a declared original cannot disappear from the locked inputs and become a new manuscript',()=>{
  const {input}=fixture(false);
  input.manifest.authoring.source_prospectuses=[{...input.materials[0]!.pin,issuer_name:null,
    relation:'same_issuer',market:null,offering:null,reporting_periods:[],status:'user_asserted'}];
  assert.equal(editingSource(input)?.pin.material_id,'source');
  input.materials=[];
  assert.throws(()=>editingSource(input),/INPUT_REVISION_CONFLICT/);
});

test('the input gate binds its immutable adopted version to the template, independent of later project selection',async()=>{
  const {input,ctx}=fixture();
  const source=input.materials[0]!.pin;
  input.manifest.prospectus_selection={revision:2,version_id:'pinned-source-v1'};
  input.manifest.update_details.target_reporting_periods=[{start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]}];
  const markdown='Synthetic adopted-source gate knowledge';
  input.manifest.authoring.knowledge=[{path:'synthetic.md',markdown,sha256:digest(markdown)}];
  const reference={...input.materials[0]!,pin:{material_id:'auxiliary',material_version:1,sha256:'c'.repeat(64),role:'reference'}};
  input.materials.push(reference);input.manifest.materials=input.materials.map(m=>m.pin);
  let adopted:{material_id:string|null;material_version:number|null;sha256:string;artifact_id?:string;artifact_version?:number;run_id?:string}|undefined=
    {material_id:source.material_id,material_version:source.material_version,sha256:source.sha256};
  const lookups:unknown[][]=[];
  const pool={query:async(sql:string,values:unknown[])=>{
    if(sql.includes('FROM bb_prospectus_versions')){
      lookups.push(values);
      assert.deepEqual(values,[ctx.run.owner_user_id,ctx.run.project_id,'pinned-source-v1']);
      return {rows:adopted?[adopted]:[]};
    }
    if(sql.includes('SELECT a.object_key,a.sha256'))return {rows:['selected-clean','other-clean'].includes(String(values[0]))
      ?[{object_key:`synthetic/${String(values[0])}`,sha256:'d'.repeat(64)}]:[]};
    assert.ok(!sql.includes('bb_prospectus_selection'),'the later current selection is never queried');
    const material=input.materials.find(m=>m.pin.material_id===values[2]&&m.pin.material_version===values[3]);
    return {rows:material?[{role:material.pin.role,sha256:material.pin.sha256,media_type:material.mediaType}]:[]};
  }} as unknown as Parameters<typeof unifiedInputGate>[0];
  const gate=async()=>{
    const input_hash=inputManifestHash(input.manifest);
    return unifiedInputGate(pool,{...ctx.run,input_hash},{input_hash,manifest:input.manifest,draft_revision:1,
      material_versions:input.manifest.materials,rule_pack_version:null,template_version:null});
  };
  const before=structuredClone(input.manifest);
  assert.equal(await gate(),null);
  assert.deepEqual(input.manifest,before,'no immutable input is rewritten');
  input.manifest.authoring.format_policy={version:'source-format-v1',mode:'preserve_docx',selection:'automatic',
    template:{kind:'material',material_id:'auxiliary',material_version:1,sha256:reference.pin.sha256}};
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
  input.manifest.authoring.format_policy={version:'source-format-v1',mode:'preserve_docx',selection:'automatic',
    template:{kind:'material',material_id:source.material_id,material_version:source.material_version,sha256:source.sha256}};
  adopted={...adopted!,material_version:2};
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
  adopted={material_id:source.material_id,material_version:source.material_version,sha256:'f'.repeat(64)};
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
  adopted=undefined;
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
  assert.equal(lookups.length,5);
  delete input.manifest.prospectus_selection;
  assert.equal(await gate(),null,'legacy inputs without a selection pin keep their original path');
  assert.equal(lookups.length,5);
  input.manifest.prospectus_selection={revision:2,version_id:'pinned-source-v1'};
  adopted={material_id:source.material_id,material_version:source.material_version,sha256:source.sha256};
  delete input.manifest.authoring.format_policy;
  input.manifest.authoring.source_prospectuses=[{material_id:source.material_id,material_version:source.material_version,sha256:source.sha256,
    issuer_name:null,relation:'same_issuer',market:null,offering:null,reporting_periods:[],status:'user_asserted'}];
  assert.equal(await gate(),null,'an exact original in a safe pre-format-policy snapshot remains usable');
  assert.equal(editingSource(input)?.pin.material_id,'source');
  input.materials=input.materials.filter(m=>m.pin.material_id==='source');input.manifest.materials=input.materials.map(m=>m.pin);
  assert.equal(await gate(),null,'a pre-format-policy snapshot with only its exact original remains usable');
  input.manifest.authoring.source_prospectuses=[];
  input.materials.unshift({...reference,pin:{...reference.pin,material_id:'aaa-reference'}});input.manifest.materials=input.materials.map(m=>m.pin);
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'},'legacy ranking cannot silently replace the adopted original');
  assert.equal(editingSource(input)?.pin.material_id,'aaa-reference','authoring and its gate share the actual legacy order');
  adopted={material_id:null,material_version:null,sha256:'d'.repeat(64),artifact_id:'selected-clean',artifact_version:3,run_id:'selected-run'};
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'},'generated selection cannot degrade to uploaded-source editing');
  input.manifest.authoring.previous_output={artifact_id:'selected-clean',version:3,sha256:'d'.repeat(64),run_id:'selected-run',input_revision:2};
  assert.equal(await gate(),null,'an exact selected clean artifact keeps its verified legacy continuation');
  input.manifest.authoring.previous_output={...input.manifest.authoring.previous_output,artifact_id:'other-clean',run_id:'other-run',input_revision:1};
  assert.equal(await gate(),null,'a validated explicit viewed-result continuation may differ from project current');
  input.manifest.authoring.previous_output={...input.manifest.authoring.previous_output,sha256:'f'.repeat(64)};
  assert.deepEqual(await gate(),{kind:'fail',code:'INPUT_REVISION_CONFLICT'},'explicit previous output still requires its verified artifact hash');
});

test('normal model exit without operations preserves private evidence and reports the actual failure', {skip:!python}, async()=>{
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-missing-operations-'));
  let calls=0;
  try{
    const stage=fileAuthoringStage({load:async()=>f.input,model:options=>({name:'model_generation',run:async()=>{
      calls++;assert.equal(options.fileWorkspace!.completionCheck,true);
      await options.fileWorkspace!.prepare(root);
      await writeFile(join(root,'scratch/工作记录.md'),'Synthetic pending chapter; no completed edits.');
      const value=await options.fileWorkspace!.collect(root,{call_id:'call'} as any,{text:'Synthetic tool failure; no delivery.',diagnostics:{tools:[{exit_code:1,output:'WORD_EDIT_NODE_NOT_FOUND'}],omitted:0}});
      return {kind:'done',value};
    }})});
    const outcome=await stage.run(f.ctx);assert.equal(outcome.kind,'done');if(outcome.kind!=='done')throw Error('completion expected');
    const value=outcome.value as FileAuthoringResult;
    assert.equal(value.summary.validation_error,'WORD_FORMAT_OPERATIONS_MISSING');
    assert.deepEqual(value.summary.missing_files,['operations.json']);
    assert.equal(value.files['operations.json'],undefined);assert.equal(value.files['clean.docx'],undefined);
    const diagnostic=f.objects.get(value.files['diagnostic.json']!.key)!;
    assert.equal(digest(diagnostic),value.files['diagnostic.json']!.sha256);
    assert.match(diagnostic.toString(),/Synthetic tool failure/);assert.match(diagnostic.toString(),/WORD_EDIT_NODE_NOT_FOUND/);
    assert.match(diagnostic.toString(),/Synthetic pending chapter/);
    await rm(root,{recursive:true,force:true});
    f.ctx.values.set('model_generation',value);
    for(let i=0;i<2;i++)assert.deepEqual(await f.delivery().run(f.ctx),{kind:'fail',code:'WORD_FORMAT_OPERATIONS_MISSING'});
    assert.equal(calls,1);assert.equal(JSON.stringify(value.summary).includes('Synthetic'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a same-issuer new reporting period cannot be delivered as unchanged source',{skip:!python},async()=>{
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-unupdated-period-'));
  const period=(year:string)=>({start:`${year}-01-01`,end:`${year}-12-31`,period_kind:'annual' as const,
    scope:'consolidated' as const,status:'user_asserted' as const,evidence_refs:[]});
  f.input.manifest.update_details.target_reporting_periods=[period('2025')];
  f.input.manifest.authoring.source_prospectuses=[{...f.input.materials[0]!.pin,issuer_name:'合成发行人',relation:'same_issuer',
    market:'sse',offering:'private',reporting_periods:[period('2024')],status:'user_asserted'}];
  try{
    const stage=fileAuthoringStage({load:async()=>f.input,model:options=>({name:'model_generation',run:async()=>{
      await options.fileWorkspace!.prepare(root);
      const data=JSON.parse(await readFile(join(root,'input.json'),'utf8'));
      assert.equal(data.update_required,true);
      await runFormatPython(['no_changes','--input',join(root,'input.json'),'--operations',join(root,'output/operations.json'),
        '--reason','Synthetic no-change claim despite a different reporting target.']);
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:'call'} as any)};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('expected result');
    f.ctx.values.set('model_generation',result.value);
    const delivery=await f.delivery().run(f.ctx);
    assert.equal(delivery.kind,'fail');if(delivery.kind!=='fail')throw Error('expected rejection');
    assert.equal(delivery.code,'WORD_QUALITY_REJECTED');
    const gate=delivery.checkpoint!.quality_gate as {report:{key:string};format_plan:{key:string;sha256:string}};
    assert.match(f.objects.get(gate.report.key)!.toString(),/WORD_REPORTING_UPDATE_INCOMPLETE/);
    const plan=f.objects.get(gate.format_plan.key)!;
    assert.equal(digest(plan),gate.format_plan.sha256);
    assert.equal(JSON.parse(plan.toString()).input_hash,f.ctx.run.input_hash);
    assert.equal(JSON.parse(plan.toString()).visual_review,'not_run');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('host size rejection hands the original log to a repair turn and rechecks the real finalized Word', {skip:!python,timeout:60000}, async()=>{
  const f=fixture(true,'原稿发行人业务、经营及财务披露应完整保留。'.repeat(10));
  const calls:string[]=[],inputs:Buffer[]=[];
  let qualityChecks=0;
  const model:NonNullable<Parameters<typeof fileAuthoringStage>[0]>['model']=options=>({name:options.name,run:async ctx=>{
    const root=await mkdtemp(join(tmpdir(),'bb-size-repair-workspace-'));
    try{
      calls.push(options.logicalCallId);
      await options.fileWorkspace!.prepare(root);
      inputs.push(await readFile(join(root,'input.json')));
      const repairing=options.logicalCallId!=='file-authoring-v1';
      if(repairing){
        assert.match(await options.buildPrompt(ctx),/quality-feedback.json/);
        assert.deepEqual(inputs[1],inputs[0],'input and revision timestamp remain locked');
        assert.deepEqual(await readFile(join(root,'previous/operations.json')),await readFile(join(root,'output/operations.json')));
        assert.match(await readFile(join(root,'quality-feedback.json'),'utf8'),/WORD_DOCUMENT_SIZE_REDUCED/);
        assert.deepEqual(await readFile(join(root,'materials/m0.docx')),f.source,'the rejected draft never replaces the source');
      }
      const data=JSON.parse(inputs.at(-1)!.toString('utf8'));
      const inspected=JSON.parse((await runFormatPython(['inspect','--input',join(root,'input.json')])).stdout);
      const node=inspected.nodes.find((n:{kind:string})=>n.kind==='paragraph');
      await writeFile(join(root,'output/operations.json'),JSON.stringify({version:'word-operations-v1',input_hash:data.input_hash,
        baseline_sha256:data.baseline_sha256,operations:[{id:'rewrite',kind:'replace_text',node_id:node.node_id,before:node.text,
          after:repairing?'目标发行人业务、经营及财务披露已经按本期材料完整更新。'.repeat(10):'简短摘要。'}]}));
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:options.logicalCallId} as any)};
    }finally{await rm(root,{recursive:true,force:true});}
  }});
  const result=await fileAuthoringStage({load:async()=>f.input,model}).run(f.ctx);
  assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('expected initial draft');
  f.ctx.values.set('model_generation',result.value);
  const delivered=await f.delivery({pause:async()=>false,
    repair:(ctx,repair)=>fileAuthoringStage({load:async()=>f.input,model,repair}).run(ctx),
    // Synthetic size finding exercises orchestration; repaired OOXML, full
    // quality checks and both host finalizations below use the real Python tool.
    quality:async input=>++qualityChecks===1?{version:'word-quality-v1',status:'failed',
      issues:[{code:'WORD_DOCUMENT_SIZE_REDUCED',metric:'rendered_pages',before:310,after:104}],metrics:{},limitations:['synthetic pagination finding']}:verifyWordQuality(input)
  }).run(f.ctx);
  assert.equal(delivered.kind,'deliver',JSON.stringify(delivered));if(delivered.kind!=='deliver')throw Error('expected repaired delivery');
  assert.deepEqual(calls,['file-authoring-v1','file-authoring-size-repair-1']);assert.equal(qualityChecks,2);
  assert.equal(delivered.wordSummary!.quality_repair_round,1);
  assert.equal((delivered.wordSummary!.quality_gate as {status:string}).status,'passed');
  const saved=f.persisted.checkpoint.stages as Record<string,Record<string,unknown>>;
  assert.ok(saved.word_size_review_0);assert.ok(saved.word_format_plan);assert.ok(saved.word_format_plan_repair_1);
  assert.notEqual(saved.word_format_plan.operations_sha256,saved.word_format_plan_repair_1.operations_sha256);
});

test('cross-issuer cross-product prose passes both preflight and host delivery without old-text padding', {skip:!python,timeout:60000}, async()=>{
  const f=fixture(true,'母公司非公开发行公司债券在上交所挂牌转让，投资者人数不得超过二百人。'.repeat(10));
  f.input.manifest.market='nafmii';f.input.manifest.offering='mtn';
  f.input.manifest.authoring.source_prospectuses=[{...f.input.materials[0]!.pin,issuer_name:'合成母公司',relation:'parent',
    market:'sse',offering:'private',reporting_periods:[],status:'user_asserted'}];
  const root=await mkdtemp(join(tmpdir(),'bb-flexible-template-'));
  try{
    const stage=fileAuthoringStage({load:async()=>f.input,model:options=>({name:'model_generation',run:async()=>{
      await options.fileWorkspace!.prepare(root);
      const data=JSON.parse(await readFile(join(root,'input.json'),'utf8'));
      const inspected=JSON.parse((await runFormatPython(['inspect','--input',join(root,'input.json')])).stdout);
      const node=inspected.nodes.find((n:{kind:string})=>n.kind==='paragraph');
      await writeFile(join(root,'output/operations.json'),JSON.stringify({version:'word-operations-v1',input_hash:data.input_hash,
        baseline_sha256:data.baseline_sha256,operations:[{id:'rewrite',kind:'replace_text',node_id:node.node_id,
          before:node.text,after:'合成子公司本期中期票据在银行间市场交易流通。'}]}));
      await runFormatPython(['preflight','--input',join(root,'input.json'),'--operations',join(root,'output/operations.json'),
        '--report',join(root,'scratch/preflight.json')]);
      const preview=JSON.parse(await readFile(join(root,'scratch/preflight.json'),'utf8'));
      assert.equal(preview.status,'passed');assert.equal(preview.host_acceptance,false);
      assert.ok(preview.quality_report.metrics.prose_retention<.1);
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:'synthetic-call'} as any)};
    }})});
    const result=await stage.run(f.ctx);
    assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('expected completion');
    f.ctx.values.set('model_generation',result.value);
    const delivered=await f.delivery().run(f.ctx);
    assert.equal(delivered.kind,'deliver',JSON.stringify(delivered));
    if(delivered.kind!=='deliver')throw Error('expected delivery');
    assert.equal((delivered.wordSummary!.quality_gate as {status:string}).status,'passed');
  }finally{await rm(root,{recursive:true,force:true});}
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
      assert.deepEqual(await f.delivery().run(f.ctx), { kind: 'fail', code: 'WORD_QUALITY_REJECTED' });
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
      await assert.rejects(f.delivery().run(f.ctx),/SYNTHETIC_STORAGE_OUTAGE/);
      const delivery = await f.delivery().run(f.ctx);
      assert.equal(delivery.kind, 'deliver');
      if(delivery.kind!=='deliver')throw Error('expected delivery');
      assert.notEqual(digest(delivery.cleanBytes!), digest(Buffer.from('PK arbitrary model document')));
      const diagnostic = delivery.wordSummary!.format_diagnostic as FormatDiagnostic;
      assert.equal(diagnostic.status, 'pending');
      assert.ok(diagnostic.files.plan);
      assert.equal(digest(f.objects.get(diagnostic.files.plan.key)!),diagnostic.files.plan.sha256);
      const report = JSON.parse((await diagnoseFormat({ id: 'job', run_id: 'run', owner_user_id: 'owner', project_id: 'project',
        input_hash: 'a'.repeat(64), diagnostic }, f.blobs)).toString('utf8'));
      assert.equal(report.status, 'passed', JSON.stringify(report));
      assert.equal(calls, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing snapshot without format policy retains direct generation with independent host quality checks',{skip:!python},async()=>{
  const f=fixture(false),root=await mkdtemp(join(tmpdir(),'bb-format-legacy-'));
  try{
    const stage=fileAuthoringStage({load:async()=>f.input,model:options=>({name:'model_generation',run:async()=>{
      await options.fileWorkspace!.prepare(root);
      assert.equal(JSON.parse(await readFile(join(root,'input.json'),'utf8')).format_tools,undefined);
      for(const name of ['tracked.docx','clean.docx'])await writeFile(join(root,'output',name),f.source);
      await writeFile(join(root,'output/baseline.docx'),'model-provided false baseline');
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:'legacy-call'} as Parameters<NonNullable<typeof options.fileWorkspace>['collect']>[1])};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');
    if(result.kind!=='done')throw Error('expected result');
    f.ctx.values.set('model_generation',result.value);
    const saved=result.value as FileAuthoringResult;
    assert.equal(saved.files['baseline.docx']!.sha256,digest(f.source));
    assert.ok(saved.files['input.json']);
    const delivery=await f.delivery().run(f.ctx);
    assert.equal(delivery.kind,'deliver');
    if(delivery.kind==='deliver'){
      assert.equal(delivery.wordSummary?.format_execution,undefined);
      assert.equal((delivery.wordSummary!.quality_gate as {status:string}).status,'passed');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

for(const failure of ['quality_timeout','quality_report_store'] as const)test(`format plan remains indexed after ${failure} and a restart reuses recorded model output`,{skip:!python,timeout:60000},async()=>{
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-format-plan-checkpoint-'));
  let modelCalls=0,qualityCalls=0,failOnce=true;
  try{
    const generation=fileAuthoringStage({load:async()=>f.input,model:options=>({name:'model_generation',run:async()=>{
      modelCalls++;
      await options.fileWorkspace!.prepare(root);
      await runFormatPython(['no_changes','--input',join(root,'input.json'),'--operations',join(root,'output/operations.json'),
        '--reason','Synthetic unchanged draft for infrastructure recovery.']);
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:'call'} as any)};
    }})});
    const generated=await generation.run(f.ctx);assert.equal(generated.kind,'done');
    if(generated.kind!=='done')throw Error('expected recorded model result');
    const value=generated.value as FileAuthoringResult;
    f.ctx.values.set('model_generation',value);
    await rm(root,{recursive:true,force:true});
    const put=f.blobs.put.bind(f.blobs);
    f.blobs.put=async(...args)=>{
      if(failure==='quality_report_store' && failOnce && args[0].includes('/quality/')){
        failOnce=false;throw Error('SYNTHETIC_QUALITY_REPORT_STORE_FAILURE');
      }
      return put(...args);
    };
    const quality:typeof verifyWordQuality=async input=>{
      qualityCalls++;
      assert.equal(f.persisted.writes,1,'plan must be durable before the first quality call');
      if(failure==='quality_timeout' && failOnce){failOnce=false;throw Error('SYNTHETIC_QUALITY_TIMEOUT');}
      return verifyWordQuality(input);
    };
    if(failure==='quality_timeout'){
      await assert.rejects(fileAuthoringDeliveryStage({quality,checkpoint:async()=>{throw Error('SYNTHETIC_CHECKPOINT_OUTAGE');}}).run(f.ctx),/SYNTHETIC_CHECKPOINT_OUTAGE/);
      assert.equal(qualityCalls,0);assert.equal(f.persisted.writes,0,'a failed checkpoint cannot advance to quality checking');
    }
    await assert.rejects(f.delivery({quality}).run(f.ctx),/SYNTHETIC_QUALITY_(TIMEOUT|REPORT_STORE_FAILURE)/);
    const saved=f.persisted.checkpoint.stages as Record<string,Record<string,unknown>>;
    const bound=saved.word_format_plan!;
    assert.equal(bound.version,'word-format-plan-checkpoint-v1');
    assert.equal(bound.input_hash,f.ctx.run.input_hash);
    assert.equal(bound.locked_input_sha256,value.files['input.json']!.sha256);
    assert.equal(bound.baseline_sha256,value.files['baseline.docx']!.sha256);
    assert.equal(bound.operations_sha256,value.files['operations.json']!.sha256);
    const plan=bound.plan as {key:string;sha256:string;byte_size:number};
    const stored=f.objects.get(plan.key)!;
    assert.equal(digest(stored),plan.sha256);assert.equal(stored.length,plan.byte_size);
    assert.equal(saved.word_delivery,undefined,'evidence is indexed independently of a delivery result');
    // Reconstruct both stage maps from the durable snapshot as a new process would.
    const restarted:StageContext={...f.ctx,lease:{...f.ctx.lease,checkpoint:structuredClone(f.persisted.checkpoint)},
      checkpoint:structuredClone(saved),values:new Map([['model_generation',structuredClone(value)]])};
    const writesBeforeRetry=f.persisted.writes;
    for(const field of ['input_hash','locked_input_sha256','baseline_sha256','operations_sha256','plan']){
      const conflict=structuredClone(restarted.lease.checkpoint);
      const entry=(conflict.stages as Record<string,Record<string,unknown>>).word_format_plan!;
      entry[field]=field==='plan'?{...plan,sha256:'0'.repeat(64)}:'0'.repeat(64);
      const conflicting:StageContext={...restarted,lease:{...restarted.lease,checkpoint:conflict}};
      assert.deepEqual(await f.delivery({quality}).run(conflicting),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
      assert.deepEqual(conflicting.lease.checkpoint,conflict,'conflicting evidence must not be replaced');
      assert.equal(f.persisted.writes,writesBeforeRetry);assert.equal(qualityCalls,1);
    }
    const delivery=await f.delivery({quality}).run(restarted);
    assert.equal(delivery.kind,'deliver');assert.equal(modelCalls,1);assert.equal(qualityCalls,2);
    assert.equal(f.persisted.writes,1,'matching evidence reuses the original durable binding');
    assert.deepEqual(f.persisted.checkpoint.stages,saved);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnostics reject foreign or oversized references before reading storage', () => {
  const ref = { key: 'owners/owner/projects/project/runs/run/file-authoring/call/a', sha256: 'b'.repeat(64), byte_size: 20 };
  const row = { id: 'job', run_id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64), diagnostic: {
    version: 'word-format-diagnostic-v1' as const, status: 'pending' as const, input_hash: 'a'.repeat(64), revision_author: 'BondBuddy-a',
    files: { baseline: { ...ref }, tracked: { ...ref }, operations: { ...ref } } } };
  assert.ok(validFormatDiagnostic(row));
  const files=(row.diagnostic as FormatDiagnostic).files;
  files.plan={...ref};
  assert.ok(validFormatDiagnostic(row));
  files.plan={...ref,key:'owners/other/projects/project/runs/run/file-authoring/format-plan.json'};
  assert.equal(validFormatDiagnostic(row),false);
  files.plan={...ref,byte_size:33*1024*1024};
  assert.equal(validFormatDiagnostic(row),false);
  delete files.plan;
  row.diagnostic.files.baseline.key = 'owners/other/projects/project/runs/run/file-authoring/call/a';
  assert.equal(validFormatDiagnostic(row), false);
  row.diagnostic.files.baseline = { ...ref, byte_size: 101 * 1024 * 1024 };
  assert.equal(validFormatDiagnostic(row), false);
});
