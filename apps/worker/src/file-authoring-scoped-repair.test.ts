// Real host preparation, collection, Python replay and checking; synthetic model answers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {digest} from '@bondbuddy/api/data';
import {emptyUpdateDetails} from '@bondbuddy/contracts';
import {makeWorkerDocxFixture} from './docx-test-fixture.js';
import {fileAuthoringStage,fileAuthoringDeliveryStage,type FileAuthoringResult} from './file-authoring-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import type {StageContext} from './run-pipeline.js';
import type {UnifiedInput} from './unified-input.js';
import type {WordQualityReport} from './file-authoring-quality.js';

const python=!!(process.env.BONDBUDDY_TEST_PYTHON||process.env.BONDBUDDY_WORD_PYTHON);
async function fixture(){
  const source=makeWorkerDocxFixture({externalLink:false,paragraphs:['第一章 公司名称变更','原有名称变更说明','第二章 保留业务','本期供热收入120万元，保留这段内容。']});
  const pin={material_id:'synthetic-source',material_version:1,sha256:digest(source),role:'historical'};
  const input:UnifiedInput={requirements:[],materials:[{pin,filename:'source.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:'source',records:[]}],
    manifest:{issuer_name:'合成发行人',market:'sse',offering:'private',materials:[pin],update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},
      authoring:{version:'unified_v1',requirements:[],source_prospectuses:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval',
        format_policy:{version:'source-format-v1',mode:'preserve_docx',selection:'automatic',template:{kind:'material',material_id:pin.material_id,material_version:1,sha256:pin.sha256}}}}};
  const objects=new Map([['source',source]]);
  const ctx={run:{id:'synthetic-run',owner_user_id:'owner',project_id:'project',input_hash:'a'.repeat(64)},lease:{checkpoint:{}},checkpoint:{},signal:new AbortController().signal,
    values:new Map(),blobs:{getIfExistsBounded:async(key:string)=>objects.get(key)??null,put:async(key:string,bytes:Buffer)=>{objects.set(key,bytes);}}} as unknown as StageContext;
  const root=await mkdtemp(join(tmpdir(),'bb-chapter-stage-'));
  try{
    const outcome=await fileAuthoringStage({load:async()=>input,config:loadCodexAdapterConfig({}),model:options=>({name:'model_generation',run:async()=>{
      await options.fileWorkspace!.prepare(root);
      const manifest=JSON.parse(await readFile(join(root,'template-manifest.json'),'utf8'));
      const node=manifest.nodes.find((n:{text:string;kind:string})=>n.kind==='paragraph' && n.text==='原有名称变更说明');
      await writeFile(join(root,'output/operations.json'),JSON.stringify({version:'word-operations-v1',input_hash:ctx.run.input_hash,baseline_sha256:pin.sha256,
        operations:[{id:'empty_body',kind:'replace_text',node_id:node.node_id,before:node.text,after:''}]}));
      const value=await options.fileWorkspace!.collect(root,{call_id:'initial'} as never);
      return {kind:'done',value};
    }})}).run(ctx);
    assert.equal(outcome.kind,'done');if(outcome.kind!=='done')throw Error('initial fixture failed');
    const previous=outcome.value as FileAuthoringResult;
    const report:WordQualityReport={version:'word-quality-v1',status:'failed',issues:[{code:'WORD_SOURCE_CHAPTER_CONTENT_LOST'}],metrics:{},limitations:[]};
    const reportBytes=Buffer.from(JSON.stringify(report)),key='owners/owner/projects/project/runs/synthetic-run/file-authoring/quality/report.json';
    objects.set(key,reportBytes);
    const reportRef={key,sha256:digest(reportBytes),byte_size:reportBytes.length};
    return {input,ctx,objects,previous,repair:{mode:'chapter_body' as const,round:1,previous,report,reportRef}};
  }finally{await rm(root,{recursive:true,force:true});}
}

for(const variant of ['valid','foreign','missing','malformed'] as const)test(`scoped collector ignores generic edits and handles ${variant} answers`,{skip:!python},async()=>{
  const f=await fixture(),root=await mkdtemp(join(tmpdir(),'bb-chapter-answer-'));
  const original=f.objects.get(f.previous.files['operations.json'].key)!;
  try{
    const outcome=await fileAuthoringStage({load:async()=>f.input,repair:f.repair,config:loadCodexAdapterConfig({}),model:options=>({name:'model_generation',run:async()=>{
      assert.equal(options.logicalCallId,'file-authoring-chapter-repair-1');
      await options.fileWorkspace!.prepare(root);
      const scope=JSON.parse(await readFile(join(root,'chapter-repair.json'),'utf8'));
      assert.equal(scope.targets.length,1);
      // These edits must never be collected, even with a valid-looking replacement log.
      await writeFile(join(root,'output/operations.json'),'MODEL_GENERIC_LOG_BYPASS');
      await writeFile(join(root,'output/clean.docx'),'MODEL_WORD_BYPASS');
      if(variant!=='missing')await writeFile(join(root,'output/repair-answers.json'),variant==='malformed'?'{bad json':JSON.stringify({
        version:'word-chapter-repair-answers-v1',scope_sha256:scope.scope_sha256,
        answers:[{issue_id:variant==='foreign'?'another-chapter':scope.targets[0].issue_id,text:'经合成测试材料核对，本期公司名称未发生变更。'}]}));
      return {kind:'done',value:await options.fileWorkspace!.collect(root,{call_id:'scoped'} as never)};
    }})}).run(f.ctx);
    assert.equal(outcome.kind,'done');if(outcome.kind!=='done')throw Error('expected retained result');
    const result=outcome.value as FileAuthoringResult;
    assert.equal(f.objects.get(f.previous.files['operations.json'].key),original);
    assert.ok(result.files['repair-scope.json']);assert.equal(result.files['clean.docx'],undefined);
    if(variant==='valid'){
      assert.equal(result.error,undefined);
      const log=JSON.parse(f.objects.get(result.files['operations.json'].key)!.toString());
      assert.deepEqual(log.operations.slice(0,1),JSON.parse(original.toString()).operations);
      assert.equal(log.operations.length,2);
      assert.equal(log.operations[0].node_id,log.operations[1].node_id);
      f.ctx.values.set('model_generation',result);
      const delivered=await fileAuthoringDeliveryStage({load:async()=>f.input,checkpoint:async()=>{},pause:async()=>false,
        repair:async()=>assert.fail('repaired candidate should pass real host check')}).run(f.ctx);
      assert.equal(delivered.kind,'deliver');
      if(delivered.kind==='deliver')assert.ok(delivered.bytes.length>100);
    }else{
      assert.equal(result.error,'WORD_QUALITY_REJECTED');
      assert.equal(result.files['operations.json'],undefined);
      assert.match(String(result.summary.validation_error),/^WORD_REPAIR_/);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
