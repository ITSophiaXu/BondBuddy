import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deflateSync} from 'node:zlib';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDF_QUALITY_VERSION,schemas,readPdfQuality,auditPdfQualityState,pdfQualitySamplePages} from '/app/packages/contracts/dist/index.js';
const role=process.env.CANARY_ROLE;
test('new contract is v3 and samples at most eight pages',()=>{assert.equal(PDF_QUALITY_VERSION,'pdf-raster-quality-3');assert.ok(schemas.AuditPdfQualityCheckRequest);assert.deepEqual(pdfQualitySamplePages(1600),[5,8,12,1,400,800,1200,1600]);});
if(role==='confirmation'){
 const c=await import('/app/apps/api/dist/complete-upload.js'),j=await import('/app/apps/api/dist/material-jobs.js');test('independent upload confirmer imports new enqueue path',()=>{assert.equal(typeof c.completeStoredUpload,'function');assert.equal(typeof j.enqueueAuditPdfQuality,'function');});
}else if(role==='api'){
 const {createServer}=await import('/app/apps/api/dist/server.js');
 const {quoteCreditsExact}=await import('/app/apps/api/dist/billing.js');
 const {assertAuditPdfQuality}=await import('/app/apps/api/dist/audit-pdf-quality.js');
 const {enqueueAuditPdfQuality,requestAuditPdfQuality}=await import('/app/apps/api/dist/material-jobs.js');
 test('live API dependency graph and new endpoints import',()=>{for(const f of [createServer,quoteCreditsExact,enqueueAuditPdfQuality,requestAuditPdfQuality])assert.equal(typeof f,'function');});
 for(const [label,quality,state,pass] of [
  ['pending',undefined,'queued',false],['partial',{version:PDF_QUALITY_VERSION,status:'partial',page_count:100,checked_pages:1,sampled_pages:[5],low_resolution_pages:[]},'succeeded',false],
  ['low',{version:PDF_QUALITY_VERSION,status:'complete',page_count:100,checked_pages:1,sampled_pages:[5],low_resolution_pages:[{page:5,dpi:144}]},'succeeded',false],
  ['clear',{version:PDF_QUALITY_VERSION,status:'complete',page_count:100,checked_pages:8,sampled_pages:[5,8,12,1,25,50,75,100],low_resolution_pages:[]},'succeeded',true],
  ['v2',{version:'pdf-raster-quality-2',status:'complete',page_count:2,checked_pages:2,low_resolution_pages:[]},'succeeded',true]
 ])test('server gate '+label,async()=>{
  const client={query:async(sql,params)=>{assert.match(sql,/owner_user_id/);assert.match(sql,/material_sha256/);assert.deepEqual(params.slice(0,2),['synthetic-owner','synthetic-project']);return {rows:[{id:'audit',filename:'synthetic.pdf',state,checkpoint:{stages:{pdf_quality:quality}}}]};}};
  if(pass)await assertAuditPdfQuality(client,'synthetic-owner','synthetic-project',[]);
  else await assert.rejects(assertAuditPdfQuality(client,'synthetic-owner','synthetic-project',[]),e=>e.status===422&&e.code==='INPUT_REQUIRED'&&e.inputIssues[0].code==='AUDIT_PDF_QUALITY_REQUIRED');
 });
}else{
 const {spawnSync}=await import('node:child_process');const py=spawnSync('python3',['-c','import sys; print(sys.executable); import pypdfium2; print(pypdfium2.__file__)']);console.log(JSON.stringify({pythonExit:py.status,pythonStdout:py.stdout?.toString(),pythonStderr:py.stderr?.toString()}));
 const {runMaterialParseOnce}=await import('/app/apps/worker/dist/material-parse-job.js');
 const {inspectAuthorizedPdf}=await import('/app/apps/worker/dist/material-parser.js');
 const {inspectPdfQuality}=await import('/app/apps/worker/dist/pdf-quality.js');
 test('live parser dependency graph imports',()=>{assert.equal(typeof runMaterialParseOnce,'function');assert.equal(typeof inspectAuthorizedPdf,'function');});
 function rasterPdf(dpi,count){
  const width=1200,height=1600,image=deflateSync(Buffer.alloc(width*height,255));
  const content=Buffer.from('q '+width*72/dpi+' 0 0 '+height*72/dpi+' 0 0 cm /Im0 Do Q');
  const kids=Array.from({length:count},(_,i)=>(4+i*2)+' 0 R').join(' ');
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids ['+kids+'] /Count '+count+' >>'),Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width '+width+' /Height '+height+' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length '+image.length+' >>\nstream\n'),image,Buffer.from('\nendstream')])];
  for(let i=0;i<count;i++)objects.push(Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+width*72/dpi+' '+height*72/dpi+'] /Resources << /XObject << /Im0 3 0 R >> >> /Contents '+(5+i*2)+' 0 R >>'),Buffer.concat([Buffer.from('<< /Length '+content.length+' >>\nstream\n'),content,Buffer.from('\nendstream')]));
  let body=Buffer.from('%PDF-1.4\n% synthetic release canary\n');const offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(body.length);body=Buffer.concat([body,Buffer.from((i+1)+' 0 obj\n'),obj,Buffer.from('\nendobj\n')]);}const start=body.length,n=objects.length+1;
  return Buffer.concat([body,Buffer.from('xref\n0 '+n+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+n+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n')]);
 }
 for(const [dpi,count,checked,state]of [[144,120,1,'low'],[200,1600,8,'ready']])test('real PDFium '+count+' pages at '+dpi+' DPI',async()=>{
  const td=await mkdtemp(join(tmpdir(),'audit1610-'));try{const path=join(td,'synthetic.pdf');await writeFile(path,rasterPdf(dpi,count));const start=performance.now(),q=await inspectPdfQuality(path,{repoRoot:'/app'});console.log(JSON.stringify({synthetic:true,dpi,pages:count,checked:q.checked_pages,elapsed_ms:performance.now()-start}));assert.equal(q.status,'complete');assert.equal(q.checked_pages,checked);assert.equal(auditPdfQualityState(q),state);}finally{await rm(td,{recursive:true,force:true});}
 });
}
