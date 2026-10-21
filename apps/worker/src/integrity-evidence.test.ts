import test from 'node:test';
import assert from 'node:assert/strict';
import {INTEGRITY_SITES,integrityPortal,resolveIntegritySite,integritySourceAllowed,type IntegritySubject} from '@bondbuddy/contracts';
import {integrityRecords,integrityQueries} from './integrity-evidence.js';
const subject:IntegritySubject={id:'s',kind:'company',name:'合成测试企业',identifier:'123456789012345678',role:'发行人',province:'广东',city:'深圳市'};
const when='2026-10-21T00:00:00.000Z';
test('regional links distinguish special cities and reject incomplete or mismatched registration',()=>{
 assert.match(integrityPortal('广东省','深圳市')!.csrc,/shenzhen/);
 assert.equal(integrityPortal('广东',''),undefined);assert.equal(integrityPortal('福建','深圳'),undefined);
 assert.equal(integrityPortal('不存在',''),undefined);assert.ok(integrityPortal('内蒙古自治区','呼和浩特'));
});
test('evidence only accepts configured official host and the selected CSRC bureau path',()=>{
 const site=resolveIntegritySite(INTEGRITY_SITES.find(s=>s.id==='local-csrc')!,subject);
 assert.equal(integritySourceAllowed(site,site.links[0].url),true);
 for(const url of ['https://www.csrc.gov.cn/guangdong/a.shtml','https://www.csrc.gov.cn.evil.test/shenzhen/','https://user@www.csrc.gov.cn/shenzhen/','javascript:alert(1)','https://www.csrc.gov.cn:444/shenzhen/'])assert.equal(integritySourceAllowed(site,url),false);
});
test('model-only links, generic queries and unverifiable quotations never become actual checks or clearance',()=>{
 const records=integrityRecords(subject,['gsxt'],{sites:[{site_id:'gsxt',note:'全部通过',sources:[{url:'https://www.gsxt.gov.cn/test',quote:subject.name}]}]},[],when);
 assert.equal(records[0].search_performed,false);assert.equal(records[0].status,'query_failed');assert.equal(records[0].sources.length,0);
 const events=[{observed_at:when,item:{id:'t',type:'web_search',action:{type:'search',query:subject.name}}}];
 assert.equal(integrityRecords(subject,['gsxt'],null,events,when)[0].search_performed,false);
 assert.deepEqual(integrityQueries([{observed_at:when,item:{id:'t',type:'web_search',status:'failed',action:{query:subject.name}}}]),[]);
});
test('actual site-restricted search without results remains manual; quotations require returned text and subject name',()=>{
 const url='https://www.gsxt.gov.cn/test',quote=subject.name+' 测试公开记录';
 const events=[{observed_at:when,item:{id:'real-tool',type:'web_search',action:{type:'search',query:subject.name+' site:www.gsxt.gov.cn'},results:[{url,title:'合成记录',text:quote}]}}];
 const missing=integrityRecords(subject,['gsxt','execution'],null,events,when);
 assert.equal(missing[0].search_performed,true);assert.equal(missing[0].status,'needs_manual');assert.equal(missing[1].search_performed,false);
 const found=integrityRecords(subject,['gsxt'],{sites:[{site_id:'gsxt',note:'',sources:[{url,quote},{url,quote:'模型编造'}]}]},events,when)[0];
 assert.equal(found.status,'public_matches');assert.equal(found.sources.length,1);assert.equal(found.sources[0].tool_call_id,'real-tool');
 const person=integrityRecords({...subject,kind:'person'},['gsxt'],null,events,when)[0];assert.equal(person.status,'not_applicable');assert.equal(person.search_performed,false);
});
