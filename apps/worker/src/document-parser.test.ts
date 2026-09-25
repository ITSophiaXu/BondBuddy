import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runDocumentParser, type DocumentParseRequest } from './document-parser.js';

const request:DocumentParseRequest={
  schema_version:'document-parse-request-v1',
  request_id:'parse-synthetic',
  material:{
    material_id:'material-synthetic',
    material_version:1,
    media_type:'text/plain',
    sha256:'a'.repeat(64),
    authorized_local_path:'/private/synthetic/material.txt',
  },
  options:{},
};

const response={
  schema_version:'document-parse-response-v1',
  request_id:'parse-synthetic',
  parser_version:'bondbuddy-document-parser-1.0.0',
  status:'parsed',
  material:{material_id:'material-synthetic',material_version:1,media_type:'text/plain',sha256:'a'.repeat(64)},
  records:[{record_id:'evidence-000001',material_id:'material-synthetic',material_version:1,content_hash:'a'.repeat(64),locator_type:'text_line',locator:{line:1,stable_ref:'text:l000001'},literal_quote:'synthetic',context:'',extraction_method:'native_text',extractor_version:'bondbuddy-document-parser-1.0.0',confidence:null,uncertainty:[],formatting:{}}],
  warnings:[],
  document:{page_count:null,encoding:'utf-8-sig'},
  error:null,
};

test('worker validates the versioned parser response and material binding',async()=>{
  const result=await runDocumentParser(request,{invoke:async serialized=>{
    assert.deepEqual(JSON.parse(serialized),request);
    return JSON.stringify(response);
  }});
  assert.equal(result.records[0]?.literal_quote,'synthetic');
});

test('worker rejects a parser result bound to different immutable bytes',async()=>{
  const mismatched={...response,material:{...response.material,sha256:'b'.repeat(64)}};
  await assert.rejects(runDocumentParser(request,{invoke:async()=>JSON.stringify(mismatched)}),/PARSE_MATERIAL_IDENTITY_MISMATCH/);
});

test('worker rejects failed responses that contain partial records',async()=>{
  const invalid={...response,status:'failed',error:{code:'MATERIAL_UNREADABLE',message:'synthetic'},records:response.records};
  await assert.rejects(runDocumentParser(request,{invoke:async()=>JSON.stringify(invalid)}),/INVALID_PARSE_RESPONSE/);
});

test('worker rejects malformed response metadata, records, warnings, locators and status combinations',async()=>{
  const invalidResponses:unknown[]=[];
  invalidResponses.push({...response,parser_version:''});
  invalidResponses.push({...response,parser_version:'../private'});
  invalidResponses.push({...response,records:[response.records[0],{...response.records[0]}]});
  invalidResponses.push({...response,records:[{...response.records[0],record_id:''}]});
  invalidResponses.push({...response,records:[{...response.records[0],confidence:1.1}]});
  invalidResponses.push({...response,records:[{...response.records[0],context:null}]});
  invalidResponses.push({...response,records:[{...response.records[0],locator:{line:0,stable_ref:'text:l000000'}}]});
  invalidResponses.push({...response,records:[{...response.records[0],locator_type:'pdf_bbox'}]});
  invalidResponses.push({...response,records:[{...response.records[0],unexpected_private_field:'/secret'}]});
  invalidResponses.push({...response,warnings:[{code:'',message:'bad'}]});
  invalidResponses.push({...response,warnings:[{code:'BAD',message:'bad',path:'/private/source'}]});
  invalidResponses.push({...response,status:'needs_confirmation'});
  invalidResponses.push({...response,document:{...response.document,page_count:1}});
  invalidResponses.push({...response,document:{...response.document,authorized_local_path:'/private/source'}});
  for(const invalid of invalidResponses) {
    await assert.rejects(runDocumentParser(request,{invoke:async()=>JSON.stringify(invalid)}),/INVALID_PARSE_RESPONSE/);
  }
});

test('worker validates type-specific PDF and DOCX anchors without fabricating DOCX pages',async()=>{
  const pdfRequest:DocumentParseRequest={...request,material:{...request.material,media_type:'application/pdf'}};
  const pdfResponse={...response,material:{...response.material,media_type:'application/pdf'},document:{page_count:2,pages_without_native_text:[],pages_with_images:[]},records:[{
    ...response.records[0],locator_type:'pdf_bbox',locator:{page:2,line:1,bbox:{x0:1,top:2,x1:3,bottom:4},stable_ref:'pdf:p0002:l0001'},
  }]};
  const pdf=await runDocumentParser(pdfRequest,{invoke:async()=>JSON.stringify(pdfResponse)});
  assert.equal(pdf.records[0]?.locator.page,2);
  const croppedPdf={...pdfResponse,records:[{...pdfResponse.records[0],locator:{...pdfResponse.records[0].locator,
    bbox:{x0:-2,top:-1,x1:3,bottom:4}}}]};
  assert.equal((await runDocumentParser(pdfRequest,{invoke:async()=>JSON.stringify(croppedPdf)})).status,'parsed');
  const invalidPdf={...pdfResponse,records:[{...pdfResponse.records[0],locator:{...pdfResponse.records[0].locator,page:3,stable_ref:'pdf:p0003:l0001'}}]};
  await assert.rejects(runDocumentParser(pdfRequest,{invoke:async()=>JSON.stringify(invalidPdf)}),/INVALID_PARSE_RESPONSE/);
  const overLimit={...pdfResponse,document:{...pdfResponse.document,page_count:1501},records:[{...pdfResponse.records[0],locator:{...pdfResponse.records[0].locator,page:1}}]};
  await assert.rejects(runDocumentParser(pdfRequest,{invoke:async()=>JSON.stringify(overLimit)}),/INVALID_PARSE_RESPONSE/);
  const failedPdf={...pdfResponse,status:'failed',document:{page_count:null},records:[],warnings:[],error:{code:'MATERIAL_UNREADABLE',message:'Synthetic failure'}};
  const failed=await runDocumentParser(pdfRequest,{invoke:async()=>JSON.stringify(failedPdf)});
  assert.equal(failed.status,'failed');

  const docxRequest:DocumentParseRequest={...request,material:{...request.material,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}};
  const docxResponse={...response,material:{...response.material,media_type:docxRequest.material.media_type},status:'needs_confirmation',warnings:[{code:'DOCX_AUXILIARY_PARTS',message:'Synthetic warning'}],document:{page_count:null,revision_summary:{insertions:0,deletions:0}},records:[{
    ...response.records[0],locator_type:'docx_block',locator:{path:[{table:1,row:2,column:3},{paragraph:4}],stable_ref:'docx:t001:r002:c003:p0004'},
  }]};
  const docx=await runDocumentParser(docxRequest,{invoke:async()=>JSON.stringify(docxResponse)});
  assert.deepEqual(docx.records[0]?.locator.path,[{table:1,row:2,column:3},{paragraph:4}]);
  const badDocx={...docxResponse,records:[{...docxResponse.records[0],locator:{path:[{paragraph:1}],page:1,stable_ref:'docx:p0001'}}]};
  await assert.rejects(runDocumentParser(docxRequest,{invoke:async()=>JSON.stringify(badDocx)}),/INVALID_PARSE_RESPONSE/);
});

const repositoryRoot=join(dirname(fileURLToPath(import.meta.url)),'../../..');
const localPython=join(repositoryRoot,'.venv','bin','python');
test('worker accepts the actual Python subprocess response shape when the repository venv exists',{
  skip:existsSync(localPython)?false:'repository .venv is not installed',
},async t=>{
  const bytes=Buffer.from('synthetic parser contract evidence\n','utf8');
  const root=await mkdtemp(join(tmpdir(),'bb-document-parser-contract-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'material.txt');
  await writeFile(path,bytes);
  const actualRequest:DocumentParseRequest={...request,material:{...request.material,sha256:createHash('sha256').update(bytes).digest('hex'),authorized_local_path:path}};
  const result=await runDocumentParser(actualRequest,{pythonExecutable:localPython,repoRoot:repositoryRoot});
  assert.equal(result.status,'parsed');
  assert.equal(result.records[0]?.literal_quote,'synthetic parser contract evidence');
  assert.equal(result.document.page_count,null);
});

test('#17 a parser child killed by the kernel (SIGKILL, e.g. container OOM) reports DOCUMENT_PARSER_MEMORY_LIMIT', async (t) => {
  const root=await mkdtemp(join(tmpdir(),'bb-parser-oom-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const fake=join(root,'python3');
  await writeFile(fake,'#!/bin/sh\ncat >/dev/null\nkill -9 $$\n',{mode:0o700});
  await assert.rejects(runDocumentParser(request,{pythonExecutable:fake,repoRoot:root}),/DOCUMENT_PARSER_MEMORY_LIMIT/);
});
