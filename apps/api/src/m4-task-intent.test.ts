import test from 'node:test';
import assert from 'node:assert/strict';
import type {M4AssistantReply,M4QaManifest} from '@bondbuddy/contracts';
import {emptyM4Context,classifyM4Qa,classifyM4RequestIntent,constrainFreeM4Reply} from './m4-workspace.js';
import {resolveAutomaticTaskPrice} from './automatic-pricing.js';

test('selected document cannot make an independent business answer free',()=>{
 const plain=emptyM4Context(),selected={...plain,document_type:'init' as const,draft_version:1};
 for(const content of ['请写出本期收入增长的主要原因。','请根据材料给出本期收入增长的原因。','请说明本期收入增长的主要原因。','请核对本期收入数据并回答问询。','保存任务要求，并分析现金流。']){
  assert.equal(classifyM4RequestIntent(content),'business_question',content);
  assert.equal(classifyM4Qa(content,plain),classifyM4Qa(content,selected),content);
  assert.equal(resolveAutomaticTaskPrice('m4_qa',{content}).points,1218);
 }
});
test('literal document requirements have no separate answer charge; ambiguous requests only clarify',()=>{
 for(const content of ['保存任务要求：在募集书中说明收入下降原因','把核对现金流作为本次任务重点','请生成立项报告，分析偿债能力','更新募集书，并解释收入变化','更新募集书，只改措辞，不要更新财务数字']){
  assert.equal(classifyM4RequestIntent(content),'task_preparation',content);
  assert.equal(classifyM4Qa(content,emptyM4Context()),'m4_task_assistance',content);
 }
 assert.equal(classifyM4RequestIntent('请生成立项报告，另外单独解释收入增长原因'),'business_question');
 for(const content of ['这个呢？','再处理一下','募集说明书'])assert.equal(classifyM4RequestIntent(content),'clarify',content);
 assert.equal(classifyM4Qa('如何上传材料，并分析现金流',emptyM4Context()),'m4_Q01');
});
test('subscription and wallet operation help remains free without exempting bond-business questions',()=>{
 for(const content of ['如何取消自动续费','怎么申请退款','月付如何升级到年付','我的积分为什么过期','订阅积分什么时候过期','怎么查看账单','充值未到账怎么办','如何管理订阅','如何申请退款进度'])
  assert.equal(classifyM4Qa(content,emptyM4Context()),'m4_Q00',content);
 for(const content of ['解释债券提前赎回的退款条款','如何计算债券兑付退款金额','怎么申请募集资金退款','如何取消自动续费，并分析现金流'])
  assert.notEqual(classifyM4Qa(content,emptyM4Context()),'m4_Q00',content);
});
test('one-sentence multiple answers must use the existing itemized question flow',()=>{
 for(const content of ['请说明收入增长原因，并说明负债下降原因','请分析收入下降原因；请核对债务余额','收入为何增长，负债为何下降','1. 说明收入增长\n2. 核对抵押资产','收入为何增长？负债为何下降？'])
  assert.throws(()=>resolveAutomaticTaskPrice('m4_qa',{content}),(e:any)=>e.code==='SCOPE_UNSUPPORTED',content);
 for(const content of ['比较两期资产负债率，并计算差额','请说明收入增长原因，并说明依据','请说明收入增长原因，并给出引用','请计算资产负债率，并解释计算方法'])
  assert.equal(resolveAutomaticTaskPrice('m4_qa',{content}).points,1218,'Same-answer evidence and calculation remain included: '+content);
});
test('free reply constraints remove business answers and invented requirements',()=>{
 const raw:M4AssistantReply={content:'收入下降是因为客户流失，负债率为42%。',citations:[],requirements:['客户流失结论已确认'],fields:{issuer_name:'模型编造发行人'},intent:'draft',document_type:'init',target_business:null,retrieval:'not_performed'};
 const manifest=(content:string,billing_task:'m4_task_assistance'|'m4_Q00'):M4QaManifest=>({version:'m4-qa-input-v1',kind:'qa',topic_id:'topic',message_id:'message',content,context:emptyM4Context(),context_snapshot:{draft:null,messages:[]},materials:[],billing_task});
 for(const content of ['这个呢？','请说明本期收入下降原因']){
  const bounded=constrainFreeM4Reply(raw,manifest(content,'m4_task_assistance'));
  assert.equal(bounded.intent,'clarify');assert.deepEqual(bounded.fields,{});assert.deepEqual(bounded.requirements,[]);assert.doesNotMatch(bounded.content,/客户流失|42%/);
 }
 for(const content of ['保存任务要求：在募集书中说明收入下降原因','更新募集书，并解释收入变化']){
  const bounded=constrainFreeM4Reply(raw,manifest(content,'m4_task_assistance'));
  assert.deepEqual(bounded.requirements,[content]);assert.deepEqual(bounded.fields,{});assert.doesNotMatch(bounded.content,/客户流失|42%/);
  assert.deepEqual(constrainFreeM4Reply(bounded,manifest(content,'m4_task_assistance')),bounded,'A recovered free result has the same bounded meaning');
 }
 const help=constrainFreeM4Reply(raw,manifest('如何上传材料','m4_Q00'));assert.equal(help.intent,'answer');assert.match(help.content,/材料区上传/);assert.deepEqual(help.requirements,[]);assert.doesNotMatch(help.content,/客户流失|42%/);
});
