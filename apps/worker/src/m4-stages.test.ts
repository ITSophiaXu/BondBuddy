import test from 'node:test';

test('global assistant CLI gets the selected context and proposes cards without executing; explicit discussion remains text',async()=>{
  for(const content of ['更新募集书，只改措辞，不要更新财务数字','先别更新募集书，只是讨论']){
    const f=await fixture('qa');
    try{
      const manifest=f.input.manifest as M4QaManifest;manifest.content=content;manifest.billing_task='m4_task_assistance';
      manifest.assistant_context={project_id:'source-project',project_name:'Synthetic',issuer_name:'Synthetic',market:'sse',offering:'private',reporting_cutoff:'2025-09-30',action:null};
      f.ctx.run.input_hash=inputManifestHash(manifest);let calls=0;
      const stage=m4QaStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
        calls++;await options.fileWorkspace!.prepare(f.directory);
        const input=JSON.parse(await readFile(join(f.directory,'input.json'),'utf8'));
        assert.equal(input.skill.id,'global-project-assistant');
        assert.equal(input.task.assistant_context.project_id,'source-project');
        await writeFile(join(f.directory,'output/reply.json'),JSON.stringify(reply({intent:'clarify',assistant_action:{business:'update',requirements:content,fields:{}}})));
        return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-global-assistant'} as never,{text:''})};
      }})});
      const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();
      assert.ok(validM4QaResult(result.value,f.ctx,f.input));assert.equal(calls,1);
      assert.equal(result.value.reply.assistant_action?.requirements,content.startsWith('先别')?undefined:content);
      assert.equal(result.value.reply.document_type,null);assert.deepEqual(result.value.reply.fields,{});
      assert.equal([...f.store.keys()].some(key=>key.includes('m4-documents')),false);
    }finally{await f.clean();}
  }
});

import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,chmod,link,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { digest } from '@bondbuddy/api/data';
import {loadM4Knowledge,loadWorkpaperKnowledge} from '@bondbuddy/api/m4-knowledge';
import type { M4AssistantReply,M4DocumentManifest,M4QaManifest } from '@bondbuddy/contracts';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { m4DocumentStage,m4DocumentDeliveryStage,validM4DocumentResult } from './m4-document-stage.js';
import { m4QaStage,authorizedM4Reply,constrainM4Reply,validM4QaResult } from './m4-qa-stage.js';
import { checkedM4File } from './m4-file-workspace.js';
import { modelGenerationRouter } from './model-generation-router.js';
import { m4ActionReason } from './m4-action-progress.js';
import { m4InputGate } from './m4-input.js';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import type { StageContext,InputRevisionRow } from './run-pipeline.js';
import type { M4WorkerInput } from './m4-input.js';

const root=resolve(fileURLToPath(import.meta.url),'../../../..'),runFile=promisify(execFile);
const python=process.env.BONDBUDDY_TEST_PYTHON??'python3';
async function fixture(kind:'document'|'qa'='document') {
  const base=resolve(tmpdir()),directory=await mkdtemp(join(base,'bb-m4-synthetic-'));
  const source=Buffer.from('Synthetic source, assets 100 and liabilities 50.');
  const pin={source_project_id:'source-project',material_id:'material',material_version:1,sha256:digest(source)};
  const document:M4DocumentManifest={version:'m4-document-input-v1',kind:'document',topic_id:'topic',execution_scope_project_id:'project',draft_version:1,
    input:{document_type:'private_summary',source_material:pin,materials:[pin],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'Synthetic'},requirements:[]},
    template_material:null,market:'sse',offering:'private',billing_task:'m4_G05'};
  const qa:M4QaManifest={version:'m4-qa-input-v1',kind:'qa',topic_id:'topic',message_id:'message',content:'请计算本期资产负债率',
    context:{document_type:null,draft_version:0,source_material:pin,citations:[],reading_artifact:null},
    context_snapshot:{draft:null,messages:[{message_id:'prior',version:1,role:'user',content:'Synthetic pinned history'}]},materials:[pin],billing_task:'m4_Q03'};
  const manifest=kind==='document'?document:qa;
  const store=new Map<string,Buffer>([['source',source]]),persisted:{sql:string;args?:unknown[]}[]=[];
  const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_revision:1,input_hash:inputManifestHash(manifest),task_kind:kind==='document'?'generation':'qa',billing_mode:'platform_trial'},
    lease:{owner:'owner',runId:'run',jobId:'job',token:'lease',attempts:1,checkpoint:{}},checkpoint:{},values:new Map(),signal:new AbortController().signal,
    blobs:{put:async(key:string,bytes:Buffer)=>{store.set(key,bytes);},getIfExistsBounded:async(key:string)=>store.get(key)??null}} as unknown as StageContext;
  const query=async(sql:string,args?:unknown[])=>{
    persisted.push({sql,args});
    if(sql.startsWith('SELECT r.*'))return {rows:[{...ctx.run,state:'running',event_cursor:0}]};
    if(sql.startsWith('SELECT * FROM bb_jobs'))return {rows:[{id:'job',state:'running',lease_token:'lease',lease_until:new Date(Date.now()+60000)}]};
    if(sql.includes('FROM bb_authoring_progress'))return {rows:[{active_ms:0,work_bps:0,accrued_points:0,clock_at:new Date(),sampled_at:new Date(),lease_until:null}]};
    if(sql.includes('RETURNING checkpoint'))return {rows:[{checkpoint:{}}]};
    if(sql.startsWith('SELECT event_cursor'))return {rows:[{event_cursor:0}]};
    if(sql.startsWith('SELECT result_hash FROM bb_project_file_generation_links'))return {rows:[{result_hash:[...persisted].reverse().find(p=>p.sql.startsWith('INSERT INTO bb_project_file_generation_links'))!.args![3]}]};
    return {rows:[],rowCount:1};
  };
  const client={query,release:()=>{}};ctx.pool={query,connect:async()=>client} as unknown as StageContext['pool'];
  const input:M4WorkerInput={manifest,materials:[{pin,filename:'synthetic.txt',mediaType:'text/plain',objectKey:'source'}],artifacts:[]};
  const clean=async()=>{assert.ok(directory.startsWith(base+(process.platform==='win32'?'\\':'/')));await rm(directory,{recursive:true,force:true});};
  return {directory,pin,source,ctx,input,store,persisted,clean};
}
async function outputWords(directory:string) {
  await runFile(python,['-B','-c',`from docx import Document\nfrom pathlib import Path\np=Path(${JSON.stringify(directory)})/'output'\nfor name,text in [('document.docx','Synthetic summary'),('preparation-note.docx','Synthetic preparation note')]:\n d=Document();d.add_paragraph(text);t=d.add_table(rows=2,cols=2);t.cell(0,0).text='项目';t.cell(1,0).text='资产';t.cell(1,1).text='100';d.save(p/name)\n`],{cwd:root,timeout:30000});
}
const reply=(overrides:Partial<M4AssistantReply>={}):M4AssistantReply=>({content:'Synthetic answer',citations:[],requirements:[],fields:{},intent:'answer',document_type:null,target_business:null,retrieval:'not_performed',...overrides});

for(const documentType of ['private_summary','underwriter','legal'] as const)for(const market of ['sse','szse'] as const)
test(`M4 ${market}/${documentType} single CLI file task receives knowledge/requirements and delivers editable Word`,async()=>{
  const f=await fixture();
  try {
    const manifest=f.input.manifest as M4DocumentManifest;manifest.input.document_type=documentType;manifest.market=market;
    manifest.billing_task=({private_summary:'m4_G05',underwriter:'m4_G02',legal:'m4_G03'} as const)[documentType];
    manifest.knowledge=loadM4Knowledge(market,documentType);manifest.input.requirements=[{requirement_id:'r',text:'不要生成签署页',message_id:'m',message_version:1}];manifest.input.supplemental_requirements='重点说明偿债安排，保留财务表格';
    f.ctx.run.input_hash=inputManifestHash(manifest);
    let calls=0;
    const stage=m4DocumentStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      calls++;assert.ok(options.fileWorkspace);assert.equal(options.materialTools,undefined);assert.equal(options.reviewTools,undefined);
      await options.fileWorkspace.prepare(f.directory);
      const input=JSON.parse(await readFile(join(f.directory,'input.json'),'utf8'));
      assert.equal(input.materials[0].path,'materials/m0.txt');assert.equal(input.authorized_sources[0].id,'material');
      assert.equal(input.task.input.scope,'whole');assert.deepEqual(await readFile(join(f.directory,'materials/m0.txt')),f.source);
      assert.deepEqual(input.requirements,['不要生成签署页','重点说明偿债安排，保留财务表格']);assert.equal(input.knowledge.market,market);
      assert.equal(input.knowledge.document_type,documentType);
      assert.equal(await readFile(join(f.directory,input.knowledge.path),'utf8'),manifest.knowledge!.content);
      assert.equal(input.skill.id,documentType==='private_summary'?'m4-private-summary':`m4-${documentType}`);
      await outputWords(f.directory);
      return {kind:'done',value:await options.fileWorkspace.collect(f.directory,{call_id:'synthetic-call'} as never,{text:'Synthetic final text'})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();
    assert.ok(validM4DocumentResult(result.value,f.ctx));assert.equal(calls,1);
    assert.equal(Object.keys(result.value.files).length,2);f.ctx.values.set('model_generation',result.value);
    const delivered=await m4DocumentDeliveryStage().run(f.ctx);assert.equal(delivered.kind,'deliver');if(delivered.kind!=='deliver')throw Error();
    assert.equal(delivered.namedArtifacts?.length,1);assert.notEqual(digest(delivered.bytes),digest(delivered.namedArtifacts![0].bytes));
    assert.match(String(delivered.wordSummary?.preview_content),/Synthetic summary/);assert.match(String(delivered.wordSummary?.preview_content),/资产 \| 100/);
    assert.match(delivered.namedArtifacts![0].previewContent!,/Synthetic preparation note/);
    result.value.files['document.docx']!.key=result.value.files['document.docx']!.key.replace('owners/owner/','owners/foreign/');
    assert.equal(validM4DocumentResult(result.value,f.ctx),false);
  }finally{await f.clean();}
});

test('workpaper CLI verifies full source, coverage, pinned template and links; preparation note stays internal',async()=>{
  const f=await fixture();
  try{
    const m=f.input.manifest as M4DocumentManifest;
    m.offering='public';m.billing_task='m4_workpaper';m.input.document_type='workpaper';
    m.input.workpaper={batch_id:'batch',catalogue_id:'catalogue',entry:{id:'s1-r2',code:'1.1',title:'财务分析',folder:'主体',path:'主体/1.1 财务分析.docx',sheet:'目录',row:2,instructions:'基于披露编制分析稿',kind:'file'},decision:{item_id:'s1-r2',status:'generate',reason:'披露支持分析',missing_materials:[],citations:[{span_id:'p0',quote:'合成披露'}]}};
    const text='合成发行人2025年末总资产100万元，负债50万元，资产负债率50%。偿债资金来源：本期营业回款和存量流动资产。合并口径与母公司口径分开列示，期末余额与期间发生额分开分析，未取得银行流水，尚不能确认实际账户收支。';
    const source=makeSyntheticDocxFixture({text});f.store.set('source',source);f.pin.sha256=digest(source);
    f.input.materials[0]!.filename='synthetic.docx';f.input.materials[0]!.mediaType='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    m.knowledge=loadWorkpaperKnowledge('sse','public');f.ctx.run.input_hash=inputManifestHash(m);
    let calls=0;
    const stage=m4DocumentStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      calls++;const prompt=await options.buildPrompt(f.ctx);assert.match(prompt,/不得根据募集说明书伪造/);assert.match(prompt,/仅当 status=generate/);
      await options.fileWorkspace!.prepare(f.directory);
      const input=JSON.parse(await readFile(join(f.directory,'input.json'),'utf8'));
      assert.equal(input.skill.id,'m4-workpaper');assert.deepEqual(input.task.input.workpaper,m.input.workpaper);assert.equal(input.task.offering,'public');
      assert.equal(input.materials[0].purpose,'source_prospectus');await outputWords(f.directory);
      assert.equal(JSON.parse(await readFile(join(f.directory,'source-spans.json'),'utf8')).spans[0].text,text);
      assert.ok(input.knowledge.template_path);assert.ok((await readFile(join(f.directory,input.knowledge.template_path))).length>1000);
      await assert.rejects(options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-workpaper'} as never,{text:'synthetic'}),/WORKPAPER_COVERAGE_REQUIRED|ENOENT|M4_OUTPUT_MISSING/);
      await runFile(python,['-B','-c',`from docx import Document\nfrom pathlib import Path\np=Path(${JSON.stringify(f.directory)})/'output/document.docx'\nd=Document(p);d.paragraphs[0].text=${JSON.stringify(text)};d.save(p)`],{cwd:root,timeout:30000});
      await writeFile(join(f.directory,'output/file-links.json'),JSON.stringify({links:[{source_span_id:'p0',source_quote:text,target_span_id:'p0',target_quote:text,field:'资产负债',period:'2025年末',unit:'万元'}]}));
      await writeFile(join(f.directory,'output/workpaper-coverage.json'),JSON.stringify({reviewed_span_ids:['p0'],used_span_ids:['p0'],excluded:[]}));
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-workpaper'} as never,{text:'synthetic'})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error('missing result');
    f.ctx.values.set('model_generation',result.value);const delivered=await m4DocumentDeliveryStage().run(f.ctx);
    assert.equal(calls,1);assert.equal(delivered.kind,'deliver');if(delivered.kind==='deliver'){assert.equal(delivered.bytes.readUInt32LE(0),0x04034b50);assert.equal(delivered.namedArtifacts?.length,0);}
  }finally{await f.clean();}
});

test('M4 missing output is honest, readonly input tampering fails and changed pinned method does not call CLI',async()=>{
  for(const action of ['missing','tamper','method'] as const){const f=await fixture();let calls=0;
    try{
      if(action==='method')f.ctx.checkpoint.m4_document_method={version:'older-method'};
      const stage=m4DocumentStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
        calls++;await options.fileWorkspace!.prepare(f.directory);
        if(action==='tamper'){await chmod(join(f.directory,'materials/m0.txt'),0o600);await writeFile(join(f.directory,'materials/m0.txt'),'changed');}
        return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-call'} as never,{text:''})};
      }})});
      if(action==='tamper')await assert.rejects(stage.run(f.ctx),/INPUT_REVISION_CONFLICT/);
      else {const result=await stage.run(f.ctx);if(action==='method'){assert.equal(result.kind,'pause');assert.equal(calls,0);}
        else{assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();f.ctx.values.set('model_generation',result.value);
          assert.deepEqual(await m4DocumentDeliveryStage().run(f.ctx),{kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'});}}
    }finally{await f.clean();}
  }
});

test('M4 QA reads fixed history and host recomputes operands; fabricated CLI numerical text is replaced',async()=>{
  const f=await fixture('qa');
  try{
    const stage=m4QaStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      await options.fileWorkspace!.prepare(f.directory);
      const input=JSON.parse(await readFile(join(f.directory,'input.json'),'utf8'));assert.equal(input.task.context_snapshot.messages[0].content,'Synthetic pinned history');
      await writeFile(join(f.directory,'output/reply.json'),JSON.stringify(reply({content:'资产负债率999%，此数字应被宿主替换'})));
      const source={...input.authorized_sources[0],locator:'text/1-1'},period='2025-12-31';
      await writeFile(join(f.directory,'output/calculation-request.json'),JSON.stringify({metric:'asset_liability_ratio',periods:[{period_end:period,entity_id:'synthetic',scope:'consolidated',values:
        Object.fromEntries([['total_liabilities','50'],['total_assets','100']].map(([name,value])=>[name,{value,unit:'万元',period_end:period,entity_id:'synthetic',scope:'consolidated',uncertain:false,source}]))}]}));
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-qa-call'} as never,{text:''})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();
    assert.ok(validM4QaResult(result.value,f.ctx,f.input));assert.match(result.value.reply.content,/50%/);assert.doesNotMatch(result.value.reply.content,/999/);
    assert.equal(result.value.reply.citations[0].locator,'text/1-1');assert.equal(result.value.reply.intent,'answer');assert.equal(result.value.calculation?.result.status,'calculated');
    assert.equal([...f.store.keys()].some(k=>k.includes('m4-documents')),false,'QA never creates Word files');
  }finally{await f.clean();}
});

test('M4 QA missing calculation asks for inputs, invalid/cross-owner references are rejected',async()=>{
  const f=await fixture('qa');
  try{
    const stage=m4QaStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      await options.fileWorkspace!.prepare(f.directory);await writeFile(join(f.directory,'output/reply.json'),JSON.stringify(reply({content:'伪造42%'})));
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-call'} as never,{text:''})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();
    assert.ok(validM4QaResult(result.value,f.ctx,f.input));assert.equal(result.value.reply.intent,'clarify');assert.doesNotMatch(result.value.reply.content,/42/);
    assert.equal(authorizedM4Reply(reply({citations:[{kind:'material',ref:{...f.pin,material_id:'foreign'},locator:'text/1-1'}]}),f.input),false);
    assert.equal(authorizedM4Reply(reply({intent:'execute',document_type:null}),f.input),false);
    assert.equal(authorizedM4Reply(reply({intent:'answer',requirements:['偷偷回填'],document_type:'init'}),f.input),false);
    assert.equal(authorizedM4Reply(reply({intent:'draft',requirements:['保存已明确的正式语气'],document_type:null}),f.input),true);
    assert.equal(authorizedM4Reply(reply({intent:'draft',fields:{issuer_name:'无文种不回填'},document_type:null}),f.input),false);
  }finally{await f.clean();}
});

test('M4 QA receives exact execution proposal and reading context but returns intent without creating Word or mutating input',async()=>{
  const f=await fixture('qa');
  try{
    const manifest=f.input.manifest as M4QaManifest;
    manifest.billing_task='m4_task_assistance';manifest.content='资料已确认，按当前报价开始制作私募摘要';
    manifest.context={...manifest.context,document_type:'private_summary',draft_version:7};
    manifest.execution_proposal={document_type:'private_summary',expected_draft_version:7,quote_id:'exact-visible-quote'};
    f.ctx.run.input_hash=inputManifestHash(manifest);
    const frozenHash=f.ctx.run.input_hash;let calls=0;
    const stage=m4QaStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      calls++;await options.fileWorkspace!.prepare(f.directory);
      const input=JSON.parse(await readFile(join(f.directory,'input.json'),'utf8'));
      assert.deepEqual(input.task.execution_proposal,manifest.execution_proposal);
      assert.equal(input.task.context.draft_version,7);assert.equal(input.task.context.source_material.sha256,f.pin.sha256);
      options.onActivity?.({type:'item.started',item:{type:'command_execution',command:'private-path',text:'hidden-reasoning'}} as never,{} as never);
      await writeFile(join(f.directory,'output/reply.json'),JSON.stringify(reply({intent:'execute',document_type:'private_summary',content:'已理解本轮明确执行意图。'})));
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-call'} as never,{text:''})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();
    assert.ok(validM4QaResult(result.value,f.ctx,f.input));
    assert.equal(result.value.reply.intent,'execute');assert.equal(calls,1);assert.equal(inputManifestHash(manifest),frozenHash);
    assert.equal([...f.store.keys()].some(key=>key.includes('m4-documents')),false);
    const progress=f.persisted.filter(p=>p.sql.startsWith('INSERT INTO bb_run_events')).map(p=>p.args?.[4]);
    assert.ok(progress.some(p=>(p as {reason?:string})?.reason==='m4_qa_working'));
    assert.doesNotMatch(JSON.stringify(progress),/private-path|hidden-reasoning/);
  }finally{await f.clean();}
});

test('M4 Q04 financial comparison requires a host receipt while concept methods and textual comparison remain usable',async()=>{
  for(const scenario of [
    {content:'比较两期偿债能力',answer:'资产负债率从42%降低到30%，偿债能力改善。',intent:'clarify'},
    {content:'比较两期偿债能力',answer:'偿债能力显著改善。',intent:'clarify'},
    {content:'如何比较两期偿债能力',answer:'先核对期间和合并口径，再采用一致公式比较资产负债率和流动比率。',intent:'answer'},
    {content:'比较两份募集书募集资金用途表述',answer:'前稿表述偿还存量债务，后稿增加补充营运资金；应核对对应授权原文。',intent:'answer'},
  ]){
    const f=await fixture('qa');
    try{
      const manifest=f.input.manifest as M4QaManifest;manifest.billing_task='m4_Q04';manifest.content=scenario.content;f.ctx.run.input_hash=inputManifestHash(manifest);
      const stage=m4QaStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
        await options.fileWorkspace!.prepare(f.directory);await writeFile(join(f.directory,'output/reply.json'),JSON.stringify(reply({content:scenario.answer})));
        return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-call'} as never,{text:''})};
      }})});
      const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();assert.ok(validM4QaResult(result.value,f.ctx,f.input));
      assert.equal(result.value.reply.intent,scenario.intent);
      if(scenario.intent==='clarify')assert.doesNotMatch(result.value.reply.content,/42%|30%|显著改善/);
      else assert.equal(result.value.reply.content,scenario.answer);
    }finally{await f.clean();}
  }
});

test('M4 Q04 two-period numerical result and difference come from the host receipt instead of model text',async()=>{
  const f=await fixture('qa');
  try{
    const manifest=f.input.manifest as M4QaManifest;manifest.billing_task='m4_Q04';manifest.content='比较两期偿债能力';f.ctx.run.input_hash=inputManifestHash(manifest);
    const stage=m4QaStage({load:async()=>f.input,config:loadCodexAdapterConfig({}),model:options=>({name:options.name,run:async()=>{
      await options.fileWorkspace!.prepare(f.directory);
      const input=JSON.parse(await readFile(join(f.directory,'input.json'),'utf8')),source={...input.authorized_sources[0],locator:'text/1-1'};
      await writeFile(join(f.directory,'output/reply.json'),JSON.stringify(reply({content:'模型虚构值：下降99.7个百分点。'})));
      await writeFile(join(f.directory,'output/calculation-request.json'),JSON.stringify({metric:'asset_liability_ratio',periods:[['2024-12-31','50'],['2025-12-31','60']].map(([period_end,liabilities])=>({
        period_end,entity_id:'synthetic',scope:'consolidated',values:Object.fromEntries([['total_liabilities',liabilities],['total_assets','100']].map(([name,value])=>[name,{
          value,unit:'万元',period_end,entity_id:'synthetic',scope:'consolidated',uncertain:false,source}]))}))}));
      return {kind:'done',value:await options.fileWorkspace!.collect(f.directory,{call_id:'synthetic-call'} as never,{text:''})};
    }})});
    const result=await stage.run(f.ctx);assert.equal(result.kind,'done');if(result.kind!=='done')throw Error();assert.ok(validM4QaResult(result.value,f.ctx,f.input));
    assert.equal(result.value.reply.intent,'answer');assert.match(result.value.reply.content,/50%/);assert.match(result.value.reply.content,/60%/);
    assert.match(result.value.reply.content,/两期差额：10 个百分点/);assert.doesNotMatch(result.value.reply.content,/99\.7/);
  }finally{await f.clean();}
});

test('M4 semantic guard distinguishes whole-action denial, method questions and local limits; unavailable work cannot execute',()=>{
  const manifest={content:''} as M4QaManifest;
  const execution=reply({intent:'execute',document_type:'init',requirements:['保留待核事项']});
  for(const content of ['暂时不要生成立项报告','先别生成','如何生成立项报告','怎么制作立项报告？'])
    assert.equal(constrainM4Reply(execution,{...manifest,content}).intent,'answer');
  for(const content of ['请生成立项报告，保留待核事项，不要新增风险承诺','补充资料已经上传了，请开始生成立项报告','不要生成法律意见，请生成立项报告'])
    assert.equal(constrainM4Reply(execution,{...manifest,content}).intent,'execute');
  for(const content of ['请生成公募募集书摘要','请生成立项报告和推荐函组合','只改第二章节并生成立项报告'])
    assert.equal(constrainM4Reply(execution,{...manifest,content}).intent,'clarify');
  const prepared=constrainM4Reply(execution,{...manifest,content:'先不要生成立项报告，请记录要求：保留待核事项'});
  assert.equal(prepared.intent,'draft');assert.deepEqual(prepared.requirements,['保留待核事项']);
  const pending=reply({intent:'draft',document_type:null,requirements:['语气正式']});
  assert.deepEqual(constrainM4Reply(pending,{...manifest,content:'先不要生成，记下要求语气正式'}),pending);
});

test('new opinion types preserve explicit execution and local restrictions, but whole-action denial still wins',()=>{
  for(const [type,label] of [['underwriter','主承销商核查意见'],['legal','法律意见书']] as const){
    const execution=reply({intent:'execute',document_type:type,requirements:['不要生成签署页']});
    assert.equal(constrainM4Reply(execution,{content:`请生成${label}，不要生成签署页`} as M4QaManifest).intent,'execute');
    assert.equal(constrainM4Reply(execution,{content:`先别生成${label}`} as M4QaManifest).intent,'answer');
    assert.equal(constrainM4Reply(execution,{content:`如何生成${label}`} as M4QaManifest).intent,'answer');
  }
});

test('M4 unavailable requests receive truthful capability feedback even if model claims success; basic concepts and negative requests remain usable',()=>{
  const manifest={content:''} as M4QaManifest;
  const invented=reply({content:'模型假称已完成最新检索并已生成法律意见。'});
  for(const content of ['请出具DFI推荐函','只修改第二章并导出','请联网查询现行法规','请检索最新法规','请开展深度研究']){
    const guarded=constrainM4Reply(invented,{...manifest,content});assert.equal(guarded.intent,'clarify');assert.doesNotMatch(guarded.content,/已完成最新检索|已生成法律意见/);
  }
  const conceptual=reply({content:'法规效力的基础概念包括生效、失效与适用时间。'});
  for(const content of ['解释法规效力是什么','深度研究是什么','不要联网，解释资产负债率概念','不要生成法律意见书，请解释法律意见的作用','不要只修改第二章，请完整编制'])
    assert.deepEqual(constrainM4Reply(conceptual,{...manifest,content}),conceptual);
});

test('M4 router requires explicit input-lock marker; ordinary M1 generation retains its route',async()=>{
  const f=await fixture();let docs=0,qa=0;
  try{const router=modelGenerationRouter({m4Document:{name:'model_generation',run:async()=>{docs++;return {kind:'done',value:'document'};}},
    m4Qa:{name:'model_generation',run:async()=>{qa++;return {kind:'done',value:'qa'};}}});
    assert.equal((await router.run(f.ctx)).kind,'pause');assert.equal(docs+qa,0);
    f.ctx.values.set('input_lock',{m4_mode:'document'});assert.deepEqual(await router.run(f.ctx),{kind:'done',value:'document'});
    f.ctx.values.set('input_lock',{m4_mode:'qa'});assert.deepEqual(await router.run(f.ctx),{kind:'done',value:'qa'});assert.equal(docs,1);assert.equal(qa,1);
  }finally{await f.clean();}
});

test('M4 input gate checks topic, subtype, scope and exact owned source hash',async()=>{
  const f=await fixture();
  try{const manifest=f.input.manifest as M4DocumentManifest;const input={manifest,input_hash:f.ctx.run.input_hash} as unknown as InputRevisionRow;
    let subtype='m4_document_v1',scope='project',materialHash=f.pin.sha256;
    f.ctx.pool={query:async(sql:string)=>sql.includes('FROM bb_m4_topics')?{rows:[{scope_id:scope,input_hash:f.ctx.run.input_hash,manifest,subtype}]}:
      sql.includes('FROM bb_material_versions')?{rows:[{filename:'synthetic.txt',media_type:'text/plain',object_key:'source',sha256:materialHash}]}:{rows:[]}} as unknown as StageContext['pool'];
    assert.equal(await m4InputGate(f.ctx.pool,f.ctx.run,input),null);
    subtype='default';assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,input))?.kind,'fail');subtype='m4_document_v1';
    scope='foreign';assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,input))?.kind,'fail');scope='project';
    materialHash='b'.repeat(64);assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,input))?.kind,'fail');
  }finally{await f.clean();}
});

test('M4 template registry and edit-base kind are explicit; retiring the exact old version does not silently change it',async()=>{
  const f=await fixture();
  try{
    const manifest=f.input.manifest as M4DocumentManifest;
    manifest.input.document_type='init';manifest.billing_task='m4_G01';manifest.input.template={template_id:'template',template_version:2,sha256:f.pin.sha256};
    manifest.template_material=f.pin;manifest.input.fields.broker='Synthetic Broker';
    let template={broker:'Synthetic Broker',document_type:'init',market:'sse',sha256:f.pin.sha256,material:f.pin,retired_at:new Date()};
    let baseKind='document';
    const refresh=()=>{f.ctx.run.input_hash=inputManifestHash(manifest);return {manifest,input_hash:f.ctx.run.input_hash} as unknown as InputRevisionRow;};
    f.ctx.pool={query:async(sql:string)=>sql.includes('FROM bb_m4_topics')?{rows:[{scope_id:'project',input_hash:f.ctx.run.input_hash,manifest,subtype:'m4_document_v1'}]}:
      sql.includes('FROM bb_m4_templates')?{rows:[template]}:sql.includes('FROM bb_material_versions')?{rows:[{filename:'synthetic.txt',media_type:'text/plain',object_key:'source',sha256:f.pin.sha256}]}:
      sql.includes('FROM bb_m4_artifacts')?{rows:[{kind:baseKind,document_type:'init'}]}:sql.includes('FROM bb_artifact_versions')?{rows:[{object_key:'base',media_type:'text/plain',sha256:f.pin.sha256}]}:{rows:[]}} as unknown as StageContext['pool'];
    assert.equal(await m4InputGate(f.ctx.pool,f.ctx.run,refresh()),null);
    template={...template,broker:''};assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,refresh()))?.kind,'fail','init still requires a broker');
    manifest.input.document_type='private_summary';manifest.billing_task='m4_G05';template={...template,document_type:'private_summary'};delete manifest.input.fields.broker;
    assert.equal(await m4InputGate(f.ctx.pool,f.ctx.run,refresh()),null,'summary template broker is optional');
    manifest.input.document_type='init';manifest.billing_task='m4_G01';manifest.input.fields.broker='Synthetic Broker';template={...template,broker:'Synthetic Broker',document_type:'init'};
    template={...template,broker:'Other Broker'};assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,refresh()))?.kind,'fail');template={...template,broker:'Synthetic Broker'};
    template={...template,sha256:'b'.repeat(64)};assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,refresh()))?.kind,'fail');template={...template,sha256:f.pin.sha256};
    manifest.input.edit_base={source_project_id:'project',artifact_id:'base',artifact_version:1,sha256:f.pin.sha256};
    assert.equal(await m4InputGate(f.ctx.pool,f.ctx.run,refresh()),null);baseKind='report';assert.equal((await m4InputGate(f.ctx.pool,f.ctx.run,refresh()))?.kind,'fail');
  }finally{await f.clean();}
});

test('M4 file reads reject traversal and hardlinks, and progress exposes safe reasons only',async()=>{
  const f=await fixture();
  try{await writeFile(join(f.directory,'plain'),'synthetic');await link(join(f.directory,'plain'),join(f.directory,'alias'));
    await assert.rejects(checkedM4File(f.directory,'plain'),/M4_OUTPUT_UNSAFE/);await assert.rejects(checkedM4File(f.directory,'../escape'),/M4_OUTPUT_UNSAFE/);
    const secret={type:'item.started',item:{type:'command_execution',command:'private-source-name',text:'hidden-reasoning'}};
    assert.equal(m4ActionReason(secret,'document'),'m4_document_working');assert.equal(m4ActionReason(secret,'qa'),'m4_qa_working');
    assert.equal(m4ActionReason({type:'item.completed',item:{type:'reasoning',text:'hidden'}},'document'),null);
    assert.equal(m4ActionReason({type:'item.completed',item:{type:'command_execution',exit_code:1}},'document'),null);
  }finally{await f.clean();}
});

test('M4 output symlink never publishes external bytes',{skip:process.platform!=='linux'},async()=>{
  const f=await fixture();try{await writeFile(join(f.directory,'outside'),'private');await symlink(join(f.directory,'outside'),join(f.directory,'linked'));
    await assert.rejects(checkedM4File(f.directory,'linked'),/M4_OUTPUT_UNSAFE/);
  }finally{await f.clean();}
});
