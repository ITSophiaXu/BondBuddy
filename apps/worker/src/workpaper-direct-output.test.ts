import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readBoundedOfficeParts} from '@bondbuddy/api/docx-inspector';
import type {ProjectFileText,WorkpaperEntry} from '@bondbuddy/contracts';
import {collectDirectWorkpaper} from './workpaper-direct-output.js';
import {CodexOutputValidationError} from './codex-adapter.js';

test('one authoring output yields a grounded workpaper or a host-generated explanation without another model call',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'bb-direct-workpaper-'));
 const entry={id:'one',code:'1-1',title:'资产分析',path:'1-1 资产分析.docx',instructions:''} as WorkpaperEntry;
 const source={spans:[{id:'p0',text:'总资产100万元。',location:'段落1'},{id:'p1',text:'本期不涉及境外投资。',location:'段落2'}]} as ProjectFileText;
 const result={item_id:entry.id,status:'generate',reason:'已有资产明细可形成分析。',missing_materials:[],citations:[{span_id:'p0',quote:'总资产100万元。'}]};
 const coverage={reviewed_span_ids:['p0','p1'],used_span_ids:['p0'],excluded:[{span_id:'p1',reason:'与本项资产分析无关。'}]};
 try{
  await mkdir(join(cwd,'output'));
  const write=async(r:unknown,c:unknown=coverage)=>{await writeFile(join(cwd,'output/workpaper-result.json'),JSON.stringify(r));await writeFile(join(cwd,'output/workpaper-coverage.json'),JSON.stringify(c));};
  await assert.rejects(collectDirectWorkpaper(cwd,entry,source),CodexOutputValidationError);
  await write(result);const generated=await collectDirectWorkpaper(cwd,entry,source);assert.equal(generated.decision.status,'generate');assert.equal(generated.replacements,undefined);
  await write({...result,status:'not_applicable',reason:'本期不涉及境外投资。',citations:[{span_id:'p1',quote:'本期不涉及境外投资。'}]});
  const excluded=await collectDirectWorkpaper(cwd,entry,source);assert.equal(excluded.decision.status,'not_applicable');
  assert.match(readBoundedOfficeParts(excluded.replacements!['document.docx']).get('word/document.xml')!.toString(),/本项业务不适用/);
  await write({...result,status:'not_applicable',citations:[]});const unproven=await collectDirectWorkpaper(cwd,entry,source);assert.equal(unproven.decision.status,'missing_information');
  assert.match(readBoundedOfficeParts(unproven.replacements!['document.docx']).get('word/document.xml')!.toString(),/不能替代相应原件或实际履职记录/);
  await write(result);assert.equal((await collectDirectWorkpaper(cwd,{...entry,title:'营业执照原件'},source)).decision.status,'external_evidence');
  await write({...result,item_id:'another'});await assert.rejects(collectDirectWorkpaper(cwd,entry,source),CodexOutputValidationError);
  await write(result,{...coverage,reviewed_span_ids:['p0']});await assert.rejects(collectDirectWorkpaper(cwd,entry,source),CodexOutputValidationError);
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('collector diagnoses the exact missing file, JSON syntax, schema field and coverage rule',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'bb-direct-diagnostics-'));
 const entry={id:'one',code:'1-1',title:'资产分析',path:'x.docx',instructions:''} as WorkpaperEntry;
 const source={spans:[{id:'p0',text:'资产100万元。',location:'段落1'}]} as ProjectFileText;
 const result={item_id:'one',status:'generate',reason:'资产数据足以编制。',missing_materials:[],citations:[]};
 const coverage={reviewed_span_ids:['p0'],used_span_ids:['p0'],excluded:[]};
 const check=(code:string,file:string,field?:string)=>assert.rejects(collectDirectWorkpaper(cwd,entry,source),error=>{
  assert.ok(error instanceof CodexOutputValidationError);assert.equal(error.collectionDiagnostic?.code,code);
  assert.equal(error.collectionDiagnostic?.file,file);if(field)assert.equal(error.collectionDiagnostic?.field,field);return true;
 });
 try{
  await mkdir(join(cwd,'output'));
  await check('workpaper_file_missing','workpaper-result.json');
  await writeFile(join(cwd,'output/workpaper-result.json'),JSON.stringify(result));
  await check('workpaper_file_missing','workpaper-coverage.json');
  await writeFile(join(cwd,'output/workpaper-coverage.json'),'{bad');
  await check('workpaper_json_invalid','workpaper-coverage.json');
  await writeFile(join(cwd,'output/workpaper-coverage.json'),JSON.stringify(coverage));
  await writeFile(join(cwd,'output/workpaper-result.json'),JSON.stringify({...result,status:'private invalid content'}));
  await check('workpaper_result_schema_invalid','workpaper-result.json','/status');
  await writeFile(join(cwd,'output/workpaper-result.json'),JSON.stringify({...result,item_id:'wrong'}));
  await check('workpaper_item_mismatch','workpaper-result.json','/item_id');
  await writeFile(join(cwd,'output/workpaper-result.json'),JSON.stringify(result));
  await writeFile(join(cwd,'output/workpaper-coverage.json'),JSON.stringify({...coverage,used_span_ids:[]}));
  await check('workpaper_source_coverage_incomplete','workpaper-coverage.json','/reviewed_span_ids');
 }finally{await rm(cwd,{recursive:true,force:true});}
});
