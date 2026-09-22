import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversation } from '../public/project-conversation.js';
const esc=value=>String(value??'').replaceAll('<','&lt;').replaceAll('"','&quot;');
function fixture(kind='update'){
  const state={route:kind,step:3},d={projectMessages:[],assessment:{quote:{id:'old'}}},node={value:''};
  const conversation=projectConversation({state,draft:()=>d,saveDraft:()=>{},esc,icon:()=>'',render:async()=>{},invalidate:()=>{delete d.assessment;},document:{querySelector:()=>node}});
  return {state,d,node,conversation};
}
test('expanded form recovers earlier conversation drafts without duplicate instructions or lost free notes',()=>{
  const {state,d,conversation}=fixture();Object.assign(d,{purposeCategory:'项目建设',purpose:'拟投入6亿元',useProject:'产业园二期',conversationTopic:'funding',conversationDrafts:{funding:{purposeCategory:'项目建设',purpose:'拟投入8亿元',useProject:'产业园二期'},issuance:{variant:'多个品种',trancheTerms:'3年6亿元，5年4亿元。'}},messageDraft:'另有授信资料待补充。',projectMessages:[{text:'【资金用途】\n资金用途：项目建设\n金额与具体安排：拟投入6亿元\n涉及项目 / 投资标的 / 基金：产业园二期'},{text:'保留的额外说明'}]});
  conversation.migrate('update');assert.equal(d.purpose,'拟投入8亿元');assert.match(d.trancheTerms,/多品种安排/);assert.equal(d.projectMessages.length,1);assert.equal(d.projectMessages[0].text,'保留的额外说明');assert.equal(d.messageDraft,'另有授信资料待补充。');assert.equal(d.conversationDrafts,undefined);assert.equal(d.assessment,undefined);assert.equal(state.step,2);
  d.purpose='表单里改为9亿元';conversation.migrate('update');assert.equal(d.purpose,'表单里改为9亿元');assert(!conversation.composer('update',d).includes('project-topic'));assert(!conversation.prompts('update').includes('资金用途'));
});
test('review preserves previously provided information as editable notes, without hidden duplicate fields',()=>{
  const {d,node,conversation}=fixture('review');Object.assign(d,{hasRating:'是',issuerRating:'AA+',purposeCategory:'偿还有息负债',purpose:'偿还5亿元贷款',conversationDrafts:{company:{isLGFV:'否',reviewNotes:'请核对新名称'}}});
  conversation.migrate('review');assert.equal(d.hasRating,'');assert.equal(d.purpose,'');assert(d.projectMessages.some(m=>m.text.includes('AA+')));assert(d.projectMessages.some(m=>m.text.includes('偿还5亿元贷款')));assert(d.projectMessages.some(m=>m.text.includes('请核对新名称')));
  const count=d.projectMessages.length;conversation.migrate('review');assert.equal(d.projectMessages.length,count);
  const html=conversation.composer('review',d)+conversation.prompts('review');for(const value of ['财务疑点','合规关注','公开信息线索','补充核验线索'])assert(html.includes(value));assert(!html.includes('project-topic'));
  d.messageDraft='截至____，银行授信____亿元。';conversation.commit('review',{automatic:true});assert.equal(d.projectMessages.length,count);
  node.value='公开工商资料显示公司已更名。';conversation.commit('review');assert.equal(d.projectMessages.length,count+1);
});
test('supplementary conversation edits and removal do not change information entered in the form',async()=>{
  const {d,node,conversation}=fixture();d.size='10亿元';d.purpose='补充流动资金';conversation.migrate('update');
  node.value='银行授信总额50亿元。';conversation.commit('update');await conversation.click('project-edit-message','0');node.value='银行授信总额60亿元。';conversation.commit('update');assert.equal(d.projectMessages.length,1);assert.equal(d.projectMessages[0].text,node.value);
  conversation.remove('update',0);assert.equal(d.projectMessages.length,0);assert.equal(d.size,'10亿元');assert.equal(d.purpose,'补充流动资金');
  node.value='截至____，授信总额____亿元。';assert.throws(()=>conversation.commit('update'),/填空/);assert.equal(d.projectMessages.length,0);
  d.messageDraft='<img src=x>';assert(conversation.composer('update',d).includes('&lt;img src=x>'));
});
