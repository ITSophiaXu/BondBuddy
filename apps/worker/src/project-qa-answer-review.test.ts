import test from 'node:test';
import assert from 'node:assert/strict';
import type {QaAnswer,QaInput,QaResult} from '@bondbuddy/contracts';
import type {codexModelStage,StageContext} from './run-pipeline.js';
import {projectQaAnswerStages} from './project-qa-stage.js';
import {qaMoneyConversions} from './project-qa-answer-review.js';

const question={id:'q/long:'+ 'x'.repeat(90),start:0,end:0,question:'请说明投资收益、全集团贸易是否存在空转，以及协议模板与实际收费情况。'};
const source='投资收益分别为123,456.78万元、-9,876.50万元、0.01亿元；应收3元。比率2%，数量50吨。';
const evidence:QaResult['evidence']=[{filename:'合成募集书.docx',snapshot:{version:'project-file-text-v1',format:'docx',sha256:'a'.repeat(64),coverage:'complete',warnings:[],spans:[{id:'p0',location:'段落 1',text:source,sha256:'a'.repeat(64)}]}}];
const draft:QaAnswer={question_id:question.id,answer:'投资收益123.46亿元。全集团不存在空转。已按模板收费。',status:'draft',missing_materials:[],citations:[{asset_index:0,span_id:'p0',quote:source}],case_ids:[],approach:''};
const reviewed:QaAnswer={...draft,answer:'投资收益12.345678亿元。【待确认：全集团贸易核查结论、模板比对及实际收费情况】',status:'missing',missing_materials:['全集团贸易核查结论。','模板比对及实际收费情况。']};
const input={project_name:'合成项目',requirements:'',cases:[]} as unknown as QaInput;
test('decimal money hints preserve signs, precision and units, and never infer a unit for bare cells',()=>{
 const facts=qaMoneyConversions(evidence,draft);
 assert.deepEqual(facts.map(x=>[x.literal,x.yi_yuan]),[['123,456.78万元','12.345678'],['-9,876.50万元','-0.98765'],['0.01亿元','0.01'],['3元','0.00000003']]);
 assert.equal(facts[0].yuan,'1234567800');assert.equal(facts[0].wan_yuan,'123456.78');
 assert.deepEqual(qaMoneyConversions(evidence,{...draft,citations:[...draft.citations,...draft.citations]}),facts);
 assert.deepEqual(qaMoneyConversions(evidence,{...draft,citations:[{...draft.citations[0],quote:'编造的金额1万元'}]}),[]);
 assert.deepEqual(qaMoneyConversions(evidence,{...draft,citations:[{...draft.citations[0],span_id:'typo'}]}),facts);
});
test('only the reviewed answer reaches the caller; review gets original question, evidence, draft and exact conversions',async()=>{
 const calls:string[]=[];
 const model:typeof codexModelStage=o=>({name:o.name,replay:true,run:async ctx=>{
  calls.push(o.logicalCallId);assert.ok(o.name.length+'_prompt'.length<=64);
  const prompt=await o.buildPrompt(ctx);assert.match(prompt,/合成募集书/);
  assert.ok(prompt.includes(question.question));
  if(o.logicalCallId.startsWith('qa-review-')){
   assert.match(prompt,/proposed_answer/);assert.ok(prompt.includes(draft.answer));assert.match(prompt,/12.345678/);
   assert.equal(o.validate({...reviewed,citations:[{asset_index:0,span_id:'p0',quote:'虚构'}]}),false);
   assert.equal(o.validate({...reviewed,question_id:'other'}),false);
   assert.equal(o.validate(reviewed),true);return {kind:'done',value:reviewed};
  }
  return {kind:'done',value:draft};
 }});
 assert.deepEqual(await projectQaAnswerStages(question,input,evidence,0,[],{model}).run({} as StageContext),{kind:'done',value:reviewed});
 assert.deepEqual(calls,['qa-'+question.id,'qa-review-'+question.id]);
});
test('a paused or failed review never falls back to the unreviewed draft',async()=>{
 for(const outcome of [{kind:'pause' as const,stage:'capability_not_ready' as const,reason:'synthetic pause'},{kind:'fail' as const,code:'SYNTHETIC_REVIEW_FAILED'},{kind:'stopped' as const}]){
  const model:typeof codexModelStage=o=>({name:o.name,replay:true,run:async()=>o.logicalCallId.startsWith('qa-review-')?outcome:{kind:'done',value:draft}});
  assert.deepEqual(await projectQaAnswerStages(question,input,evidence,0,[],{model}).run({} as StageContext),outcome);
 }
});
