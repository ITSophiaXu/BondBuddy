#!/usr/bin/env node
/** Validate privately supplied acceptance evidence. The controlled publisher is the
 * trust boundary: this checks artifacts and review records, not human identities
 * or provider signatures. It never creates or approves acceptance evidence. */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_POLICY='prospectus-acceptance-v1';
export const METRICS=Object.freeze(['total_assets','total_liabilities','net_assets','net_profit','operating_cash_flow']);
export const SCOPES=Object.freeze(['consolidated','parent']);
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const HEX=/^[a-f0-9]{64}$/;
const TOOL_FILES=Object.freeze([
  'apps/worker/src/codex-adapter.ts','apps/worker/src/file-authoring-stage.ts','apps/worker/src/file-authoring-quality.ts',
  'apps/worker/src/unified-input.ts','deploy/m1/codex-file-authoring-model-catalog.json',
  'python/bondbuddy_file_authoring/task.md','python/bondbuddy_file_authoring/fixed-edit.md',
  'python/bondbuddy_file_authoring/fixed_edit.py','python/bondbuddy_file_authoring/check.py',
  'python/bondbuddy_file_authoring/quality.py','python/bondbuddy_file_authoring/source_outline.py',
  'python/bondbuddy_file_authoring/format_diff.py','python/bondbuddy_file_authoring/template_manifest.py',
  'python/bondbuddy_file_authoring/word_patch.py','python/bondbuddy_file_authoring/read_material.py']);
const fail=code=>{throw new Error(`PROSPECTUS_ACCEPTANCE_${code}`);};
const ensure=(value,code)=>{if(!value)fail(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const text=value=>typeof value==='string' && value.trim().length>0 && value.length<=1000;
const realId=value=>text(value) && !/synthetic|fixture|fake|mock|example|sample|model[-_ ]?reviewer/i.test(value);
function timestamp(value){ensure(typeof value==='string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)),'DATE_INVALID');return Date.parse(value);}
export function validateHumanReviewer(reviewer,now=Date.now()){
  ensure(reviewer?.actor_type==='human'&&realId(reviewer.id)&&text(reviewer.name)&&reviewer.independent_from_model===true
    &&reviewer.generated_by_model===false&&!/codex|gpt[-_ ]?\d|deepseek|assistant|模型|机器人/i.test(`${reviewer.id} ${reviewer.name}`),'HUMAN_REVIEW_REQUIRED');
  const reviewed=timestamp(reviewer.reviewed_at);
  ensure(reviewed<=now+60000&&now-reviewed<=7*86400000,'REVIEW_DATE_INVALID');
  return reviewed;
}
export function validateMeasuredUsage(usage){
  ensure(usage?.status==='measured'&&Number.isSafeInteger(usage.input_tokens)&&usage.input_tokens>0&&Number.isSafeInteger(usage.output_tokens)
    &&usage.output_tokens>0&&Number.isSafeInteger(usage.total_tokens)&&usage.total_tokens===usage.input_tokens+usage.output_tokens,'MEASURED_USAGE_REQUIRED');
}
export function validateRealModelRecord(provider,expected){
  validateBinding(provider,expected);
  ensure(provider.synthetic===false&&provider.real_call===true&&provider.provider==='codex'&&realId(provider.request_id)
    &&realId(provider.actor_id)&&provider.run_id===expected.run_id&&provider.input_hash===expected.input_hash
    &&provider.tracked_sha256===expected.tracked_sha256&&provider.clean_sha256===expected.clean_sha256
    &&provider.actor_id!==expected.reviewer_id,'PROVIDER_RUN_INVALID');
  ensure(expected.models.includes(provider.model),'PROVIDER_MODEL_MISMATCH');
  validateMeasuredUsage(provider.usage);
  ensure(timestamp(provider.started_at)<=timestamp(provider.finished_at)&&timestamp(provider.finished_at)<=expected.reviewed,'REVIEW_DATE_INVALID');
}
function git(root,args){const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});ensure(!result.error&&result.status===0,'GIT_UNAVAILABLE');return result.stdout.trim();}
export function pipelineFingerprint(root=repo){
  return hash(TOOL_FILES.map(name=>`${name}\0${hash(readFileSync(resolve(root,name)))}\n`).join(''));
}
export function validateBinding(value,expected){
  ensure(value?.commit===expected.commit && value.tree===expected.tree && value.prompt_tools_sha256===expected.prompt_tools_sha256,'SOURCE_BINDING_MISMATCH');
}
function artifact(ref,base,max=100*1024*1024){
  ensure(ref && text(ref.path) && HEX.test(ref.sha256??''),'ARTIFACT_REF_INVALID');
  const path=resolve(base,ref.path);
  let bytes;
  try{
    const stat=lstatSync(path);
    ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0&&stat.size<=max&&realpathSync(path)===path,'ARTIFACT_FILE_INVALID');
    bytes=readFileSync(path);
  }catch{fail('ARTIFACT_FILE_UNAVAILABLE');}
  ensure(hash(bytes)===ref.sha256,'ARTIFACT_HASH_MISMATCH');
  return {path,bytes,sha256:ref.sha256};
}
function jsonFile(value){try{return JSON.parse(value.bytes.toString('utf8'));}catch{fail('ARTIFACT_JSON_INVALID');}}
export function validateChapterCoverage(rows,chapterIds,reviewerId){
  ensure(Array.isArray(rows)&&rows.length===chapterIds.length&&new Set(chapterIds).size===chapterIds.length,'CHAPTER_COVERAGE_INCOMPLETE');
  const seen=new Set();
  for(const row of rows){
    ensure(row&&chapterIds.includes(row.chapter_id)&&!seen.has(row.chapter_id),'CHAPTER_COVERAGE_INCOMPLETE');seen.add(row.chapter_id);
    ensure(row.reviewer_id===reviewerId&&row.status==='passed'&&['updated','retained'].includes(row.disposition)
      && row.content_retention==='passed'&&row.tables==='passed'&&row.required_updates==='passed'
      && text(row.note)&&Array.isArray(row.output_locators)&&row.output_locators.length>0&&row.output_locators.every(text),'CHAPTER_REVIEW_INCOMPLETE');
  }
}
function decimal(value){
  ensure(typeof value==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value),'FINANCIAL_VALUE_INVALID');
  const negative=value.startsWith('-'),plain=negative?value.slice(1):value,[whole,fraction='']=plain.split('.');
  return {n:BigInt(whole+fraction)*(negative?-1n:1n),d:10n**BigInt(fraction.length)};
}
const units={CNY:1n,CNY_10K:10000n,CNY_100M:100000000n};
export function equalRoundedAmount(source,output,places){
  ensure(Number.isSafeInteger(places)&&places>=0&&places<=6&&Object.hasOwn(units,source.unit)&&Object.hasOwn(units,output.unit),'FINANCIAL_UNIT_INVALID');
  const a=decimal(source.value),b=decimal(output.value),scale=10n**BigInt(places);
  const numerator=a.n*units[source.unit]*scale,denominator=a.d*units[output.unit];
  const magnitude=numerator<0n?-numerator:numerator;
  const rounded=(magnitude/denominator+(magnitude%denominator*2n>=denominator?1n:0n))*(numerator<0n?-1n:1n);
  return rounded*b.d===b.n*scale;
}
export function validateFinancialChecks(rows,materials,reviewerId){
  ensure(Array.isArray(rows)&&rows.length>=METRICS.length*SCOPES.length,'FINANCIAL_COVERAGE_INCOMPLETE');
  const keys=new Set();let repeated=0;
  for(const row of rows){
    const key=`${row?.scope}:${row?.metric}`;
    ensure(row&&METRICS.includes(row.metric)&&SCOPES.includes(row.scope)&&!keys.has(key),'FINANCIAL_COVERAGE_INCOMPLETE');keys.add(key);
    ensure(row.status==='passed'&&row.reviewer_id===reviewerId&&row.amount==='passed'&&row.unit==='passed'
      && row.reporting_period==='passed'&&row.entity_scope==='passed'&&row.repeated_values==='passed','FINANCIAL_REVIEW_INCOMPLETE');
    ensure(row.source&&row.source.file_id==='rq-202509-02'&&materials.has(row.source.file_id)&&row.source.sha256===materials.get(row.source.file_id)
      && row.source.scope===row.scope&&row.output?.scope===row.scope&&text(row.source.locator),'FINANCIAL_SOURCE_MISMATCH');
    const start=['total_assets','total_liabilities','net_assets'].includes(row.metric)?'2025-09-30':'2025-01-01';
    for(const side of [row.source,row.output])ensure(side.start===start&&side.end==='2025-09-30','FINANCIAL_PERIOD_MISMATCH');
    ensure(equalRoundedAmount(row.source,row.output,row.output.decimal_places),'FINANCIAL_AMOUNT_MISMATCH');
    const locators=row.output.locators;
    ensure(Array.isArray(locators)&&Number.isSafeInteger(row.expected_occurrences)&&row.expected_occurrences>0
      &&locators.length===row.expected_occurrences&&new Set(locators.map(l=>JSON.stringify(l))).size===locators.length
      &&locators.every(l=>l&&text(l.locator)&&l.scope_anchor&&text(l.scope_anchor.locator)&&text(l.scope_anchor.quote)
        &&(l.quote===undefined||(text(l.quote)&&Number.isSafeInteger(l.start)&&Number.isSafeInteger(l.end)&&l.start>=0&&l.end>l.start))
        &&(l.quote!==undefined||(l.period_anchor&&text(l.period_anchor.locator)&&text(l.period_anchor.quote)
          &&l.metric_anchor&&text(l.metric_anchor.locator)&&text(l.metric_anchor.quote)))),'REPEATED_VALUE_COVERAGE_INCOMPLETE');
    if(row.scope==='consolidated'&&locators.length>=2)repeated++;
  }
  ensure(METRICS.every(metric=>SCOPES.every(scope=>keys.has(`${scope}:${metric}`)))&&repeated>=3,'FINANCIAL_COVERAGE_INCOMPLETE');
}
const INSPECT=`import hashlib,json,re,sys
from decimal import Decimal
from pathlib import Path
from pypdf import PdfReader
from openpyxl import load_workbook
from bondbuddy_file_authoring.check import package,resolve_revisions
from bondbuddy_file_authoring.source_outline import outline
from bondbuddy_file_authoring.word_patch import q,xml,paragraph_text
source=outline(package(Path(sys.argv[1])))
chapters=['preamble']+['p:'+str(h['paragraph'])+':'+hashlib.sha256(h['text'].encode()).hexdigest() for h in source['headings'] if h['level']==0]
pages=[len(PdfReader(p).pages) for p in sys.argv[2:]]
data=json.load(sys.stdin); words={}; books={}
def word_value(path,locator):
 match=re.fullmatch(r'(word/(?:document|header[0-9]+|footer[0-9]+|footnotes|endnotes)\\.xml)(?://w:p\\[([1-9][0-9]*)\\]|#table=([1-9][0-9]*),row=([1-9][0-9]*),cell=([1-9][0-9]*))',locator)
 if not match: raise ValueError('word_locator')
 if path not in words: words[path]=package(Path(path))
 root=resolve_revisions(xml(words[path][match[1]]),True)
 if match[2]:
  p=list(root.iter(q('p')))[int(match[2])-1]
  return paragraph_text(p),any(a.tag==q('tc') for a in p.iterancestors())
 table=list(root.iter(q('tbl')))[int(match[3])-1]
 cell=table.findall(q('tr'))[int(match[4])-1].findall(q('tc'))[int(match[5])-1]
 return ' '.join(paragraph_text(p) for p in cell.iter(q('p'))),True
def number(value): return Decimal(str(value).replace(',','').strip())
PERIOD=r'20[0-9]{2}年[0-9]{1,2}(?:[-—–至][0-9]{1,2})?月(?:[0-9]{1,2}日|末)?|20[0-9]{2}-[0-9]{2}-[0-9]{2}'
NUMBER=r'-?[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?'
ALIASES={'total_assets':('总资产','资产总额','资产合计'),'total_liabilities':('总负债','负债总额','负债合计','负债总计'),
 'net_assets':('净资产','所有者权益','股东权益'),'net_profit':('净利润',),
 'operating_cash_flow':('经营活动产生的现金流量净额','经营活动现金流量净额','经营性现金流量净额')}
def metric_ok(value,metric):return any(alias in value for alias in ALIASES[metric])
def period_ok(value,metric):
 value=re.sub(r'\\s+','',value)
 periods=re.findall(PERIOD,value)
 if metric in ('total_assets','total_liabilities','net_assets'):
  return len(periods)==1 and periods[0] in ('2025年9月末','2025年9月30日','2025-09-30')
 return len(periods)==1 and re.fullmatch(r'2025年1[-—–至]9月',periods[0]) is not None
def anchored(path,anchor):
 value=word_value(path,anchor['locator'])[0];quote=anchor['quote']
 if value.count(quote)!=1: raise ValueError('anchor_not_unique')
 return quote
def output_value(path,spec,row):
 if not isinstance(spec,dict): raise ValueError('precise_output_location_required')
 value,is_cell=word_value(path,spec['locator'])
 scope=anchored(path,spec['scope_anchor'])
 if ('合并' if row['scope']=='consolidated' else '母公司') not in scope: raise ValueError('scope_anchor')
 if 'quote' in spec:
  quote=spec['quote'];start=spec['start'];end=spec['end']
  if value.count(quote)!=1 or not period_ok(quote,row['metric']) or not metric_ok(quote,row['metric']): raise ValueError('precise_period_context')
  if isinstance(start,bool) or isinstance(end,bool) or not isinstance(start,int) or not isinstance(end,int) or not 0<=start<end<=len(quote): raise ValueError('amount_span')
  periods=list(re.finditer(PERIOD,quote))
  amounts=[m for m in re.finditer(NUMBER,quote) if not any(m.start()<p.end() and p.start()<m.end() for p in periods)]
  if len(amounts)!=1: raise ValueError('ambiguous_multiple_amounts')
  if (start,end)!=amounts[0].span(): raise ValueError('amount_span')
  amount=quote[start:end]
  if not re.fullmatch(NUMBER,amount): raise ValueError('amount_span')
  if start and quote[start-1] in '0123456789,.': raise ValueError('partial_amount')
  if end<len(quote) and quote[end] in '0123456789,.': raise ValueError('partial_amount')
  if quote[end:].lstrip().startswith(('%','％')): raise ValueError('percentage_is_not_amount')
  if quote[:start].rstrip().endswith(('(','（')) and quote[end:].lstrip().startswith((')','）')): raise ValueError('parenthesized_amount_unsupported')
  identity=(spec['locator'],value.index(quote)+start,value.index(quote)+end)
 else:
  amount=value.strip()
  if not is_cell or not re.fullmatch(NUMBER,amount): raise ValueError('single_numeric_cell_required')
  def coordinates(loc):
   m=re.fullmatch(r'(word/(?:document|header[0-9]+|footer[0-9]+|footnotes|endnotes)\\.xml)#table=([1-9][0-9]*),row=([1-9][0-9]*),cell=([1-9][0-9]*)',loc)
   if not m: raise ValueError('simple_table_header_required')
   return m[1],int(m[2]),int(m[3]),int(m[4])
  cell=coordinates(spec['locator']);period=coordinates(spec['period_anchor']['locator']);scope_cell=coordinates(spec['scope_anchor']['locator']);metric=coordinates(spec['metric_anchor']['locator'])
  if any(h[:2]!=cell[:2] for h in (period,scope_cell,metric)): raise ValueError('same_table_anchors_required')
  if not period[2]<cell[2] or period[3]!=cell[3] or not scope_cell[2]<cell[2] or metric[2]!=cell[2] or not metric[3]<cell[3]: raise ValueError('table_header_geometry')
  if not period_ok(anchored(path,spec['period_anchor']),row['metric']): raise ValueError('cell_period_anchor')
  if not metric_ok(anchored(path,spec['metric_anchor']),row['metric']): raise ValueError('cell_metric_anchor')
  identity=(spec['locator'],'whole_cell')
 if number(amount)!=number(row['output']['value']): raise ValueError('output_value')
 return identity
failures=[]
for index,row in enumerate(data['financial_checks']):
 try:
  src=row['source'];path=data['materials'][src['file_id']]
  if path.lower().endswith('.xlsx'):
   sheet,cell=src['locator'].rsplit('!',1)
   if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]*',cell): raise ValueError('cell_locator')
   if path not in books: books[path]=load_workbook(path,data_only=True,read_only=True)
   if number(books[path][sheet][cell].value)!=number(src['value']): raise ValueError('source_value')
  else: raise ValueError('unsupported_financial_source')
  seen=set()
  for locator in row['output']['locators']:
   identity=output_value(data['clean'],locator,row)
   if identity in seen: raise ValueError('duplicate_amount_span')
   seen.add(identity)
 except Exception: failures.append(index)
for book in books.values(): book.close()
print(json.dumps({'chapter_ids':chapters,'pages':pages,'financial_failures':failures}))
`;
export function inspectAcceptanceArtifacts(root,source,pdfs,financial){
  const result=spawnSync(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
    ['-B','-s','-c',INSPECT,source,...pdfs],{cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python'),PYTHONIOENCODING:'utf-8'},input:JSON.stringify(financial),encoding:'utf8',timeout:300000,maxBuffer:2*1024*1024});
  ensure(!result.error&&result.status===0,'INDEPENDENT_INSPECTION_FAILED');
  try{return JSON.parse(result.stdout);}catch{fail('INDEPENDENT_INSPECTION_FAILED');}
}
export async function verifyProspectusAcceptance({root=repo,file=process.env.BB_PROSPECTUS_ACCEPTANCE_FILE,now=Date.now()}={}){
  ensure(text(file),'FILE_REQUIRED');
  const evidenceFile=resolve(root,file);let raw;
  try{const stat=lstatSync(evidenceFile);ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=16*1024*1024,'FILE_INVALID');raw=readFileSync(evidenceFile);}catch{fail('FILE_UNAVAILABLE');}
  let evidence;try{evidence=JSON.parse(raw.toString('utf8'));}catch{fail('JSON_INVALID');}
  ensure(evidence?.schema_version===ACCEPTANCE_POLICY&&evidence.synthetic===false&&evidence.status==='passed','REAL_ACCEPTANCE_REQUIRED');
  ensure(git(root,['status','--porcelain','--untracked-files=normal'])==='','CLEAN_TREE_REQUIRED');
  const expected={commit:git(root,['rev-parse','HEAD']),tree:git(root,['rev-parse','HEAD^{tree}']),prompt_tools_sha256:pipelineFingerprint(root)};
  validateBinding(evidence,expected);
  const reviewer=evidence.reviewer,reviewed=validateHumanReviewer(reviewer,now);
  ensure(Array.isArray(evidence.findings)&&evidence.findings.every(f=>f&&['minor','major','critical'].includes(f.severity)
    &&['open','resolved'].includes(f.status)&&text(f.description)&&(!['major','critical'].includes(f.severity)||f.status==='resolved')),'UNRESOLVED_FINDINGS');
  ensure(Array.isArray(evidence.cases)&&evidence.cases.length===1,'GOLDEN_CASE_REQUIRED');
  const c=evidence.cases[0];
  ensure(c?.case_id==='rq-202509'&&c.task_kind==='full_update'&&c.source_cutoff==='2025-06-30'&&c.target_cutoff==='2025-09-30'&&realId(c.run_id),'GOLDEN_CASE_REQUIRED');
  const manifest=JSON.parse(readFileSync(resolve(root,'tests/samples/2026-09-25/manifest.json'),'utf8'));
  const golden=manifest.cases.find(item=>item.case_id==='rq-202509');
  ensure(golden&&manifest.synthetic===false,'AUTHORIZED_MANIFEST_INVALID');
  const materials=new Map(golden.files.map(f=>[f.file_id,f.sha256]));
  ensure(Array.isArray(c.materials)&&c.materials.length===golden.files.length&&new Set(c.materials.map(m=>m.file_id)).size===golden.files.length,'MATERIAL_COVERAGE_INCOMPLETE');
  const materialPaths={};
  for(const m of c.materials){ensure(materials.get(m.file_id)===m.sha256,'MATERIAL_HASH_MISMATCH');materialPaths[m.file_id]=artifact(m,dirname(evidenceFile)).path;}
  const refs=c.artifacts;
  ensure(refs&&HEX.test(c.input_hash??''),'ARTIFACT_REF_INVALID');
  const files={};
  for(const key of ['input','provider_record','source','tracked','clean','quality_report','source_pdf','tracked_pdf','clean_pdf','render_report','review_record'])
    files[key]=artifact(refs[key],dirname(evidenceFile),['input','provider_record','quality_report','render_report','review_record'].includes(key)?16*1024*1024:100*1024*1024);
  ensure(files.source.sha256===golden.files.find(f=>f.upload_role==='historical').sha256,'SOURCE_MANUSCRIPT_MISMATCH');
  for(const name of ['source','tracked','clean'])ensure(files[name].bytes.subarray(0,2).toString()==='PK','WORD_ARTIFACT_INVALID');
  for(const name of ['source_pdf','tracked_pdf','clean_pdf'])ensure(files[name].bytes.subarray(0,5).toString()==='%PDF-','RENDER_ARTIFACT_INVALID');
  const input=jsonFile(files.input),provider=jsonFile(files.provider_record),quality=jsonFile(files.quality_report),render=jsonFile(files.render_report),review=jsonFile(files.review_record);
  ensure(input.version==='codex-file-input-v1'&&input.input_hash===c.input_hash&&input.baseline_sha256===files.source.sha256
    && input.target?.issuer_name===golden.issuer&&input.target?.details?.target_reporting_periods?.some(p=>p.end==='2025-09-30')
    &&Array.isArray(input.materials)&&golden.files.every(f=>input.materials.some(m=>m.sha256===f.sha256)),'LOCKED_INPUT_MISMATCH');
  const catalog=JSON.parse(readFileSync(resolve(root,'deploy/m1/codex-file-authoring-model-catalog.json'),'utf8'));
  validateRealModelRecord(provider,{...expected,run_id:c.run_id,input_hash:c.input_hash,tracked_sha256:files.tracked.sha256,
    clean_sha256:files.clean.sha256,reviewer_id:reviewer.id,models:catalog.models.map(m=>m.slug),reviewed});
  ensure(quality.version==='word-quality-v1'&&quality.status==='passed'&&Array.isArray(quality.issues)&&quality.issues.length===0
    &&quality.baseline_sha256===files.source.sha256&&quality.tracked_sha256===files.tracked.sha256&&quality.clean_sha256===files.clean.sha256,'QUALITY_REPORT_INVALID');
  validateFinancialChecks(c.financial_checks,materials,reviewer.id);
  const inspection=inspectAcceptanceArtifacts(root,files.source.path,[files.source_pdf.path,files.tracked_pdf.path,files.clean_pdf.path],
    {financial_checks:c.financial_checks,materials:materialPaths,clean:files.clean.path});
  ensure(Array.isArray(inspection.financial_failures)&&inspection.financial_failures.length===0,'FINANCIAL_ARTIFACT_VALUE_MISMATCH');
  ensure(inspection.chapter_ids.length>=5,'SOURCE_OUTLINE_INCOMPLETE');
  validateChapterCoverage(c.chapters,inspection.chapter_ids,reviewer.id);
  ensure(review.reviewer_id===reviewer.id&&review.generated_by_model===false&&review.facts_verified_by_human===true
    &&review.reviewed_at===reviewer.reviewed_at&&review.source_sha256===files.source.sha256&&review.tracked_sha256===files.tracked.sha256
    &&review.clean_sha256===files.clean.sha256&&review.render_report_sha256===files.render_report.sha256
    &&Array.isArray(review.chapter_ids)&&JSON.stringify(review.chapter_ids)===JSON.stringify(inspection.chapter_ids)
    &&Array.isArray(review.financial_check_keys)&&METRICS.every(metric=>SCOPES.every(scope=>review.financial_check_keys.includes(`${scope}:${metric}`)))
    &&text(review.notes)&&review.notes.length>=64,'HUMAN_REVIEW_RECORD_REQUIRED');
  ensure(render.status==='passed'&&text(render.renderer)&&render.reviewer_id===reviewer.id&&render.template_fidelity==='passed'
    &&render.headers_footers==='passed'&&render.tables==='passed'&&render.no_clipping==='passed'&&render.no_missing_glyphs==='passed'
    &&Array.isArray(render.documents)&&render.documents.length===3,'RENDER_REVIEW_INCOMPLETE');
  for(const [i,name] of ['source','tracked','clean'].entries()){
    const r=render.documents.find(d=>d.variant===name),pages=inspection.pages[i];
    ensure(r&&r.sha256===files[`${name}_pdf`].sha256&&r.docx_sha256===files[name].sha256&&r.pages===pages&&Number.isSafeInteger(pages)&&pages>0
      &&Array.isArray(r.inspected_pages)&&r.inspected_pages.length===pages&&r.inspected_pages.every((p,index)=>p===index+1),'RENDER_PAGE_COVERAGE_INCOMPLETE');
  }
  ensure(inspection.pages[2]>=inspection.pages[0]*.8&&text(render.pagination_note),'RENDER_PAGINATION_REGRESSION');
  ensure(files.review_record.bytes.length>=64,'HUMAN_REVIEW_RECORD_REQUIRED');
  // Detect a source or tool change while private artifacts were inspected.
  validateBinding({...expected,prompt_tools_sha256:pipelineFingerprint(root)},expected);
  ensure(git(root,['rev-parse','HEAD'])===expected.commit&&git(root,['status','--porcelain','--untracked-files=normal'])==='','SOURCE_CHANGED_DURING_REVIEW');
  return {status:'passed',...expected,evidence_sha256:hash(raw),case_count:1,real_model:true,case_ids:['rq-202509']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const value=await verifyProspectusAcceptance({file:process.argv[2]??process.env.BB_PROSPECTUS_ACCEPTANCE_FILE});process.stdout.write(`PROSPECTUS_ACCEPTANCE_RESULT=${JSON.stringify(value)}\n`);}
  catch(error){console.error(/^PROSPECTUS_ACCEPTANCE_[A-Z_]+$/.test(error.message)?error.message:'PROSPECTUS_ACCEPTANCE_VERIFICATION_FAILED');process.exitCode=1;}
}
