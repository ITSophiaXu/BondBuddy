import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDF_QUALITY_VERSION,pdfQualitySamplePages,auditPdfQualityState} from '@bondbuddy/contracts';
import {inspectPdfQuality} from './pdf-quality.js';

const pythonExecutable=process.env.BONDBUDDY_TEST_PYTHON;
test('quality child stream accepts only the actual sample prefix and a justified completion',{skip:!pythonExecutable},async t=>{
 const root=await mkdtemp(join(tmpdir(),'bb-quality-protocol-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'python','bondbuddy_pdf_quality');await mkdir(directory,{recursive:true});
 const probe=async(events:object[],extra='')=>{
  await writeFile(join(directory,'__main__.py'),events.map(event=>'print('+JSON.stringify(JSON.stringify(event))+', flush=True)').join('\n')+'\n'+extra);
  return inspectPdfQuality('unused-synthetic-path',{pythonExecutable,repoRoot:root,timeoutMs:10000});
 };
 for(const count of [1,9,100,2001]){
  const pages=pdfQualitySamplePages(count);
  const result=await probe([{page_count:count},...pages.map(page=>({page,dpi:null,blocking:false})),{complete:true}]);
  assert.equal(result.version,PDF_QUALITY_VERSION);assert.equal(result.status,'complete');
  assert.deepEqual(result.sampled_pages,pages);assert.equal(result.checked_pages,pages.length);
  assert.equal(auditPdfQualityState(result),'ready');
 }
 const low=await probe([{page_count:100},{page:5,dpi:144,blocking:true},{complete:true}]);
 assert.equal(low.status,'complete');assert.equal(low.checked_pages,1);assert.equal(auditPdfQualityState(low),'low');
 const warnings=await probe([{page_count:100},...pdfQualitySamplePages(100).map(page=>({page,dpi:150,blocking:false})),{complete:true}]);
 assert.equal(warnings.low_resolution_pages.length,8);assert.equal(auditPdfQualityState(warnings),'ready');
 const old=await probe([{page_count:1},{page:1,dpi:150},{complete:true}]);assert.notEqual(auditPdfQualityState(old),'ready');
 const prefix=[{page_count:100},{page:5,dpi:null,blocking:false}];
 for(const events of [prefix,[...prefix,{complete:true}],[...prefix,{page:5,dpi:null,blocking:false}],[...prefix,{page:2,dpi:null,blocking:false}],[...prefix,{unavailable:true},{complete:true}]]){
  const result=await probe(events);assert.notEqual(result.status,'complete');assert.notEqual(auditPdfQualityState(result),'ready');
 }
 const complete=[{page_count:100},...pdfQualitySamplePages(100).map(page=>({page,dpi:null,blocking:false})),{complete:true}];
 assert.notEqual((await probe([...complete,{complete:true}])).status,'complete','trailing output is rejected');
 assert.notEqual((await probe(complete,'raise RuntimeError("synthetic")')).status,'complete','nonzero exit is not a pass');
 await writeFile(join(directory,'__main__.py'),'import time\ntime.sleep(10)\n');
 const timed=await inspectPdfQuality('unused-synthetic-path',{pythonExecutable,repoRoot:root,timeoutMs:200});
 assert.equal(timed.status,'unavailable');assert.notEqual(auditPdfQualityState(timed),'ready');
});
