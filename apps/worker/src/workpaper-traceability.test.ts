import test from 'node:test';
import assert from 'node:assert/strict';
import {workpaperFilenameTitle,defaultWorkpaperIds,type ProjectFileText,type ProjectFileLink} from '@bondbuddy/contracts';
import {workpaperImpact} from './workpaper-changes.js';
import {validateWorkpaperCoverage} from './workpaper-content.js';
import {assessmentEvidence,groundWorkpaperDecision} from './workpaper-assessment-stage.js';
const snapshot=(texts:string[],locations?:string[]):ProjectFileText=>({version:'project-file-text-v1',format:'docx',sha256:'a'.repeat(64),coverage:'complete',warnings:[],spans:texts.map((text,i)=>({id:'p'+i,text,location:locations?.[i]??'段落 '+i,sha256:'b'.repeat(64)}))});
const link=(id:string):ProjectFileLink=>({source_span_id:id,source_quote:'100',target_span_id:'p1',target_quote:'100',source_location:'表格 1 / 行 1 / 列 1',target_location:'表格 2 / 行 3 / 列 2',field:'总资产',period:'2025年末',unit:'万元',source_sha256:'a'.repeat(64),target_sha256:'c'.repeat(64)});
test('filename parentheses, nesting, business alternatives and legal names',()=>{
  assert.equal(workpaperFilenameTitle('资产变动（增加或减少超过30%）明细（如有）'),'资产变动明细');
  assert.equal(workpaperFilenameTitle('有关文件(如有(含增资))及说明'),'有关文件及说明');
  assert.equal(workpaperFilenameTitle('批准（备案）文件'),'批准或备案文件');
  assert.equal(workpaperFilenameTitle('甲（中国）有限公司说明（签字日期）'),'甲（中国）有限公司说明');
  assert.equal(workpaperFilenameTitle('甲（含企业债券）文件'),'甲文件');
  const entries=[{id:'one',sheet:'1 尽职调查文件',kind:'file',code:'1-0',title:'核查记录'},{id:'two',sheet:'2 发行阶段文件',kind:'file',code:'2-1',title:'发行文件'}];
  assert.deepEqual(defaultWorkpaperIds(entries),['one']);
});
test('full assessment evidence retains tail rows and partial facts can generate',()=>{
  const source=snapshot(Array.from({length:4000},(_,i)=>'明细企业'+i+'总资产123456.78万元'));
  assert.equal(assessmentEvidence([],source).length,4000);assert.equal(assessmentEvidence([],source).at(-1)?.text,source.spans.at(-1)?.text);
  const decision=groundWorkpaperDecision({item_id:'a',status:'generate',reason:'可形成资产分析，外部证照另行取得。',missing_materials:['原始证照'],citations:[{span_id:'p0',quote:source.spans[0]!.text}]},{id:'a',title:'资产分析'} as any,source.spans);
  assert.equal(decision.status,'generate');
});
test('mapped edits identify file location, additions/unmapped legacy never report current',()=>{
  const source=snapshot(['资产100万元']),current=snapshot(['资产200万元']);
  const item={id:'a',links:[link('p0')],explanation:false,available:true};
  const diff=[{before_ids:['p0'],after_ids:['p0'],before:'资产100万元',after:'资产200万元',location:'表格1'}];
  const result=workpaperImpact(item,source,current,diff);assert.equal(result.status,'needs_update');assert.deepEqual(result.changes[0]?.target_locations,['表格 2 / 行 3 / 列 2']);
  assert.equal(workpaperImpact({...item,links:[]},source,current,diff).status,'manual');
  assert.equal(workpaperImpact(item,source,current,[{before_ids:[],after_ids:['p1'],before:'',after:'新增担保',location:'担保'}]).status,'manual');
  assert.equal(workpaperImpact(item,source,{...current,coverage:'partial'},[]).status,'manual');
  assert.equal(workpaperImpact(item,source,source,[]).status,'current');
});
test('full table coverage and nonempty output are enforced',()=>{
  const source=snapshot(['2025年末资产','100万元','200万元'],['表格 1 / 行 1 / 列 1','表格 1 / 行 2 / 列 1','表格 1 / 行 3 / 列 1']);
  const target=snapshot(['资产分析。'.repeat(30),'100万元','200万元'],['表格 1 / 行 1 / 列 1','表格 1 / 行 2 / 列 1','表格 1 / 行 3 / 列 1']);
  const links=source.spans.map(s=>({...link(s.id),target_span_id:s.id}));
  const coverage={reviewed_span_ids:['p0','p1','p2'],used_span_ids:['p0','p1','p2'],excluded:[]};
  assert.equal(validateWorkpaperCoverage(source,target,links,coverage).used,3);
  assert.throws(()=>validateWorkpaperCoverage(source,target,source.spans.map(s=>link(s.id)),coverage),/TABLE_OUTPUT_INCOMPLETE/);
  assert.throws(()=>validateWorkpaperCoverage(source,target,[link('p0'),link('p1')],{...coverage,used_span_ids:['p0','p1'],excluded:[{span_id:'p2',reason:'不应遗漏的相关数据'}]}),/TABLE_INCOMPLETE/);
  assert.throws(()=>validateWorkpaperCoverage(source,{...target,spans:target.spans.map(s=>({...s,text:'[[内容1]]'}))},links,coverage),/EMPTY_OR_INTERNAL/);
  assert.throws(()=>validateWorkpaperCoverage(source,target,[],coverage),/LINKS_MISSING/);
});
