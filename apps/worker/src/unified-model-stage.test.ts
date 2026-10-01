import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { chunkEvidence, promptLocator, unifiedModelGenerationStage } from './unified-model-stage.js';
import type { UnifiedInput } from './unified-input.js';
import type { StageContext } from './run-pipeline.js';

function input(source = true): UnifiedInput {
  const record = (material: string, id: string, text: string) => ({record_id:id,material_id:material,material_version:1,content_hash:'a'.repeat(64),locator_type:'text_line' as const,locator:{},literal_quote:text,context:'',extraction_method:'native_text' as const,extractor_version:'synthetic',confidence:null,uncertainty:[],formatting:{}});
  return { manifest: {issuer_name:'合成目标',market:'szse',offering:'public_all',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},materials:[],
    authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[{path:'synthetic.md',markdown:'合成测试知识',sha256:'a'.repeat(64)}],knowledge_status:'authoring_reference_not_compliance_approval'}},requirements:['合成补充要求'],materials:[
    {pin:{material_id:'report',material_version:1,role:'audit',sha256:'b'.repeat(64)},filename:'合成财务材料',mediaType:'text/plain',objectKey:'private/report',records:[record('report','r1','2025年净资产120万元')]},
    ...(source ? [{pin:{material_id:'source',material_version:1,role:'historical',sha256:'c'.repeat(64)},filename:'合成参考',mediaType:'text/plain',objectKey:'private/source',records:[record('source','s1','2024年净资产100万元'),record('source','s2','其他条款')]}] : [])] };
}
const ctx = () => ({run:{input_hash:'f'.repeat(64)},values:new Map(),checkpoint:{}} as unknown as StageContext);

test('unified update reads raw supporting records and requires complete baseline coverage and valid citations (synthetic)', async () => {
  const prompts: string[] = [];
  const stage=unifiedModelGenerationStage({load:async()=>input(),model:options=>({name:options.name,run:async context=>{
    prompts.push(await options.buildPrompt(context));
    const value=options.name.includes('read_') ? {notes:[{text:'2025年净资产120万元',evidence:['m0r0'],pending:false}]} :
      {reviewed:['m1r0','m1r1'],edits:[{record_id:'m1r0',after:'2025年净资产120万元',evidence:['m0r0'],pending:[]}],additions:[],summary:['更新财务期间及净资产']};
    assert.ok(options.validate(value));
    assert.match(options.logicalCallId,/^unified-v3-[a-z0-9_]+$/);
    assert.equal(options.templateVersion,'unified-authoring-v3');
    if ('notes' in value) {
      assert.equal(options.validate({notes:[{text:'合成数据',evidence:['m0r0-m0r2'],pending:false}]}),false);
      assert.equal(options.validate({notes:[{text:'合成数据',evidence:['target'],pending:false}]}),false);
    }
    if ('reviewed' in value) {
      assert.equal(options.validate({...value,reviewed:['m1r0']}),false);
      assert.equal(options.validate({...value,edits:[{...value.edits![0],evidence:['foreign-project/secret']}]}),false);
    }
    return {kind:'done',value};
  }})});
  const result=await stage.run(ctx());assert.equal(result.kind,'done');
  assert.equal(prompts.length,2);assert.match(prompts[0],/2025年净资产120万元/);assert.match(prompts[1],/合成补充要求/);assert.match(prompts[1],/public_all/);
  const data=JSON.parse(prompts[1]!.split('输入数据：\n')[1]!);
  assert.equal(data.editing_baseline.relation,null);assert.equal(data.editing_baseline.issuer_name,null);
  assert.match(prompts[1]!,/关系未知不能默认同企业/);
  if(result.kind==='done')assert.match((result.value as import('./unified-model-stage.js').UnifiedPlan).edits[0]!.pending.join(' '),/企业关系未提供/);
});

test('pinned knowledge citations are accepted with exact hash provenance; invented paths still fail',async()=>{
  const result=await unifiedModelGenerationStage({load:async()=>input(),model:options=>({name:options.name,run:async()=>{
    const value=options.name.includes('read_')?{notes:[{text:'净资产120万元',evidence:['m0r0'],pending:false}]}:
      {reviewed:['m1r0','m1r1'],edits:[{record_id:'m1r1',after:'按目标类型补充条款，适用事实待人工确认。',evidence:['synthetic.md','target'],pending:['适用事实待核']}],
        additions:[{after_record_id:'m1r1',blocks:[{kind:'paragraph',text:'按所附知识补充披露。',rows:[],evidence:['synthetic.md'],pending:['待核']}]}],summary:['补充目标类型条款']};
    assert.ok(options.validate(value));
    if(value.edits && value.additions){
      assert.equal(options.validate({...value,edits:[{...value.edits[0],evidence:['not-pinned.md']}]}),false);
      assert.equal(options.validate({...value,additions:[{...value.additions[0],blocks:[{...value.additions[0]!.blocks[0],evidence:['../synthetic.md']}]}]}),false);
    }
    return {kind:'done',value};
  }})}).run(ctx());
  assert.equal(result.kind,'done');
  if(result.kind==='done'){
    const plan=result.value as import('./unified-model-stage.js').UnifiedPlan;
    assert.deepEqual(plan.edits[0]!.evidence,[`knowledge:synthetic.md@${'a'.repeat(64)}`,'target']);
    assert.deepEqual(plan.additions[0]!.blocks[0]!.evidence,[`knowledge:synthetic.md@${'a'.repeat(64)}`]);
  }
});

test('no-source route writes chapters using issuer materials without a library or approved fact service (synthetic)', async()=>{
  let calls=0;
  const result=await unifiedModelGenerationStage({load:async()=>input(false),model:options=>({name:options.name,run:async()=>{
    calls++;
    const value=options.name.includes('read_')?{notes:[{text:'净资产120万元',evidence:['m0r0'],pending:false}]}:
      options.name.includes('outline')?{chapters:['发行人情况','财务会计信息']}:
      {blocks:[{kind:'paragraph',text:'根据材料，2025年净资产120万元。',rows:[],evidence:['m0r0'],pending:[]}],summary:['合成编制结果']};
    assert.ok(options.validate(value));return {kind:'done',value};
  }})}).run(ctx());
  assert.equal(result.kind,'done');assert.equal(calls,4);
});

test('unknown provider outcome stops all following generation and delivery (synthetic)', async()=>{
  let calls=0;
  const result=await unifiedModelGenerationStage({load:async()=>input(),model:options=>({name:options.name,run:async()=>{calls++;return {kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'};}})}).run(ctx());
  assert.deepEqual(result,{kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'});assert.equal(calls,1);
});

test('chunking preserves each raw record exactly once without silent truncation',()=>{
  const records=Array.from({length:401},(_,i)=>({id:String(i),text:'原文'.repeat(i%13+1),uncertainty:[]}));
  assert.deepEqual(chunkEvidence(records,400).flat(),records);
  assert.throws(()=>chunkEvidence([{id:'large',text:'x'.repeat(500),uncertainty:[]}],400),/block_too_large/);
});

test('prompt keeps layout coordinates without repeating private stable anchors',()=>{
  const locator={sheet:'财务报表',cell:'B10',merged_range:'B10:C10',stable_ref:{xml_path:'x'.repeat(2000)}};
  assert.deepEqual(promptLocator(locator),{sheet:'财务报表',cell:'B10',merged_range:'B10:C10'});
  assert.equal(locator.stable_ref.xml_path.length,2000);
  const path=[{table:1,row:2,column:3},{paragraph:1}];
  assert.deepEqual(promptLocator({path,stable_ref:'docx:internal'}),{path});
});

test('chunking bounds serialized UTF-8 including locator overhead without losing records',()=>{
  const records=Array.from({length:40},(_,i)=>({id:`r${i}`,text:'数值',uncertainty:[],locator:{sheet:'财务报表'.repeat(30),cell:`B${i}`}}));
  const chunks=chunkEvidence(records,18000,600,2000);
  assert.deepEqual(chunks.flat(),records);
  assert.ok(chunks.length>1);
  assert.ok(chunks.every(chunk=>Buffer.byteLength(JSON.stringify(chunk))<=2000));
  assert.throws(()=>chunkEvidence(records,18000,600,20),/block_too_large/);
});
