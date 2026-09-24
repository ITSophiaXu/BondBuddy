import assert from 'node:assert/strict';
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
