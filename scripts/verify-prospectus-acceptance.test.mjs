// All data here is SYNTHETIC validator input. No fixture represents real model
// execution, a human signature, or a passing release acceptance record.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ACCEPTANCE_POLICY,METRICS,SCOPES,verifyProspectusAcceptance,validateBinding,validateChapterCoverage,
  equalRoundedAmount,validateFinancialChecks,validateHumanReviewer,validateMeasuredUsage,validateRealModelRecord,inspectAcceptanceArtifacts } from './verify-prospectus-acceptance.mjs';

test('release acceptance fails when its private evidence file is missing',async()=>{
  await assert.rejects(verifyProspectusAcceptance({file:''}),/FILE_REQUIRED/);
  await assert.rejects(verifyProspectusAcceptance({file:join(tmpdir(),'absent-bb-acceptance-evidence.json')}),/FILE_UNAVAILABLE/);
});
test('synthetic, pending, status-only and malformed documents never become real acceptance',async()=>{
  const root=mkdtempSync(join(tmpdir(),'bb-synthetic-acceptance-negative-'));
  try{
    const file=join(root,'synthetic-negative.json');
    for(const value of [null,{status:'passed'},{schema_version:ACCEPTANCE_POLICY,status:'passed',synthetic:true},
      {schema_version:ACCEPTANCE_POLICY,status:'pending',synthetic:false}]){
      writeFileSync(file,JSON.stringify(value));
      await assert.rejects(verifyProspectusAcceptance({file}),/REAL_ACCEPTANCE_REQUIRED/);
    }
    writeFileSync(file,'{malformed');await assert.rejects(verifyProspectusAcceptance({file}),/JSON_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('source commit, complete tree, and prompt/tool fingerprint must each match',()=>{
  const expected={commit:'a'.repeat(40),tree:'b'.repeat(40),prompt_tools_sha256:'c'.repeat(64)};
  for(const field of Object.keys(expected))assert.throws(()=>validateBinding({...expected,[field]:'d'.repeat(64)},expected),/SOURCE_BINDING_MISMATCH/);
});
const now=Date.parse('2026-11-01T04:00:00Z');
test('model self-signing, unverified reviewer flags and missing or stale dates are rejected',()=>{
  for(const reviewer of [{actor_type:'model'},{actor_type:'human',id:'codex',name:'Codex',independent_from_model:true,generated_by_model:false},
    {actor_type:'human',id:'synthetic-reviewer',name:'Synthetic fixture',independent_from_model:true,generated_by_model:false},
    {actor_type:'human',id:'person@private.invalid',name:'Person',independent_from_model:false,generated_by_model:false}])
    assert.throws(()=>validateHumanReviewer(reviewer,now),/HUMAN_REVIEW_REQUIRED/);
  for(const reviewed_at of [undefined,'invalid','2020-01-01T00:00:00Z','2099-01-01T00:00:00Z'])
    assert.throws(()=>validateHumanReviewer({actor_type:'human',id:'person@private.invalid',name:'Person',independent_from_model:true,
      generated_by_model:false,reviewed_at},now));
});
test('unknown, zero, fractional, fabricated-total and missing provider usage cannot pass',()=>{
  for(const usage of [null,{status:'unknown',input_tokens:2,output_tokens:1,total_tokens:3},{status:'measured',input_tokens:0,output_tokens:1,total_tokens:1},
    {status:'measured',input_tokens:2.5,output_tokens:1,total_tokens:3.5},{status:'measured',input_tokens:2,output_tokens:1,total_tokens:4}])
    assert.throws(()=>validateMeasuredUsage(usage),/MEASURED_USAGE_REQUIRED/);
});
test('a synthetic provider flag cannot be promoted by matching source bindings',()=>{
  const binding={commit:'a'.repeat(40),tree:'b'.repeat(40),prompt_tools_sha256:'c'.repeat(64)};
  assert.throws(()=>validateRealModelRecord({...binding,synthetic:true,real_call:true},binding),/PROVIDER_RUN_INVALID/);
});
function chapterRows(){return ['preamble','chapter-1','chapter-2'].map(chapter_id=>({chapter_id,reviewer_id:'synthetic-reviewer',status:'passed',
  disposition:'updated',content_retention:'passed',tables:'passed',required_updates:'passed',note:'Synthetic validator exercise only.',output_locators:['word/document.xml//w:p[1]']}));}
test('all independently extracted source chapters require individual review, with no omission or duplication',()=>{
  const ids=['preamble','chapter-1','chapter-2'];
  validateChapterCoverage(chapterRows(),ids,'synthetic-reviewer');
  for(const mutate of [rows=>rows.pop(),rows=>rows[1]=rows[0],rows=>rows[1].required_updates='pending',
    rows=>rows[1].content_retention='failed',rows=>rows[1].output_locators=[],rows=>rows[1].reviewer_id='model']){
    const rows=chapterRows();mutate(rows);assert.throws(()=>validateChapterCoverage(rows,ids,'synthetic-reviewer'));
  }
});
test('amount checks perform exact unit conversion and explicit half-away-from-zero rounding',()=>{
  assert.equal(equalRoundedAmount({value:'123456789',unit:'CNY'},{value:'12345.68',unit:'CNY_10K'},2),true);
  assert.equal(equalRoundedAmount({value:'-125',unit:'CNY'},{value:'-0.01',unit:'CNY_10K'},2),true);
  assert.equal(equalRoundedAmount({value:'100',unit:'CNY_10K'},{value:'100',unit:'CNY'},2),false);
  assert.equal(equalRoundedAmount({value:'12.345',unit:'CNY'},{value:'12.35',unit:'CNY'},2),true);
  assert.throws(()=>equalRoundedAmount({value:'1,000',unit:'CNY'},{value:'1000',unit:'CNY'},2),/FINANCIAL_VALUE_INVALID/);
  assert.throws(()=>equalRoundedAmount({value:'1',unit:'unknown'},{value:'1',unit:'CNY'},2),/FINANCIAL_UNIT_INVALID/);
});
function financialRows(){return SCOPES.flatMap(scope=>METRICS.map(metric=>{
  const start=['total_assets','total_liabilities','net_assets'].includes(metric)?'2025-09-30':'2025-01-01';
  return {scope,metric,status:'passed',reviewer_id:'synthetic-reviewer',amount:'passed',unit:'passed',reporting_period:'passed',entity_scope:'passed',repeated_values:'passed',
    source:{file_id:'rq-202509-02',sha256:'a'.repeat(64),scope,start,end:'2025-09-30',locator:'SYNTHETIC!A1',value:'1000000',unit:'CNY'},
    output:{scope,start,end:'2025-09-30',value:'100',unit:'CNY_10K',decimal_places:2,locators:['word/document.xml//w:p[1]','word/document.xml//w:p[2]']},expected_occurrences:2};
}));}
test('financial review covers both scopes, correct quarter, converted amounts and every repeated value location',()=>{
  const materials=new Map([['rq-202509-02','a'.repeat(64)],['rq-202509-01','b'.repeat(64)]]);
  validateFinancialChecks(financialRows(),materials,'synthetic-reviewer');
  for(const mutate of [rows=>rows.pop(),rows=>rows[1]=rows[0],rows=>rows[0].source.end='2025-06-30',
    rows=>rows[0].output.scope='parent',rows=>rows[0].source.sha256='b'.repeat(64),rows=>rows[0].output.value='101',
    rows=>rows[0].output.locators.pop(),rows=>rows[0].output.locators[1]=rows[0].output.locators[0],
    rows=>rows[0].amount='pending',rows=>{rows[0].source.file_id='rq-202509-01';rows[0].source.sha256='b'.repeat(64);},
    rows=>{for(const r of rows){r.output.locators.pop();r.expected_occurrences=1;}}]){
    const rows=financialRows();mutate(rows);assert.throws(()=>validateFinancialChecks(rows,materials,'synthetic-reviewer'));
  }
});
test('independent reader rejects invented source cells, wrong source amounts and nonexistent or wrong output positions',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=mkdtempSync(join(tmpdir(),'bb-synthetic-financial-validator-'));
  try{
    const program=`from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pypdf import PdfWriter
import sys
r=Path(sys.argv[1]);doc=Document();doc.add_heading('第一章 Synthetic validator only',1)
doc.add_paragraph('Synthetic amount 100.00.');doc.add_paragraph('Repeated synthetic amount 100.00.')
doc.save(r/'synthetic.docx');book=Workbook();book.active.title='SYNTHETIC';book.active['A1']=1000000;book.save(r/'synthetic.xlsx')
writer=PdfWriter();writer.add_blank_page(width=595,height=842)
with open(r/'synthetic.pdf','wb') as stream:writer.write(stream)
`;
    const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3';
    const result=spawnSync(python,['-B','-c',program,temp],{encoding:'utf8'});
    assert.equal(result.status,0,'Python fixture builder must be available; no integration skip is allowed');
    const row=financialRows()[0],financial={financial_checks:[row],materials:{'rq-202509-02':join(temp,'synthetic.xlsx')},clean:join(temp,'synthetic.docx')};
    const run=()=>inspectAcceptanceArtifacts(root,join(temp,'synthetic.docx'),[join(temp,'synthetic.pdf')],financial);
    row.output.locators=['word/document.xml//w:p[2]','word/document.xml//w:p[3]'];
    assert.deepEqual(run().financial_failures,[]);
    row.source.locator='SYNTHETIC!A2';assert.deepEqual(run().financial_failures,[0]);
    row.source.locator='SYNTHETIC!A1';row.source.value='999';assert.deepEqual(run().financial_failures,[0]);
    row.source.value='1000000';row.output.locators=['word/document.xml//w:p[99]'];assert.deepEqual(run().financial_failures,[0]);
    row.output.locators=['word/document.xml//w:p[1]'];assert.deepEqual(run().financial_failures,[0]);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
