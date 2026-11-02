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
  'python/bondbuddy_file_authoring/word_patch.py','python/bondbuddy_file_authoring/read_material.py',
  'scripts/verify-prospectus-acceptance.mjs','scripts/verify-prospectus-acceptance.test.mjs',
  'scripts/prospectus_acceptance_inspect.py','scripts/prospectus_acceptance_inspect_test.py']);
const fail=code=>{throw new Error(`PROSPECTUS_ACCEPTANCE_${code}`);};
const ensure=(value,code)=>{if(!value)fail(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const text=value=>typeof value==='string' && value.trim().length>0 && value.length<=1000;
const validAnchor=value=>value&&text(value.locator)&&text(value.quote);
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
        &&(l.narrative_list===undefined||(l.narrative_list===true&&l.quote!==undefined))
        &&(l.reporting_period_definition===undefined||(l.narrative_list===true
          &&validAnchor(l.reporting_period_definition.section_anchor)&&validAnchor(l.reporting_period_definition.term_anchor)
          &&validAnchor(l.reporting_period_definition.definition_anchor)))
        &&(l.period_context===undefined||(l.narrative_list===true&&l.reporting_period_definition
          &&validAnchor(l.period_context.section_anchor)&&validAnchor(l.period_context.introduction_anchor)))
        &&((l.scope_section_anchor===undefined&&l.table_caption===undefined)||(l.quote===undefined
          &&l.scope_section_anchor&&text(l.scope_section_anchor.locator)&&text(l.scope_section_anchor.quote)
          &&l.table_caption&&text(l.table_caption.locator)&&text(l.table_caption.quote)))
        &&(l.quote===undefined||(text(l.quote)&&Number.isSafeInteger(l.start)&&Number.isSafeInteger(l.end)&&l.start>=0&&l.end>l.start))
        &&(l.quote!==undefined||(l.period_anchor&&text(l.period_anchor.locator)&&text(l.period_anchor.quote)
          &&l.metric_anchor&&text(l.metric_anchor.locator)&&text(l.metric_anchor.quote)))),'REPEATED_VALUE_COVERAGE_INCOMPLETE');
    if(row.scope==='consolidated'&&locators.length>=2)repeated++;
  }
  ensure(METRICS.every(metric=>SCOPES.every(scope=>keys.has(`${scope}:${metric}`)))&&repeated>=3,'FINANCIAL_COVERAGE_INCOMPLETE');
}
export function inspectAcceptanceArtifacts(root,source,pdfs,financial){
  const result=spawnSync(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
    ['-B','-s',resolve(root,'scripts/prospectus_acceptance_inspect.py'),source,...pdfs],{cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python'),PYTHONIOENCODING:'utf-8'},input:JSON.stringify(financial),encoding:'utf8',timeout:300000,maxBuffer:2*1024*1024});
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
    {financial_checks:c.financial_checks,materials:materialPaths,clean:files.clean.path,issuer:golden.issuer});
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
