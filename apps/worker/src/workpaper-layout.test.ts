import test from'node:test';import assert from'node:assert/strict';
import{mkdtemp,mkdir,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{digest}from'@bondbuddy/api/data';import{normalizeWorkpaperLayout,inspectProjectFile,projectFilesRoot}from'./project-file-tools.js';import type{StageContext}from'./run-pipeline.js';
const python=process.env.BONDBUDDY_TEST_PYTHON;
for(const corrupt of [false,true])test('host table layout preserves exact raw preimage, text, fixed links and '+(corrupt?'rejects bad storage readback':'idempotent normalized bytes'),{skip:!python},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-layout-test-'));try{
  await mkdir(join(dir,'output'));const path=join(dir,'output/document.docx'),objects=new Map<string,Buffer>();
  const ctx={run:{id:'run',project_id:'project',owner_user_id:'owner'},blobs:{put:async(k:string,b:Buffer)=>{objects.set(k,Buffer.from(b));},getIfExistsBounded:async(k:string)=>corrupt?Buffer.from('bad'):objects.get(k)??null}} as unknown as StageContext;
  await promisify(execFile)(python!,['-c',"import sys\nfrom docx import Document\nfrom docx.oxml import OxmlElement\nd=Document();d.add_paragraph('Financing Table').alignment=1;d.add_paragraph('单位：万元');t=d.add_table(rows=2,cols=2);t.rows[0]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'));t.cell(0,0).text='项目';t.cell(0,1).text='金额';t.cell(1,0).text='现金';t.cell(1,1).text='123.45';d.save(sys.argv[1])",path],{cwd:projectFilesRoot});
  const raw=await readFile(path),before=await inspectProjectFile(ctx,path);
  if(corrupt){await assert.rejects(normalizeWorkpaperLayout(ctx,dir),/M4_OUTPUT_STORE_FAILED/);assert.deepEqual(await readFile(path),raw);return;}
  const receipt=await normalizeWorkpaperLayout(ctx,dir);assert.ok(receipt);assert.equal(receipt.changed_paragraphs,4);assert.deepEqual(objects.get(receipt.original.key),raw);
  assert.equal(receipt.input_sha256,digest(raw));const after=await inspectProjectFile(ctx,path);assert.deepEqual(after.spans,before.spans);assert.equal(after.sha256,receipt.output_sha256);
  const normalized=await readFile(path);assert.equal(await normalizeWorkpaperLayout(ctx,dir),undefined);assert.deepEqual(await readFile(path),normalized);
 }finally{await rm(dir,{recursive:true,force:true});}
});

import{validM4DocumentResult}from'./m4-document-stage.js';
test('layout receipt is bound to the exact owned original and final document without requiring it on old results',()=>{
 const ctx={run:{id:'run',project_id:'project',owner_user_id:'owner',input_hash:'a'.repeat(64)}} as StageContext;
 const prefix='owners/owner/projects/project/runs/run/m4-documents/';
 const value={version:'codex-m4-document-v1',input_hash:'a'.repeat(64),skill_sha256:'b'.repeat(64),method_hash:'c'.repeat(64),files:{'document.docx':{key:prefix+'call/'+'d'.repeat(64)+'/document.docx',sha256:'d'.repeat(64),byte_size:100},'preparation-note.docx':{key:prefix+'call/'+'e'.repeat(64)+'/preparation-note.docx',sha256:'e'.repeat(64),byte_size:101}}};
 assert.equal(validM4DocumentResult(value,ctx),true);
 const receipt={version:'workpaper-pagination-v1',input_sha256:'f'.repeat(64),output_sha256:'d'.repeat(64),changed_paragraphs:0,changed_header_rows:1,content_unchanged:true,original:{key:'owners/owner/projects/project/runs/run/m4-layout-preimages/'+'f'.repeat(64)+'/document.docx',sha256:'f'.repeat(64),byte_size:99}};
 assert.equal(validM4DocumentResult({...value,workpaper_layout:receipt},ctx),true);
 for(const change of [{output_sha256:'0'.repeat(64)},{changed_header_rows:0},{changed_header_rows:-1},{content_unchanged:false},{original:{...receipt.original,key:receipt.original.key.replace('/owner/','/foreign/')}}])assert.equal(validM4DocumentResult({...value,workpaper_layout:{...receipt,...change}},ctx),false);
});
