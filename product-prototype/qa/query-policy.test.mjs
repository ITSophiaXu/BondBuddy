import test from 'node:test';
import assert from 'node:assert/strict';
import { planQueries, hasExternalData } from '../public/query-policy.js';
import { pointCapacity } from '../public/usage-copy.js';
const connectors=[{id:'wind',name:'Wind',purpose:'bonds',enabled:true},{id:'off',name:'已停用债券服务',purpose:'bonds',enabled:false},{id:'registry',name:'工商服务',purpose:'registry',enabled:true},{id:'news',name:'公告检索',purpose:'search',enabled:true},{id:'other',name:'司法案件库',purpose:'other',enabled:true}];

test('ordinary material tasks do not call unrelated external services',()=>{
  const plan=planQueries({prompt:'根据最新财务报表整理一份摘要',connectors,webAvailable:true,registryAvailable:true});
  assert.deepEqual(plan.connectorIds,[]);assert.equal(plan.web,false);assert.equal(plan.registry,false);
});
test('automatic queries match purposes and exclude disabled services',()=>{
  const bonds=planQueries({prompt:'查询全部公司债兑付存续情况',connectors,webAvailable:true,registryAvailable:true});
  assert.deepEqual(bonds.connectorIds,['wind']);assert.equal(bonds.bondQuery,true);assert.equal(bonds.registry,false);
  assert.deepEqual(planQueries({prompt:'用 Wind 查询数据',connectors}).connectorIds,['wind']);
  assert.deepEqual(planQueries({prompt:'用企查查查询信息',connectors}).connectorIds,['registry']);
  const company=planQueries({prompt:'查询工商股东和最新公告',connectors,webAvailable:true,registryAvailable:true});
  assert.deepEqual(company.connectorIds,['registry','news']);assert.equal(company.web,true);assert.equal(company.registry,true);
  assert.deepEqual(planQueries({prompt:'请查询司法案件库',connectors}).connectorIds,['other']);
});
test('workflow queries run without a source picker and missing services stay unverified',()=>{
  const connected=planQueries({kind:'review',connectors});assert.deepEqual(connected.connectorIds,['wind','registry','news']);
  const missing=planQueries({kind:'update'});assert.deepEqual(missing.connectorIds,[]);assert(missing.limitations.some(t=>t.includes('尚未完成外部核验')));
  const search=planQueries({prompt:'查询最新公告'});assert.equal(search.web,false);assert(search.limitations.some(t=>t.includes('未执行联网搜索')));
});
test('an explicit materials-only request prevents external query planning',()=>{
  for(const prompt of ['仅依据上传材料核对公司债兑付情况','不要联网，整理最新公告']){
    const plan=planQueries({kind:'review',prompt,connectors,webAvailable:true,registryAvailable:true});
    assert.deepEqual(plan.connectorIds,[]);assert.equal(plan.web,false);assert.equal(plan.registry,false);assert.equal(plan.bondQuery,false);
  }
});

test('external access requires an active professional plan; personal workflows still process materials',()=>{
  for(const quota of [null,{active:false,plan:'professional'},{active:true,plan:'personal'}])assert.equal(hasExternalData(quota),false);
  assert.equal(hasExternalData({active:true,plan:'professional'}),true);
  for(const prompt of ['查询公司债兑付情况','查询工商股权','查询最新公告','使用 Wind 查询数据','用企查查查询信息']){
    const plan=planQueries({prompt,connectors,webAvailable:true,registryAvailable:true,externalDataAllowed:false});
    assert.equal(plan.requiresProfessional,true);assert.equal(plan.web,false);assert.equal(plan.registry,false);assert.deepEqual(plan.connectorIds,[]);
  }
  const local=planQueries({kind:'review',connectors,webAvailable:true,registryAvailable:true,externalDataAllowed:false});
  assert.deepEqual(local.connectorIds,[]);assert.equal(local.bondQuery,false);assert(local.limitations.some(t=>t.includes('专业版权益')));
  const material=planQueries({prompt:'仅依据上传材料核对公司债兑付情况',connectors,externalDataAllowed:false});
  assert.equal(material.requiresProfessional,false);assert.deepEqual(material.connectorIds,[]);
});
test('credit balance copy does not imply fixed task counts or confirmation',()=>{for(const n of [0,1,2000]){assert(pointCapacity(n).includes('点击即可执行'));assert(!pointCapacity(n).includes('评估'));}});
