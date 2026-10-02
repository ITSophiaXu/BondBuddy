import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { evidenceKey } from '../../../packages/domain/dist/review-evidence.js';
import { normalizeReviewFindings } from '../../../packages/domain/dist/review-finding-normalization.js';
import { chunkReviewRecords, normalizeModelReviewAnalysis, reviewModelStage, type ReviewAnalysisInput, type ReviewAnalysisRecord, type ReviewAnalysisResult, type ModelReviewAnalysis } from './review-model-stage.js';
import { createReviewContextSelector, promptReviewRecord, reviewPromptRecordId, reviewTableScope } from './review-record-context.js';
import type { StageContext } from './run-pipeline.js';

const python=process.env.BONDBUDDY_TEST_PYTHON??process.env.BB_PYTHON??'python3';
const pythonAvailable=spawnSync(python,['-c','import docx,lxml,openpyxl'],{encoding:'utf8',windowsHide:true}).status===0;
const nativeOptions={skip:pythonAvailable?false:'Set BONDBUDDY_TEST_PYTHON to Python with python-docx/lxml/openpyxl'};
const root=resolve(fileURLToPath(import.meta.url),'../../../..');
async function parseSynthetic(kind:'xlsx'|'docx'):Promise<ReviewAnalysisRecord[]>{
  const directory=await mkdtemp(resolve(tmpdir(),'bb-review-context-'));
  try{
    const path=resolve(directory,`synthetic.${kind}`);
    const script=kind==='xlsx'?`from openpyxl import Workbook
from zipfile import ZipFile,ZIP_DEFLATED
from lxml import etree
import sys
w=Workbook();w.remove(w.active)
for name,scope,year in [('旧年辅助','旧年合并',2020),('02合并利润表','合并',2025),('02母公司利润表','母公司',2024)]:
 s=w.create_sheet(name)
 if name=='旧年辅助': s.sheet_state='hidden'
 s.merge_cells('A1:E1');s['A1']=scope+'利润表'
 s['A2']='合成甲公司';s['B3']='编制单位：合成甲公司';s['E3']='单位：万元 CNY'
 s['D4']=str(year)+'年1-9月';s['E4']=str(year-1)+'年1-9月'
 for row in range(5,53):
  s.cell(row,1,'利息收入' if row==25 else '利息费用' if row==24 else '指标'+str(row))
  s.cell(row,2,row);s.cell(row,4,row*10);s.cell(row,5,row*5)
 s['D6']='=D7+D8'
w.save(sys.argv[1])
# Preserve a genuine OOXML cached formula value, without asserting its freshness.
with ZipFile(sys.argv[1]) as z: parts={n:z.read(n) for n in z.namelist()}
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
for name,data in list(parts.items()):
 if name.startswith('xl/worksheets/sheet') and name.endswith('.xml'):
  tree=etree.fromstring(data)
  for c in tree.xpath('//s:c[@r="D6"]/s:v',namespaces=ns): c.text='150'
  parts[name]=etree.tostring(tree)
with ZipFile(sys.argv[1],'w',ZIP_DEFLATED) as z:
 for name,data in parts.items(): z.writestr(name,data)
`:`from docx import Document
import sys
d=Document();d.add_paragraph('不属于任一表格的全局说明')
d.add_paragraph('合成甲公司 2025年1-9月 CNY 万元 合并')
for number in (1,2):
 t=d.add_table(rows=32,cols=3)
 t.cell(0,0).text='表'+str(number)+'指标';t.cell(0,1).text='2025年1-9月';t.cell(0,2).text='万元'
 for row in range(1,32):
  t.cell(row,0).text='表'+str(number)+'项目'+str(row)
  t.cell(row,1).text=str(row*10);t.cell(row,2).text=str(row*5)
t=d.add_table(rows=2,cols=1)
for outer in (0,1):
 n=t.cell(outer,0).add_table(rows=18,cols=2)
 n.cell(0,0).text='嵌套'+str(outer)+'表头';n.cell(0,1).text='2025年'
 for row in range(1,18):
  n.cell(row,0).text='嵌套'+str(outer)+'项目'+str(row);n.cell(row,1).text=str(row)
d.save(sys.argv[1])
`;
    const generated=spawnSync(python,['-B','-c',script,path],{encoding:'utf8',windowsHide:true});assert.equal(generated.status,0,generated.stderr);
    const sha=createHash('sha256').update(await readFile(path)).digest('hex');
    const media_type=kind==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const request={schema_version:'document-parse-request-v1',request_id:`synthetic-context-${kind}`,material:{material_id:'source',material_version:1,media_type,sha256:sha,authorized_local_path:path},options:{}};
    const parsed=spawnSync(python,['-B','-m','bondbuddy_document_parser'],{cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python'),PYTHONIOENCODING:'utf-8'},input:JSON.stringify(request),encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});assert.equal(parsed.status,0,parsed.stderr);
    const response=JSON.parse(parsed.stdout);assert.equal(response.schema_version,'document-parse-response-v1');const responseSha=inputManifestHash(response);
    return response.records.map((r:Record<string,unknown>)=>({owner_user_id:'owner',project_id:'project',material_id:'source',material_version:1,material_sha256:sha,parse_snapshot_id:'snapshot',parse_response_sha256:responseSha,record_id:r.record_id,record_sha256:inputManifestHash(r),locator_type:r.locator_type,locator:r.locator,literal_quote:r.literal_quote,extraction_method:r.extraction_method,uncertainty:r.uncertainty,formatting:r.formatting,context:r.context,source_kind:'disclosure'}));
  }finally{assert(directory.startsWith(resolve(tmpdir(),'bb-review-context-')));await rm(directory,{recursive:true,force:true});}
}
function fixture(records:ReviewAnalysisRecord[]){
  const source=records[0]!;
  const input:ReviewAnalysisInput={input_hash:'f'.repeat(64),evidence:{owner_user_id:source.owner_user_id,project_id:source.project_id,report_id:'context-report',source_material:{material_id:source.material_id,material_version:source.material_version,sha256:source.material_sha256},records,rules:[]},rule_context:null,rule_packs:[],formatting_requirements:[],requirements:[],scope:{mode:'full_review',finding_ids:[]},report_version:1,created_at:'2026-10-02T08:00:00Z',limitations:[]};
  const ctx={run:{id:'synthetic-context-run',owner_user_id:source.owner_user_id,project_id:source.project_id,input_revision:1,input_hash:input.input_hash},values:new Map(),checkpoint:{},signal:new AbortController().signal} as unknown as StageContext;
  return {input,ctx};
}
const empty=(ids:string[]):ModelReviewAnalysis=>({reviewed_record_ids:ids,observations:[],calculations:[],compliance_assessments:[],concerns:[],limitations:[]});
const cell=(records:ReviewAnalysisRecord[],sheet:string,address:string)=>records.find(r=>r.locator.sheet===sheet&&r.locator.cell===address)!;
const citation=(r:ReviewAnalysisRecord)=>({record_id:reviewPromptRecordId(r),quote:r.literal_quote});
function financialObservation(value:ReviewAnalysisRecord,headers:ReviewAnalysisRecord[]):ModelReviewAnalysis['observations'][number]{
  return {observation_id:'interest-income',source_record_id:reviewPromptRecordId(value),entity_id:'合成甲公司',metric:'利息收入',accounting_scope:'合并',basis:'未知',period:{start:'2025-01-01',end:'2025-09-30',as_of:null},currency:'CNY',unit:'万元',value:value.literal_quote,value_literal:value.literal_quote,value_refs:[citation(value)],context_refs:{entity:[citation(headers[0]!)],period:[citation(headers[1]!)],accounting_scope:[citation(headers[2]!)],currency:[citation(headers[3]!)],unit:[citation(headers[3]!)],basis:[]}};
}

test('native XLSX batches retain exact own-sheet headers, merged anchors and split row labels, without hidden/parent/old-parse leakage',nativeOptions,async()=>{
  const records=await parseSynthetic('xlsx'),sheet='02合并利润表';
  const d24=cell(records,sheet,'D24'),d25=cell(records,sheet,'D25');
  const maxRecords=Array.from({length:30},(_,i)=>i+7).find(size=>{const batches=chunkReviewRecords(records,64000,size);return batches.findIndex(b=>b.includes(d24))!==batches.findIndex(b=>b.includes(d25));})!;
  const batches=chunkReviewRecords(records,64000,maxRecords),batch=batches.find(b=>b.includes(d25))!;
  const old={...cell(records,sheet,'D4'),parse_snapshot_id:'old-snapshot',parse_response_sha256:'c'.repeat(64)};
  const selector=createReviewContextSelector([...records,old]);const selected=selector(batch);const accessible=[...batch,...selected.records];
  assert(!batch.includes(cell(records,sheet,'D4')));assert.equal(selected.gaps.length,0);
  for(const anchor of ['A1','B3','E3','D4','A25'])assert(accessible.includes(cell(records,sheet,anchor)),anchor);
  assert(selected.records.every(r=>r.locator.sheet===sheet));assert(!selected.records.includes(old));assert(!accessible.some(r=>r.locator.cell==='B1'),'merged placeholders must not be invented');
  assert.equal(cell(records,sheet,'A1').locator.merged_range,'A1:E1');
  const formula=cell(records,sheet,'D6');assert.equal(promptReviewRecord(formula).literal_quote,'=D7+D8');assert.deepEqual(promptReviewRecord(formula).uncertainty,['formula_cached_result_unverified']);
  assert.equal(promptReviewRecord(cell(records,'旧年辅助','D6')).sheet_state,'hidden');
  const headers=['B3','D4','A1','E3'].map(address=>cell(records,sheet,address));const {input,ctx}=fixture(records);
  const raw=empty(batch.map(reviewPromptRecordId));raw.observations=[financialObservation(d25,headers)];
  const normalized=normalizeModelReviewAnalysis(input,raw,new Set(accessible.map(reviewPromptRecordId)));
  assert.equal(evidenceKey(normalized.financial.observations[0]!.context_refs.period[0]!),evidenceKey(headers[1]!));assert.equal(normalized.financial.observations[0]?.context_verification,'unverified');
  for(const foreign of [cell(records,'旧年辅助','D4'),cell(records,'02母公司利润表','D4'),old]){
    const mixed=structuredClone(raw);mixed.observations[0]!.context_refs.period=[citation(foreign)];
    assert.throws(()=>normalizeModelReviewAnalysis({...input,evidence:{...input.evidence,records:[...records,old]}},mixed),/mixed_table_context/);
  }
  let crossBatchChecked=false;
  const run=await reviewModelStage({loadInput:async()=>input,maxBatchRecords:maxRecords,model:options=>({name:options.name,run:async c=>{
    const data=JSON.parse((await options.buildPrompt(c)).split('输入数据：\n')[1]!);const output=empty(data.records.map((r:{id:string})=>r.id));
    if(data.records.some((r:{id:string})=>r.id===reviewPromptRecordId(d25))){
      crossBatchChecked=true;output.observations=[financialObservation(d25,headers)];assert(options.validate(output));
      assert(data.context_records.some((r:{id:string})=>r.id===reviewPromptRecordId(headers[1]!)));
      const repeated=structuredClone(output);repeated.observations=[financialObservation(headers[1]!,headers)];assert.equal(options.validate(repeated),false,'context cannot become a fresh extraction source');
    }
    return {kind:'done',value:output};
  }})}).run(ctx);
  assert.equal(run.kind,'done');assert(crossBatchChecked);
  if(run.kind!=='done')return;
  const report=(run.value as ReviewAnalysisResult).report;assert(!report.coverage.some(c=>c.check_id.includes('context-capacity')));
  const sourceRef=normalized.financial.observations[0]!.value_refs[0]!;
  const prior=normalizeReviewFindings([{stable_key:'selected-interest',dimension:'financial',conclusion:'manual',severity:'P2',title:'合成所选事项',description:'只复核D25',target_refs:[sourceRef],evidence_refs:[sourceRef]}],{...input.evidence,report_id:'previous-context-report'})[0]!;
  input.previous_report={...report,report_id:'previous-context-report',run_id:'previous-run',findings:[prior],coverage:[]};input.scope={mode:'differential_review',finding_ids:[prior.finding_id]};
  let scopedCalls=0;
  const differential=await reviewModelStage({loadInput:async()=>input,model:options=>({name:options.name,run:async c=>{
    scopedCalls++;const data=JSON.parse((await options.buildPrompt(c)).split('输入数据：\n')[1]!);assert.deepEqual(data.records.map((r:{id:string})=>r.id),[reviewPromptRecordId(d25)]);
    const label=cell(records,sheet,'A25');assert(data.context_records.some((r:{id:string})=>r.id===reviewPromptRecordId(label)));
    const output=empty([reviewPromptRecordId(d25)]);const widened=structuredClone(output);
    widened.concerns=[{stable_key:'outside',dimension:'financial',conclusion:'manual',severity:'P2',title:'Unselected context',description:'Cannot expand selected scope',target_refs:[citation(label)],evidence_refs:[],rule_keys:[],suggested_change:null,limitations:[]}];
    assert.equal(options.validate(widened),false);return {kind:'done',value:output};
  }})}).run(ctx);
  assert.equal(differential.kind,'done');assert.equal(scopedCalls,1);
});

test('native DOCX multi-batch tables and nested table:1 scopes cannot borrow foreign headers or global prose',nativeOptions,async()=>{
  const records=await parseSynthetic('docx'),selector=createReviewContextSelector(records);
  const tables=new Map<string,ReviewAnalysisRecord[]>();for(const r of records){const scope=reviewTableScope(r);if(scope){const group=tables.get(scope.key)??[];group.push(r);tables.set(scope.key,group);}}
  assert.equal(tables.size,4);assert(chunkReviewRecords(records,64000,11).length>10);
  for(const [key,own] of tables){
    const target=own.at(-1)!,selected=selector([target]);assert(selected.records.includes(own[0]!));
    assert(selected.records.every(r=>reviewTableScope(r)?.key===key));assert(!selected.records.some(r=>r.literal_quote.includes('全局说明')));
    assert(selected.groups.every(g=>g.selection==='structural_candidates_only'));assert.equal(selected.gaps.length,0);
  }
  const target=[...tables.values()][0]!.at(-1)!,preamble=records.find(r=>r.literal_quote.startsWith('合成甲公司'))!;
  const {input}=fixture(records);const raw=empty([reviewPromptRecordId(target),reviewPromptRecordId(preamble)]);
  raw.observations=[financialObservation(target,[preamble,preamble,preamble,preamble])];
  const unbound=normalizeModelReviewAnalysis(input,raw,new Set(raw.reviewed_record_ids)).financial.observations[0]!;
  assert.equal(unbound.context_verification,'unverified');assert(unbound.context_limitations?.includes('financial_table_context_unbound'));
  const oldPreamble={...preamble,parse_snapshot_id:'old-docx-snapshot',parse_response_sha256:'d'.repeat(64)};
  raw.observations[0]!.context_refs.entity=[citation(oldPreamble)];
  assert.throws(()=>normalizeModelReviewAnalysis({...input,evidence:{...input.evidence,records:[...records,oldPreamble]}},raw),/mixed_table_context/);
});

test('context byte/count overflow is explicit in prompt and persisted uncovered coverage, not silent truncation',nativeOptions,async()=>{
  const records=await parseSynthetic('xlsx'),sheet='02合并利润表',target=cell(records,sheet,'D25'),selector=createReviewContextSelector(records);
  for(const limits of [{maxBytes:0},{maxRecords:0},{maxBytes:900,maxRecords:1}]){
    const selected=selector([target],limits);assert(selected.gaps[0]!.omitted_record_count>0);assert.equal(selected.groups[0]?.omitted_record_count,selected.gaps[0]?.omitted_record_count);
    assert(Buffer.byteLength(selected.records.map(r=>JSON.stringify(promptReviewRecord(r))).join(''))<=(limits.maxBytes??64000));
  }
  const {input,ctx}=fixture(records);let explicitGaps=0;
  const result=await reviewModelStage({loadInput:async()=>input,maxBatchRecords:40,maxContextRecords:0,model:options=>({name:options.name,run:async c=>{
    const data=JSON.parse((await options.buildPrompt(c)).split('输入数据：\n')[1]!);explicitGaps+=data.context_groups.filter((g:{omitted_record_count:number})=>g.omitted_record_count>0).length;
    return {kind:'done',value:empty(data.records.map((r:{id:string})=>r.id))};
  }})}).run(ctx);
  assert.equal(result.kind,'done');if(result.kind!=='done')return;const report=(result.value as ReviewAnalysisResult).report;
  const gaps=report.coverage.filter(c=>c.check_id.includes('context-capacity'));assert.equal(gaps.length,explicitGaps);assert(gaps.length>0);assert(gaps.every(c=>c.outcome==='uncovered'&&c.evidence_refs.length));assert(report.limitations.some(x=>x.includes('上下文容量缺口')));
});

test('a complete statement in a hidden worksheet remains unverified even with literal context proof',()=>{
  const quote='合成甲公司 合并 原始报表 2025-01-01至2025-09-30 CNY 万元 利息收入100.00。';
  const record:ReviewAnalysisRecord={owner_user_id:'owner',project_id:'project',material_id:'source',material_version:1,material_sha256:'a'.repeat(64),parse_snapshot_id:'snapshot',parse_response_sha256:'b'.repeat(64),record_id:'r1',record_sha256:'c'.repeat(64),locator_type:'xlsx_cell',locator:{sheet:'辅助',cell:'A1'},literal_quote:quote,extraction_method:'native_text',uncertainty:[],formatting:{sheet_state:'hidden'},source_kind:'disclosure'};
  const {input}=fixture([record]);const o=financialObservation(record,[record,record,record,record]);o.basis='原始报表';o.value='100.00';o.value_literal='100.00';o.context_refs.basis=[citation(record)];
  const raw=empty([reviewPromptRecordId(record)]);raw.observations=[o];
  assert.equal(normalizeModelReviewAnalysis(input,raw).financial.observations[0]?.context_verification,'unverified');
  assert(normalizeModelReviewAnalysis(input,raw).financial.observations[0]?.context_limitations?.includes('financial_worksheet_visibility_unconfirmed'));
  record.formatting={sheet_state:'visible'};assert.equal(normalizeModelReviewAnalysis(input,raw).financial.observations[0]?.context_verification,'literal_statement');
});
