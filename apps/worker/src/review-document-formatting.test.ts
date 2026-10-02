import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { reviewComplianceEvidence, type ReviewComplianceInput } from '../../../packages/domain/dist/review-compliance-checks.js';
import { referenceFor } from '../../../packages/domain/dist/review-evidence.js';
import { loadExplicitReviewFormatting } from './review-formatting-context.js';
import { loadReviewDocumentFormatting } from './review-document-formatting.js';
import { validateDocumentParseResponse, type DocumentParseRequest } from './document-parser.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import type { ReviewAnalysisRecord } from './review-model-stage.js';

const python=process.env.BONDBUDDY_TEST_PYTHON??process.env.BB_PYTHON??'python3';
const available=spawnSync(python,['-c','import docx,lxml'],{encoding:'utf8',windowsHide:true}).status===0;
const root=resolve(fileURLToPath(import.meta.url),'../../../..');
const requirements=['页眉内容为“合成保密页眉”','页眉中文字体为宋体','页眉西文字体为Arial','页眉字号为12磅','目录必须使用TOC域','目录必须存在'];

async function fixtures(work:(read:(name:string)=>Promise<Awaited<ReturnType<typeof readFixture>>>)=>Promise<void>){
  const directory=await mkdtemp(resolve(tmpdir(),'bb-native-document-format-'));
  try{
    const generated=spawnSync(python,['-B',resolve(root,'python/tests/create_docx_formatting_fixtures.py'),directory],{encoding:'utf8',windowsHide:true});assert.equal(generated.status,0,generated.stderr);
    await work(name=>readFixture(resolve(directory,`${name}.docx`)));
  }finally{assert(directory.startsWith(resolve(tmpdir(),'bb-native-document-format-')));await rm(directory,{recursive:true,force:true});}
}
async function readFixture(path:string){
  const sha=createHash('sha256').update(await readFile(path)).digest('hex');
  const request:DocumentParseRequest={schema_version:'document-parse-request-v1',request_id:'synthetic-doc-format',material:{material_id:'source',material_version:1,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sha256:sha,authorized_local_path:path},options:{}};
  const parsed=spawnSync(python,['-B','-m','bondbuddy_document_parser'],{cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python'),PYTHONIOENCODING:'utf-8'},input:JSON.stringify(request),encoding:'utf8',maxBuffer:8*1024*1024,windowsHide:true});assert.equal(parsed.status,0,parsed.stderr);
  const response=validateDocumentParseResponse(JSON.parse(parsed.stdout),request),hash=inputManifestHash(response);
  assert.notEqual(response.status,'failed');assert(!JSON.stringify(response).includes('合成保密页眉'));
  const snapshot:StoredParseSnapshot={snapshotId:'snapshot',ownerUserId:'owner',projectId:'project',materialId:'source',materialVersion:1,contentSha256:sha,
    parserVersion:response.parser_version,requestId:request.request_id,requestHash:'f'.repeat(64),requestOptions:{},responseSha256:hash,response,evidence:response.records,createdAt:'2026-10-02T00:00:00Z',replayed:false};
  const pin={owner_user_id:'owner',project_id:'project',source:{material_id:'source',material_version:1,sha256:sha},snapshot_id:'snapshot',response_sha256:hash};
  const document=loadReviewDocumentFormatting(snapshot,pin);assert(document);
  const records:ReviewAnalysisRecord[]=response.records.map(r=>({owner_user_id:'owner',project_id:'project',material_id:'source',material_version:1,material_sha256:sha,parse_snapshot_id:'snapshot',parse_response_sha256:hash,record_id:r.record_id,record_sha256:inputManifestHash(r),locator_type:r.locator_type,locator:r.locator,literal_quote:r.literal_quote,extraction_method:r.extraction_method,uncertainty:r.uncertainty,formatting:r.formatting,source_kind:'disclosure'}));
  const loaded=loadExplicitReviewFormatting({input_hash:'f'.repeat(64),input_revision:1,requirements,records});
  const evidence={owner_user_id:'owner',project_id:'project',report_id:'report',source_material:pin.source,records,rules:loaded.rules};
  const input:ReviewComplianceInput={context:null,packs:[],assessments:[],formatting_requirements:loaded.formatting_requirements,formatted_records:records.map(r=>({ref:referenceFor(r),formatting:r.formatting!})),formatted_documents:[document]};
  const check=()=>reviewComplianceEvidence(input,evidence);
  const coverage=()=>check().coverage.filter(c=>c.check_id.startsWith('user-format:'));
  return {snapshot,pin,request,response,document,records,loaded,evidence,input,check,coverage,outcomes:()=>coverage().map(c=>c.outcome)};
}
const skip=available?false:'Set BONDBUDDY_TEST_PYTHON to Python with python-docx/lxml';
test('native header content/fonts and real simple/complex TOC fields produce pinned document coverage without fake body evidence (synthetic)',{skip},async()=>fixtures(async read=>{
  for(const name of ['simple','complex']){
    const f=await read(name);assert.deepEqual(f.outcomes(),['pass','pass','pass','pass','pass','pass']);assert.equal(f.check().findings.length,0);
    assert(f.coverage().every(c=>c.evidence_refs.length===0&&c.rule_refs?.[0]?.authority==='internal_method'));
    assert.match(f.coverage()[0]!.reason,/part=word\/header1.xml.*sections=1:default/);
    assert.match(f.coverage()[4]!.reason,/part=word\/document.xml.*field=1:.*paragraphs=2\.\.2/);
    for(const c of f.coverage()){assert(c.reason.includes(f.pin.response_sha256));assert(c.reason.includes(f.pin.source.sha256));}
    f.input.formatting_requirements[0]!.expected='0'.repeat(64);assert.equal(f.outcomes()[0],'issue');assert.equal(f.check().findings.length,0);
  }
}));
test('empty, dirty/locked, deleted, text-only and incomplete TOCs never claim a usable refreshed directory (synthetic)',{skip},async()=>fixtures(async read=>{
  for(const [name,expected] of [
    ['empty',['pass','uncovered']],['dirty',['pass','uncovered']],['locked',['pass','uncovered']],
    ['plain',['issue','uncovered']],['deleted',['issue','uncovered']],['broken',['uncovered','uncovered']],['alt_chunk',['uncovered','uncovered']],
  ] as const){const f=await read(name);assert.deepEqual(f.outcomes().slice(4),expected,name);assert(f.coverage()[5]!.reason.includes('刷新')||f.coverage()[5]!.reason.includes('不完整'));}
}));
test('missing headers are distinguishable from unresolved linkage, fields, themes and missing styles (synthetic)',{skip},async()=>fixtures(async read=>{
  assert.deepEqual((await read('missing_header')).outcomes().slice(0,4),['issue','issue','issue','issue']);
  for(const name of ['section_link','header_field','first_page','even_page','inactive_variant'])assert.deepEqual((await read(name)).outcomes().slice(0,4),['uncovered','uncovered','uncovered','uncovered'],name);
  assert.deepEqual((await read('missing_style')).outcomes().slice(0,4),['pass','uncovered','uncovered','uncovered']);
  const theme=await read('theme');assert.equal(theme.outcomes()[2],'uncovered');
  for(const name of ['hansi','complex_script','complex_flag'])assert.equal((await read(name)).outcomes()[2],'uncovered',name);
}));
test('source ownership, material/parse hashes, version, rule and metadata gates reject old/tampered document formatting (synthetic)',{skip},async()=>fixtures(async read=>{
  const f=await read('simple');
  for(const patch of [{owner_user_id:'other'},{project_id:'other'},{material_id:'other'},{material_version:2},{material_sha256:'0'.repeat(64)},{parse_snapshot_id:'other'},{parse_response_sha256:'0'.repeat(64)},{parser_version:'bondbuddy-document-parser-1.0.7'}]){
    f.input.formatted_documents=[{...f.document,...patch}];assert(f.outcomes().every(x=>x==='uncovered'),JSON.stringify(patch));
  }
  f.input.formatted_documents=[];assert(f.outcomes().every(x=>x==='uncovered'));
  f.input.formatted_documents=[f.document];f.input.formatting_requirements[0]={...f.input.formatting_requirements[0]!,rule_ref:{...f.loaded.rules[0]!,quote:'invented requirement'}};assert.equal(f.outcomes()[0],'uncovered');
  for(const pin of [{...f.pin,owner_user_id:'other'},{...f.pin,source:{...f.pin.source,sha256:'0'.repeat(64)}},{...f.pin,response_sha256:'0'.repeat(64)},{...f.pin,snapshot_id:'other'}])assert.throws(()=>loadReviewDocumentFormatting(f.snapshot,pin),/INPUT_REVISION_CONFLICT/);
  const legacy=structuredClone(f.snapshot);legacy.parserVersion=legacy.response.parser_version='bondbuddy-document-parser-1.0.7';delete legacy.response.document.docx_formatting;
  assert.equal(loadReviewDocumentFormatting(legacy,f.pin),null);
  assert.throws(()=>validateDocumentParseResponse({...f.response,parser_version:'bondbuddy-document-parser-1.0.7'},f.request),/INVALID_PARSE_RESPONSE/);
  const changed=structuredClone(f.response);changed.document.docx_formatting!.headers.parts[0]!.part_sha256='0'.repeat(64);
  assert.throws(()=>validateDocumentParseResponse(changed,f.request),/INVALID_PARSE_RESPONSE/);
  const missing=structuredClone(f.snapshot);delete missing.response.document.docx_formatting;assert.equal(loadReviewDocumentFormatting(missing,f.pin),null);
}));
