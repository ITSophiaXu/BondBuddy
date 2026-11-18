import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPdfQuality,PDF_QUALITY_VERSION,auditPdfQualityState,auditPdfQualityMessage,isAuditPdf,pdfQualitySamplePages,isPdfQualityJobVersion} from './pdf-quality.js';
const quality = {version:'pdf-raster-quality-1',status:'partial',page_count:100,checked_pages:7,low_resolution_pages:[{page:7,dpi:144}]};
test('quality validates measured page coverage and rejects unknown/private fields',()=>{
  assert.deepEqual(readPdfQuality(quality),quality);
  for(const delta of [{status:'complete'},{checked_pages:101},{low_resolution_pages:[{page:8,dpi:144}]},{low_resolution_pages:[{page:7,dpi:144},{page:7,dpi:144}]},{low_resolution_pages:[{page:7,dpi:300}]},{path:'/private/customer.pdf'},{page_count:null}]) assert.equal(readPdfQuality({...quality,...delta}),undefined);
  assert.equal(readPdfQuality(undefined),undefined);
});


test('audit gate distinguishes measured low, incomplete, legacy and complete results',()=>{
 const full={...quality,version:'pdf-raster-quality-2',status:'complete',page_count:7,checked_pages:7};
 assert.equal(auditPdfQualityState(quality),'pending','legacy advisory cannot become a hard rejection');
 assert.equal(auditPdfQualityState({...full,low_resolution_pages:[]}),'ready');
 assert.equal(auditPdfQualityState(full),'low');
 assert.equal(auditPdfQualityState({...full,status:'partial'}),'low');
 assert.equal(auditPdfQualityState({...full,status:'partial',low_resolution_pages:[]}),'incomplete');
 assert.equal(auditPdfQualityState(undefined),'pending');
 assert.equal(auditPdfQualityState({...full,version:'untrusted'}),'pending');
 assert.match(auditPdfQualityMessage(full),/重新上传清晰的电子版/);
 assert.equal(isAuditPdf({role:'audit',media_type:'application/pdf'}),true);
 assert.equal(isAuditPdf({role:'financial',media_type:'application/pdf'}),false);
 assert.equal(isAuditPdf({role:'audit',media_type:'image/png'}),false);
});

test('sample completion validates exact visited pages, early low and incomplete prefixes',()=>{
 const full={version:PDF_QUALITY_VERSION,status:'complete',page_count:100,checked_pages:8,sampled_pages:pdfQualitySamplePages(100),low_resolution_pages:[]};
 assert.equal(auditPdfQualityState(full),'ready');
 const low={...full,checked_pages:2,sampled_pages:[5,8],low_resolution_pages:[{page:8,dpi:144}]};
 assert.equal(auditPdfQualityState(low),'low');
 assert.equal(auditPdfQualityState({...low,status:'partial'}),'low');
 assert.equal(auditPdfQualityState({...low,status:'partial',low_resolution_pages:[]}),'incomplete');
 for(const delta of [{sampled_pages:undefined},{sampled_pages:[5]},{checked_pages:1,sampled_pages:[5]},{sampled_pages:[1,5,8,12,25,50,75,100]},{low_resolution_pages:[{page:2,dpi:144}]},{sampled_pages:[5,8,12,1,25,50,75,75]}]) assert.equal(readPdfQuality({...full,...delta}),undefined);
 assert.equal(readPdfQuality({...low,checked_pages:3,sampled_pages:[5,8,12]}),undefined,'no continuing past the first low page');
 assert.equal(readPdfQuality({...full,version:'pdf-raster-quality-2'}),undefined,'legacy full cannot claim sample coverage');
 assert.equal(isPdfQualityJobVersion('pdf-raster-quality-2:retry:old'),true);
 assert.equal(isPdfQualityJobVersion(PDF_QUALITY_VERSION+':retry:new'),true);
 assert.equal(isPdfQualityJobVersion('pdf-raster-quality-1'),false);
});
test('sample count is bounded and page indices may exceed old full-scan cap',()=>{
 for(const count of [1,8,9,12,100,1501,100000]){
  const sampled_pages=pdfQualitySamplePages(count);
  assert.ok(sampled_pages.length<=8);assert.equal(new Set(sampled_pages).size,sampled_pages.length);
  assert.ok(readPdfQuality({version:PDF_QUALITY_VERSION,status:'complete',page_count:count,checked_pages:sampled_pages.length,sampled_pages,low_resolution_pages:[]}));
 }
 assert.deepEqual(pdfQualitySamplePages(100),[5,8,12,1,25,50,75,100]);
});
