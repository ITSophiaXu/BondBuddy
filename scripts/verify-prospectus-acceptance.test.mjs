// All data here is SYNTHETIC validator input. No fixture represents real model
// execution, a human signature, or a passing release acceptance record.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ACCEPTANCE_POLICY,METRICS,SCOPES,REQUIRED_FINANCIAL_KEYS,REQUIRED_ROLE_IDS,STOCK_METRICS,FINANCIAL_POLICY,verifyProspectusAcceptance,validateBinding,validateChapterCoverage,
  equalRoundedAmount,equalRoundedRatio,validateFinancialChecks,validateHumanReviewer,validateMeasuredUsage,validateRealModelRecord,inspectAcceptanceArtifacts,validateFixedOccurrenceCoverage } from './verify-prospectus-acceptance.mjs';

const fileCatalogBytes=readFileSync(new URL('../deploy/m1/codex-file-authoring-model-catalog.json',import.meta.url));
const fileModels=JSON.parse(fileCatalogBytes).models;
test('file-authoring accepts only the deployed DeepSeek catalog and preserves official 0.167 capabilities',()=>{
  // openai/codex@cb41599ccbe371272892f156286a236aa097bada (0.167.0):
  // models-manager/src/model_info.rs::model_info_from_slug, models-manager/prompt.md,
  // and protocol/src/openai_models.rs::default_input_modalities. Only the existing
  // business 1M ceiling, compaction threshold and effective window override fallback.
  assert.deepEqual(fileModels.map(m=>m.slug),['deepseek-flash']);
  assert.deepEqual(fileCatalogBytes,readFileSync(new URL('../deploy/m1/codex-deepseek-model-catalog.json',import.meta.url)),
    'acceptance and the selected runtime catalog must describe the same model');
  const { model_messages, ...metadata }=fileModels[0];
  assert.deepEqual(metadata,{
    slug:'deepseek-flash',display_name:'deepseek-flash',description:null,
    default_reasoning_level:null,supported_reasoning_levels:[],shell_type:'unified_exec',
    visibility:'none',supported_in_api:true,priority:99,additional_speed_tiers:[],service_tiers:[],
    default_service_tier:null,available_access_programs:null,availability_nux:null,upgrade:null,
    include_skills_usage_instructions:false,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,
    supports_reasoning_summary_parameter:true,default_reasoning_summary:'auto',support_verbosity:false,
    default_verbosity:null,apply_patch_tool_type:null,web_search_tool_type:'text',
    truncation_policy:{mode:'bytes',limit:10000},supports_image_detail_original:false,
    context_window:1000000,max_context_window:1000000,auto_compact_token_limit:900000,
    comp_hash:null,effective_context_window_percent:100,experimental_supported_tools:[],input_modalities:['text','image'],
    supports_search_tool:false,supports_experimental_context:false,use_responses_lite:false,
    supports_reasoning_effort_updates:false,guardian:null,node_repl_auto_review_required:false,node_repl_disabled:false,
    auto_review_model_override:null,model_specialty:null,tool_mode:null,multi_agent_version:null,multi_agent_reasoning_effort:null,
  });
  const { instructions_template,...messages }=model_messages;
  assert.deepEqual(messages,{approvals:null,collaboration_modes:null,auto_review:null,permissions:null,multi_agent:null});
  assert.equal(Buffer.byteLength(instructions_template,'utf8'),20903);
  assert.equal(createHash('sha256').update(instructions_template).digest('hex'),
    'ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807');
});
test('current catalog model passes identity checks while retired, unrelated and missing models are rejected',()=>{
  // In-memory validator branch exercises only; these flags are deliberately
  // artificial input, never written as provider evidence or a release receipt.
  const expected={commit:'a'.repeat(40),tree:'b'.repeat(40),prompt_tools_sha256:'c'.repeat(64),
    run_id:'unit-run',input_hash:'d'.repeat(64),tracked_sha256:'e'.repeat(64),clean_sha256:'f'.repeat(64),
    reviewer_id:'reviewer@private.invalid',reviewed:Date.parse('2026-11-01T04:00:00Z'),models:fileModels.map(m=>m.slug)};
  const provider={...expected,synthetic:false,real_call:true,provider:'codex',request_id:'request-123',
    actor_id:'operator@private.invalid',model:'deepseek-flash',started_at:'2026-11-01T03:00:00Z',
    finished_at:'2026-11-01T03:01:00Z',usage:{status:'measured',input_tokens:2,output_tokens:1,total_tokens:3}};
  delete provider.models;
  validateRealModelRecord(provider,expected);
  for(const model of ['gpt-6-sol','gpt-6.1-sol','deepseek-chat','deepseek-flash-unregistered','',undefined])
    assert.throws(()=>validateRealModelRecord({...provider,model},expected),/PROVIDER_MODEL_MISMATCH/);
  assert.throws(()=>validateRealModelRecord({...provider,synthetic:true},expected),/PROVIDER_RUN_INVALID/);
  assert.throws(()=>validateRealModelRecord({...provider,commit:'0'.repeat(40)},expected),/SOURCE_BINDING_MISMATCH/);
  assert.throws(()=>validateRealModelRecord({...provider,usage:{status:'unknown'}},expected),/MEASURED_USAGE_REQUIRED/);
});

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
  assert.equal(equalRoundedAmount({value:'24952672.960000001',unit:'CNY'},{value:'2495.27',unit:'CNY_10K'},2),true);
  assert.equal(equalRoundedAmount({value:'8295896.5000001201',unit:'CNY'},{value:'829.59',unit:'CNY_10K'},2),true);
  for(const value of ['1e6','NaN','Infinity','1.'.padEnd(1025,'0')])
    assert.throws(()=>equalRoundedAmount({value,unit:'CNY'},{value:'100',unit:'CNY_10K'},2),/FINANCIAL_VALUE_INVALID/);
  assert.throws(()=>equalRoundedAmount({value:'1000000',unit:'CNY'},{value:'100.0000000',unit:'CNY_10K'},6),/FINANCIAL_VALUE_INVALID/);
});
function exactLocation(locator,quote,amount='100.00',scope='consolidated'){
  return {locator,quote,start:quote.indexOf(amount),end:quote.indexOf(amount)+amount.length,
    scope_anchor:{locator:'word/document.xml//w:p[1]',quote:scope==='consolidated'?'合并':'母公司'}};
}
function financialRows(){return REQUIRED_FINANCIAL_KEYS.map(key=>{const [scope,metric]=key.split(':');const binding=FINANCIAL_POLICY.metrics.find(r=>r.scope===scope&&r.metric===metric);
  const start=STOCK_METRICS.includes(metric)?'2025-09-30':'2025-01-01';
  const row={scope,metric,status:'passed',reviewer_id:'synthetic-reviewer',amount:'passed',unit:'passed',reporting_period:'passed',entity_scope:'passed',repeated_values:'passed',
    source:{file_id:'rq-202509-02',sha256:'a'.repeat(64),scope,start,end:'2025-09-30',locator:binding.locator,value:'1000000',unit:'CNY'},
    output:{scope,start,end:'2025-09-30',value:'100',unit:'CNY_10K',decimal_places:2,locators:[
      exactLocation('word/document.xml//w:p[2]','2025年9月末合并总资产100.00万元。','100.00',scope),
      exactLocation('word/document.xml//w:p[3]','2025年9月末合并总资产100.00万元。','100.00',scope)]},expected_occurrences:2};
  if(binding.derived==='ratio_percent'){
    row.source.denominator={...row.source,locator:binding.denominator.locator,value:'4000000'};
    row.output.value='25';row.output.unit='PERCENT';row.expected_occurrences=1;
    row.output.locators=[{...exactLocation('word/document.xml//w:p[4]',
      '2025年9月末合并应付债券占非流动负债比例25.00%。','25.00',scope),narrative_ratio:true}];
  }
  return row;
});}
test('financial review covers both scopes, correct quarter, converted amounts and every repeated value location',()=>{
  const materials=new Map([['rq-202509-02','a'.repeat(64)],['rq-202509-01','b'.repeat(64)]]);
  validateFinancialChecks(financialRows(),materials,'synthetic-reviewer');
  for(const mutate of [rows=>rows.pop(),rows=>rows[1]=rows[0],rows=>rows[0].source.end='2025-06-30',
    rows=>rows[0].output.scope='parent',rows=>rows[0].source.sha256='b'.repeat(64),rows=>rows[0].output.value='101',
    rows=>rows[0].output.locators.pop(),rows=>rows[0].output.locators[1]=rows[0].output.locators[0],
    rows=>rows[0].output.locators[0]='word/document.xml//w:p[2]',rows=>delete rows[0].output.locators[0].scope_anchor,
    rows=>rows[0].output.locators[0].scope_section_anchor={locator:'word/document.xml//w:p[1]',quote:'合并'},
    rows=>rows[0].output.locators[0].table_caption={locator:'word/document.xml//w:p[1]',quote:'合并'},
    rows=>rows[0].output.locators[0].narrative_list='true',
    rows=>rows[0].output.locators[0].reporting_period_definition={section_anchor:{locator:'word/document.xml//w:p[1]',quote:'释义'}},
    rows=>rows[0].output.locators[0].period_context={section_anchor:{locator:'word/document.xml//w:p[1]',quote:'管理层讨论与分析'}},
    rows=>rows[0].amount='pending',rows=>{rows[0].source.file_id='rq-202509-01';rows[0].source.sha256='b'.repeat(64);},
    rows=>{for(const r of rows){r.output.locators.pop();r.expected_occurrences=1;}}]){
    const rows=financialRows();mutate(rows);assert.throws(()=>validateFinancialChecks(rows,materials,'synthetic-reviewer'));
  }
});

test('operator occurrence counts cannot replace the independent fixed-case coverage result',()=>{
  const result={policy:'rq-202509-occurrences-v3',status:'passed',required_count:43,located_count:43,covered_count:43,
    covered_role_ids:[...REQUIRED_ROLE_IDS],failures:[]};
  validateFixedOccurrenceCoverage(result);
  for(const value of [undefined,{}, {...result,status:'failed'}, {...result,required_count:18},
    {...result,located_count:23}, {...result,covered_count:23}, {...result,covered_role_ids:result.covered_role_ids.slice(1)},
    {...result,covered_role_ids:result.covered_role_ids.map(()=>result.covered_role_ids[0])},
    {...result,policy:'rq-202509-occurrences-v1'}, {...result,required_count:27,located_count:27,covered_count:27},
    {...result,policy:'rq-202509-occurrences-v2'}, {...result,required_count:39,located_count:39,covered_count:39},
    {...result,covered_role_ids:result.covered_role_ids.map((id,i)=>i===0?'invented-role':id)},
    {...result,failures:[{code:'required_occurrence_not_independently_checked'}]}])
    assert.throws(()=>validateFixedOccurrenceCoverage(value),/FIXED_OCCURRENCE_COVERAGE_INCOMPLETE/);
});

test('new consolidated keys are mandatory without inventing parent attribution or expense claims',()=>{
  const materials=new Map([['rq-202509-02','a'.repeat(64)]]);
  assert.equal(REQUIRED_FINANCIAL_KEYS.length,21);
  for(const metric of ['deferred_income','sales_expenses','administrative_expenses','finance_expenses','investment_income','profit_attributable_to_parent']){
    assert.ok(REQUIRED_FINANCIAL_KEYS.includes(`consolidated:${metric}`));
    assert.ok(!REQUIRED_FINANCIAL_KEYS.includes(`parent:${metric}`));
    const missing=financialRows().filter(r=>r.metric!==metric);
    assert.throws(()=>validateFinancialChecks(missing,materials,'synthetic-reviewer'),/FINANCIAL_COVERAGE_INCOMPLETE/);
    const parent=financialRows(),row=parent.find(r=>r.metric===metric);row.scope=row.source.scope=row.output.scope='parent';
    assert.throws(()=>validateFinancialChecks(parent,materials,'synthetic-reviewer'),/FINANCIAL_COVERAGE_INCOMPLETE/);
    const period=financialRows(),wrong=period.find(r=>r.metric===metric);
    wrong.source.start=wrong.output.start=metric==='deferred_income'?'2025-01-01':'2025-09-30';
    assert.throws(()=>validateFinancialChecks(period,materials,'synthetic-reviewer'),/FINANCIAL_PERIOD_MISMATCH/);
  }
});

test('derived percentages use both exact source values and explicit rounding, never the output numerator',()=>{
  const ratio=(value,denominator)=>({value,unit:'CNY',denominator:{value:denominator,unit:'CNY'}});
  assert.equal(equalRoundedRatio(ratio('1','32'),{value:'3.13',unit:'PERCENT'},2),true);
  assert.equal(equalRoundedRatio(ratio('-1','32'),{value:'-3.13',unit:'PERCENT'},2),true);
  assert.equal(equalRoundedRatio({value:'1',unit:'CNY_10K',denominator:{value:'40000',unit:'CNY'}},{value:'25',unit:'PERCENT'},2),true);
  const actualSource=ratio('1486683178.1500001','5724561492.2299995');
  assert.equal(equalRoundedRatio(actualSource,{value:'25.97',unit:'PERCENT'},2),true);
  assert.equal(equalRoundedRatio(actualSource,{value:'26.82',unit:'PERCENT'},2),false);
  for(const invalid of ['0','-1'])assert.throws(()=>equalRoundedRatio(ratio('1',invalid),{value:'0',unit:'PERCENT'},2),/RATIO_DENOMINATOR_INVALID/);
  for(const invalid of ['1e6','NaN','Infinity'])assert.throws(()=>equalRoundedRatio(ratio('1',invalid),{value:'0',unit:'PERCENT'},2),/FINANCIAL_VALUE_INVALID/);
  assert.throws(()=>equalRoundedRatio(ratio('1','2'),{value:'50',unit:'CNY'},2),/FINANCIAL_UNIT_INVALID/);
});

test('bond amounts and ratio are mandatory; denominator identity, scope, cutoff and unit are independently bound',()=>{
  const materials=new Map([['rq-202509-02','a'.repeat(64)]]);
  const ratioMetric='bonds_payable_noncurrent_liabilities_ratio';
  for(const key of ['consolidated:bonds_payable','parent:bonds_payable',`consolidated:${ratioMetric}`]){
    assert.ok(REQUIRED_FINANCIAL_KEYS.includes(key));
    assert.throws(()=>validateFinancialChecks(financialRows().filter(r=>`${r.scope}:${r.metric}`!==key),materials,'synthetic-reviewer'),/FINANCIAL_COVERAGE_INCOMPLETE/);
  }
  for(const mutate of [
    row=>delete row.source.denominator,
    row=>row.source.denominator.locator='01合并资产负债表!D128',
    row=>row.source.denominator.file_id='rq-202509-01',
    row=>row.source.denominator.sha256='b'.repeat(64),
    row=>row.source.denominator.scope='parent',
    row=>row.source.denominator.start='2025-01-01',
    row=>row.source.denominator.end='2025-06-30',
    row=>row.source.denominator.unit='CNY_10K',
    row=>row.source.denominator.value='0',
    row=>row.source.denominator.value='5000000',
    row=>row.output.value='26.82',
    row=>row.output.decimal_places=3,
    row=>row.output.unit='CNY_10K',
    row=>delete row.output.locators[0].narrative_ratio,
    row=>row.output.locators[0].narrative_ratio='true',
    row=>row.output.locators[0].narrative_list=true,
    row=>delete row.output.locators[0].quote,
  ]){
    const rows=financialRows();mutate(rows.find(r=>r.metric===ratioMetric));
    assert.throws(()=>validateFinancialChecks(rows,materials,'synthetic-reviewer'));
  }
  const rows=financialRows();rows[0].source.denominator={...rows[0].source};
  assert.throws(()=>validateFinancialChecks(rows,materials,'synthetic-reviewer'),/FINANCIAL_SOURCE_MISMATCH/);
});
test('an arbitrary same-valued synthetic spreadsheet cannot establish an authorized financial source',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=mkdtempSync(join(tmpdir(),'bb-synthetic-source-rejection-'));
  try{
    const program=`from pathlib import Path
import sys
from docx import Document
from openpyxl import Workbook
from pypdf import PdfWriter
r=Path(sys.argv[1]);doc=Document();doc.add_paragraph('Synthetic source rejection fixture');doc.save(r/'synthetic.docx')
book=Workbook();book.active['A1']=1000000;book.save(r/'synthetic.xlsx')
w=PdfWriter();w.add_blank_page(width=595,height=842)
with open(r/'synthetic.pdf','wb') as stream:w.write(stream)
`;
    const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3';
    const built=spawnSync(python,['-B','-c',program,temp],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
    const financial={issuer:FINANCIAL_POLICY.issuer,financial_checks:[financialRows()[0]],materials:{'rq-202509-02':join(temp,'synthetic.xlsx')},clean:join(temp,'synthetic.docx')};
    const inspection=inspectAcceptanceArtifacts(root,join(temp,'synthetic.docx'),[join(temp,'synthetic.pdf')],financial);
    assert.deepEqual(inspection.financial_failures,[0]);assert.equal(inspection.fixed_occurrence_coverage.status,'failed');
  }finally{rmSync(temp,{recursive:true,force:true});}
});

for(const name of ['FinancialGeometry','FinancialLabels','NarrativeLists','AuthorizedTemplateLayout','FinancialSourceBindings']){
  test(`independent financial reader validates ${name} without changing a template`,()=>{
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
    const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3';
    const result=spawnSync(python,['-B','-s','scripts/prospectus_acceptance_inspect_test.py',name,'-v'],
      {cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python'),PYTHONIOENCODING:'utf-8'},encoding:'utf8'});
    assert.equal(result.status,0,`Independent reader checks cannot skip or fail:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr,/\bOK\s*$/);
    assert.doesNotMatch(result.stderr,/\bskipped\b/i);
  });
}
