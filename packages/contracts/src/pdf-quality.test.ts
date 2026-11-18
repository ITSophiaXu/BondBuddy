import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPdfQuality,PDF_QUALITY_VERSION,auditPdfQualityState,auditPdfQualityMessage,isAuditPdf} from './pdf-quality.js';
const quality = {version:'pdf-raster-quality-1',status:'partial',page_count:100,checked_pages:7,low_resolution_pages:[{page:7,dpi:144}]};
test('quality validates measured page coverage and rejects unknown/private fields',()=>{
  assert.deepEqual(readPdfQuality(quality),quality);
  for(const delta of [{status:'complete'},{checked_pages:101},{low_resolution_pages:[{page:8,dpi:144}]},{low_resolution_pages:[{page:7,dpi:144},{page:7,dpi:144}]},{low_resolution_pages:[{page:7,dpi:300}]},{path:'/private/customer.pdf'},{page_count:null}]) assert.equal(readPdfQuality({...quality,...delta}),undefined);
  assert.equal(readPdfQuality(undefined),undefined);
});


test('audit gate distinguishes measured low, incomplete, legacy and complete results',()=>{
 const full={...quality,version:PDF_QUALITY_VERSION,status:'complete',page_count:7,checked_pages:7};
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
