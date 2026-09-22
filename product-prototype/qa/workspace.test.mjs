import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWork,normaliseWork,assessmentDigest } from '../lib/work-estimate.mjs';
import { businessProfile,sameTopBusinesses,validateBusinessRows } from '../lib/business-profile.mjs';
import { SCOPE_NAMES,offeringsFor } from '../public/markets.js';
import { loadKnowledge } from '../lib/knowledge.mjs';
import { reportingPeriods } from '../public/reporting-periods.js';
const doc={id:'D01',role:'historical',filename:'原稿.docx',records:[{locator:'P1',text:'测试发行人2025年募集书'}]};
test('work estimates distinguish years, cross-instrument conversion, material volume and no historical draft',()=>{
  const base={scope:'sse-public',sourceScope:'sse-public',authoringMode:'historical',updateMode:'full'};
  const financial=years=>({...doc,role:'audit',records:[{locator:'L1',text:years.map(year=>year+'年度财务资料').join('；')}]});
  const plain=estimateWork(base,[doc]);
  assert.equal(plain.points,2);
  assert(estimateWork({...base,sourceScope:'nafmii-mtn'},[doc]).points>plain.points);
  assert(estimateWork(base,[doc,financial([2023,2024,2025])]).points>estimateWork(base,[doc,financial([2025])]).points);
  assert.equal(estimateWork({...base,dataUpdate:'none',updateYears:'10'},[doc,financial([2025])]).points,estimateWork(base,[doc,financial([2025])]).points);
  assert(estimateWork({...base,authoringMode:'reference'},[{...doc,role:'audit'}]).points>plain.points);
  assert(estimateWork(base,[{...doc,records:[{locator:'P1',text:'材料'.repeat(80000)}]}]).points>plain.points);
  assert.equal(estimateWork(base,[doc]).reasons.reduce((n,r)=>n+r.points,0),plain.points);
  assert.notEqual(assessmentDigest(base,[{sha256:'a'}]),assessmentDigest({...base,projectMessages:[{text:'多一个要求'}]},[{sha256:'a'}]));
  const current=normaliseWork({dataUpdate:'none',updateYears:'-1',sourceScope:'bad'});assert.equal(current.updateMode,'full');for(const field of ['dataUpdate','updateYears','sourceScope'])assert(!(field in current));
  assert.throws(()=>normaliseWork({registrationMode:'bad'}));
});
test('top three businesses require cited consolidated revenue, match all three, and reject untraceable rows',async()=>{
  const text='测试发行人\n2025年度合并营业收入按业务（单位：万元）\n工程施工 | 500\n商品销售 | 300\n物业服务 | 100\n租赁 | 20';
  const documents=[{id:'D01',role:'audit',records:[{locator:'L1',text}]}];
  const profile=await businessProfile(documents,{year:2025,issuer:'测试发行人'});assert(profile.ready);assert.deepEqual(profile.rows.map(r=>r.name),['工程施工','商品销售','物业服务']);
  assert(sameTopBusinesses(profile,{...profile,rows:[...profile.rows].reverse()}));assert(!sameTopBusinesses(profile,{...profile,rows:profile.rows.slice(0,2)}));
  assert(!sameTopBusinesses(profile,{...profile,rows:profile.rows.map((r,i)=>i===2?{...r,key:'房地产开发'}:r)}));
  assert(!(await businessProfile(documents,{year:2024,issuer:'测试发行人'})).ready);
  assert(!(await businessProfile(documents,{year:2025,issuer:'另一家公司'})).ready);
  assert(!validateBusinessRows(profile.rows.map(r=>({...r,source:{...r.source,quote:'伪造收入999'}})),documents,2025).ready);
  assert(!validateBusinessRows(profile.rows.map(r=>({...r,basis:'母公司'})),documents,2025).ready);
});
test('market taxonomy and knowledge keep registration modes separate and never route banks to exchange rules',async()=>{
  assert(offeringsFor('nafmii').some(([v])=>v==='scp'));assert(!offeringsFor('nafmii').some(([v])=>v==='dfi'||v==='spn'));
  assert.equal(offeringsFor('sse').length,3);
  for(const scope of Object.keys(SCOPE_NAMES)){
    const knowledge=await loadKnowledge(scope,'review');assert.equal(knowledge.scope,scope);assert(knowledge.rules.length);
    assert.equal(reportingPeriods('2026-06-30',scope.split('-')[1]).periods.at(-1).end,'2026-06-30');
    if(scope.startsWith('nafmii'))assert(knowledge.rules.every(r=>r.rule_id.startsWith('NAFMII')));
  }
});
