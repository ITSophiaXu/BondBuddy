import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalDefaults, normaliseOptional, updateFilesForMode, validateUpdateFiles } from '../public/project-fields.js';
import { validateDraftSection } from '../lib/reference-draft.mjs';

test('unknown optional answers stay blank and hidden stale dependent values never become task facts',()=>{
  const blank=normaliseOptional({});assert(Object.values(blank).every(v=>v===''));assert.equal(optionalDefaults().hasRating,'');
  const values=normaliseOptional({hasRating:'否',issuerRating:'AAA',ratingAgency:'旧评级公司',hasEnhancement:'',guarantor:'旧担保人',investorProtection:'否',protectionTerms:'旧条款',purpose:'项目建设',size:' 10亿元 '});
  assert.equal(values.issuerRating,'');assert.equal(values.ratingAgency,'');assert.equal(values.guarantor,'');assert.equal(values.protectionTerms,'');assert.equal(values.purpose,'项目建设');assert.equal(values.size,'10亿元');
  assert.throws(()=>normaliseOptional({hasRating:'not sure'}),/是否评级/);
  assert.equal(normaliseOptional({hasRating:'是',issuerRating:'AA+'}).issuerRating,'AA+');
});

test('switching modes isolates primary files and retains project evidence without relabelling it',()=>{
  const files=[{role:'historical',filename:'本企业.docx'},{role:'reference',filename:'同业.docx'},{role:'issuancePlan',filename:'发行方案.pdf'},{role:'industry',filename:'行业研究.pdf'}];
  const own=updateFilesForMode(files,'historical'),peer=updateFilesForMode(files,'reference');
  assert.deepEqual(own.map(f=>f.role),['historical','issuancePlan','industry']);assert.deepEqual(peer.map(f=>f.role),['reference','issuancePlan','industry']);assert.equal(files.length,4);
  assert.equal(validateUpdateFiles(own,'historical'),'');assert.equal(validateUpdateFiles(peer,'reference'),'');
  assert.match(validateUpdateFiles(files,'reference'),/用途不一致/);
  assert.match(validateUpdateFiles([files[1]],'reference'),/至少一份本项目资料/);
  assert.match(validateUpdateFiles(peer,''),/请选择/);
  assert.equal(validateUpdateFiles([{role:'reference',filename:'稿.pdf'},files[2]],'reference'),'');
  assert.match(validateUpdateFiles([{role:'historical',filename:'稿.pdf'}],'historical'),/DOCX/);
});

test('peer citations and unprovided sources cannot authorize draft prose or tables',()=>{
  const docs=[{id:'D01',role:'reference',records:[{locator:'P1',text:'同业总资产999亿元'}]},{id:'D02',role:'financial',records:[{locator:'L1',text:'本企业总资产120万元'}]}];
  const peer=[{documentId:'D01',locator:'P1',quote:'同业总资产999亿元'}],valid=[{documentId:'D02',locator:'L1',quote:'本企业总资产120万元'}];
  const result=validateDraftSection({paragraphs:[{text:'同业事实应剔除',evidence:peer},{text:'本企业总资产120万元',evidence:valid},{text:'无依据',evidence:[]}],tables:[{title:'合法表',columns:['项目','金额'],rows:[['总资产','120']],evidence:valid},{title:'歪列表',columns:['金额'],rows:[['120','999']],evidence:valid},{title:'参考表',columns:['金额'],rows:[['999']],evidence:peer}],gaps:[]},docs,'财务');
  assert.equal(result.paragraphs.length,1);assert.equal(result.tables.length,1);assert(result.gaps.length>=2);
  assert.equal(validateDraftSection({paragraphs:[{text:'不在本轮上下文',evidence:valid}],tables:[],gaps:[]},[],'财务').paragraphs.length,0);
});
