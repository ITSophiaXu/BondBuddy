import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {emptyUpdateDetails, INITIAL_FIXED_PRICES, PDF_QUALITY_VERSION} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {azureBlobs,digest,transaction} from './data.js';
import {uploadSyntheticReference,uploadSyntheticAudit} from './test-authoring-source.js';
import {grantCredits,publishPrices} from './billing.js';
import {enqueueMaterialParse,claimMaterialParse,completeMaterialParseStage,releaseMaterialParse} from './material-jobs.js';

// Synthetic image pixels, actual PDF bytes, HTTP upload, PostgreSQL, Azurite and PDFium.
function rasterPdf(dpi:number,tag='sample',pageCount=1) {
  const width=1200,height=1600, image=deflateSync(Buffer.alloc(width*height,255));
  const content=Buffer.from('q '+width*72/dpi+' 0 0 '+height*72/dpi+' 0 0 cm /Im0 Do Q');
  const kids=Array.from({length:pageCount},(_,i)=>(4+i*2)+' 0 R').join(' ');
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids ['+kids+'] /Count '+pageCount+' >>'),
    Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width '+width+' /Height '+height+' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length '+image.length+' >>\nstream\n'),image,Buffer.from('\nendstream')])];
  for(let i=0;i<pageCount;i++) objects.push(
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+width*72/dpi+' '+height*72/dpi+'] /Resources << /XObject << /Im0 3 0 R >> >> /Contents '+(5+i*2)+' 0 R >>'),
    Buffer.concat([Buffer.from('<< /Length '+content.length+' >>\nstream\n'),content,Buffer.from('\nendstream')]));
  let body=Buffer.from('%PDF-1.4\n% synthetic '+tag+'\n');const offsets=[0];
  for(const [i,obj] of objects.entries()){offsets.push(body.length);body=Buffer.concat([body,Buffer.from((i+1)+' 0 obj\n'),obj,Buffer.from('\nendobj\n')]);}
  const start=body.length,count=objects.length+1;return Buffer.concat([body,Buffer.from('xref\n0 '+count+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+count+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n')]);
}

const connection=await isolatedTestDatabase(undefined,'audit-pdf-quality');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('audit PDF gate: actual upload, isolated inspection, no-charge rejection, replacement, retries and replay', {skip:!connection||!storage,timeout:180000}, async t=>{
  const pool=new Pool({connectionString:connection}), user=randomUUID(),origin='http://bondbuddy.test';let owner=user;
  const container='bb-quality-'+randomUUID().replaceAll('-',''),blobs=azureBlobs(storage!,container);
  const app=createServer({pool,blobs,historicalBillingFixture:true,enablePaidAuthoring:true,enableSyntheticQueue:true,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  // Runtime import avoids making the API production package depend on worker code.
  const worker=await import(new URL('../../worker/dist/material-parse-job.js',import.meta.url).href);
  const deps={pool,leaseSeconds:60,material:{pool,blobs:{getPrivate:(key:string)=>blobs.getIfExists(key)},parser:async()=>{throw Error('must not parse');}},ocr:async()=>{throw Error('must not OCR');}};
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.body?r.json():null;};
  const reject=(r:Awaited<ReturnType<typeof send>>,text:RegExp)=>{assert.equal(r.statusCode,422,r.body);assert.equal(r.json().field_errors[0].code,'AUDIT_PDF_QUALITY_REQUIRED');assert.match(r.body,text);};
  const create=(kind='update')=>ok('POST','/api/v1/projects',{name:'Synthetic quality gate',kind,issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
  const upload=async(id:string,bytes:Buffer,role='audit')=>{
    const path='/api/v1/projects/'+id,meta={byte_size:bytes.length,sha256:digest(bytes)};
    const session=await ok('POST',path+'/materials/uploads',{...meta,filename:'synthetic-'+role+'.pdf',media_type:'application/pdf',role});
    await ok('PUT',session.upload_url,bytes);return ok('POST',path+'/materials/uploads/'+session.upload_id+'/complete',meta);
  };
  const counts=async()=>Promise.all(['bb_runs','bb_credit_reservations','bb_credit_quotes'].map(async table=>(await pool.query('SELECT count(*)::int n FROM '+table+' WHERE owner_user_id=$1',[user])).rows[0].n));
  try{
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)',[user,'+8613999911028']);
    await publishPrices(pool,{id:'synthetic-quality-v1',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'test only'});
    await transaction(pool,c=>grantCredits(c,{owner:user,points:100000,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic',reason:'test only'}));
    const project=await create(),id=project.project_id,path='/api/v1/projects/'+id,base=await uploadSyntheticReference(app,id);
    const refs=[...base.material_versions];
    const lock=async()=>send('POST',path+'/input-revisions',{...base,draft_revision:(await ok('GET',path)).draft_revision,material_versions:refs});
    const low=await upload(id,rasterPdf(144,'long-low',120));refs.push({material_id:low.material_id,material_version:1});
    const qualityPath=path+'/materials/'+low.material_id+'/pdf-quality';
    await t.test('pending and measured low PDF block; polling is idempotent and owner-scoped',async()=>{
      const jobs=await pool.query('SELECT * FROM bb_jobs WHERE project_id=$1',[id]);assert.equal(jobs.rowCount,1);assert.equal(jobs.rows[0].parser_version,PDF_QUALITY_VERSION);
      const views=await Promise.all(Array.from({length:5},()=>ok('POST',qualityPath,{})));assert.equal(new Set(views.map(v=>v.job_id)).size,1);
      owner=randomUUID();assert.equal((await send('POST',qualityPath,{})).statusCode,404);owner=user;
      reject(await lock(),/正在检查/);assert.deepEqual(await counts(),[0,0,0]);
      assert.equal(await worker.runMaterialParseOnce(deps),'succeeded');const view=await ok('POST',qualityPath,{});
      assert.equal(view.outcome,null);assert.deepEqual(view.completed_stages,[]);assert.deepEqual(view.pdf_quality.low_resolution_pages,[{page:5,dpi:144}]);assert.equal(view.pdf_quality.page_count,120);assert.equal(view.pdf_quality.checked_pages,1);assert.deepEqual(view.pdf_quality.sampled_pages,[5]);
      reject(await lock(),/清晰度太低/);
      // A caller cannot hide a bad PDF by selecting a different audit attachment.
      const textAudit=await uploadSyntheticAudit(app,id);refs.splice(1,1,textAudit);reject(await lock(),/清晰度太低/);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_parse_snapshots WHERE project_id=$1',[id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1',[id])).rows[0].n,0);
    });
    let input:any,request:any,run:any;
    await t.test('delete/replace with 200 DPI restores lock, quote and execution; new bad upload cannot bypass saved input',async()=>{
      await ok('DELETE',path+'/materials/'+low.material_id);
      const clear=await upload(id,rasterPdf(200,'long-clear',1600));refs.push({material_id:clear.material_id,material_version:1});
      reject(await lock(),/正在检查/);assert.equal(await worker.runMaterialParseOnce(deps),'succeeded');
      const view=await ok('POST',path+'/materials/'+clear.material_id+'/pdf-quality',{});assert.deepEqual(view.pdf_quality.low_resolution_pages,[]);assert.equal(view.pdf_quality.checked_pages,8);assert.deepEqual(view.pdf_quality.sampled_pages,[5,8,12,1,400,800,1200,1600]);
      const locked=await lock();assert.equal(locked.statusCode,201,locked.body);input=locked.json();
      const quote=await ok('POST',path+'/credit-quote',{input_revision:input.input_revision,input_hash:input.input_hash});
      request={execution_request_id:randomUUID(),project_id:id,input_revision:input.input_revision,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:input.input_hash,storage_origin:'cloud',workspace_id:id,quote_id:quote.quote.quote_id};
      run=await ok('POST','/api/v1/runs/execute',request);await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[run.run_id]);
      const another=await upload(id,rasterPdf(96,'another'));assert.equal(await worker.runMaterialParseOnce(deps),'succeeded');
      const before=await counts();reject(await send('POST',path+'/credit-quote',{input_revision:input.input_revision,input_hash:input.input_hash}),/清晰度太低/);
      reject(await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()}),/清晰度太低/);assert.deepEqual(await counts(),before);
      assert.equal((await ok('POST','/api/v1/runs/execute',request)).run_id,run.run_id,'existing execution replay keeps original semantics');
      await ok('DELETE',path+'/materials/'+another.material_id);
    });
    await t.test('incomplete and failed inspections preserve receipts; explicit concurrent retry creates one new attempt',async()=>{
      const uncertain=await upload(id,rasterPdf(300,'retry')),route=path+'/materials/'+uncertain.material_id+'/pdf-quality';
      assert.equal(await worker.runMaterialParseOnce({...deps,pdfQualityInspector:async()=>({version:PDF_QUALITY_VERSION,status:'partial',page_count:2,checked_pages:1,sampled_pages:[1],low_resolution_pages:[]})}),'succeeded');
      const old=await ok('POST',route,{});reject(await lock(),/检查未完成/);
      const retries=await Promise.all(Array.from({length:4},()=>ok('POST',route,{retry:true})));assert.equal(new Set(retries.map(v=>v.job_id)).size,1);assert.notEqual(retries[0].job_id,old.job_id);
      assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[old.job_id])).rows[0].checkpoint.stages.pdf_quality,old.pdf_quality);
      // Byte tampering is rejected before the inspector; retry never trusts that receipt.
      const meta=(await pool.query('SELECT object_key FROM bb_material_versions WHERE id=$1',[uncertain.material_id])).rows[0];
      const original=await blobs.get(meta.object_key);await blobs.put(meta.object_key,Buffer.from('tampered'),'application/pdf');
      assert.equal(await worker.runMaterialParseOnce(deps),'failed');const failed=await ok('POST',route,{});assert.equal(failed.error_code,'MATERIAL_CONTENT_MISMATCH');reject(await lock(),/检查未完成/);
      await blobs.put(meta.object_key,original,'application/pdf');await ok('POST',route,{retry:true});assert.equal(await worker.runMaterialParseOnce(deps),'succeeded');
      assert.equal((await ok('POST',route,{})).pdf_quality.status,'complete');
      assert.equal((await pool.query('SELECT state FROM bb_jobs WHERE id=$1',[failed.job_id])).rows[0].state,'failed');
      const successful=await lock();assert.equal(successful.statusCode,201,successful.body);
    });
    await t.test('v2 checkpoint is reused without downloading or inspecting the same file again',async()=>{
      const legacy=await upload(id,rasterPdf(200,'legacy')),route=path+'/materials/'+legacy.material_id+'/pdf-quality';
      // Finish the current producer's auto-job and create a legacy fixture through its original enqueue contract.
      // Immutable parser bindings must never be edited, including in tests.
      assert.equal(await worker.runMaterialParseOnce(deps),'succeeded');
      const {jobId:prior}=await transaction(pool,c=>enqueueMaterialParse(c,{owner:user,projectId:id,materialId:legacy.material_id,materialVersion:1,sha256:legacy.sha256,traceId:randomUUID(),parserVersion:'pdf-raster-quality-2'}));
      const quality={version:'pdf-raster-quality-2',status:'complete',page_count:1,checked_pages:1,low_resolution_pages:[]};
      const lease=await claimMaterialParse(pool);assert.equal(lease!.jobId,prior);
      await completeMaterialParseStage(pool,lease!,'pdf_quality',quality);
      await releaseMaterialParse(pool,lease!);
      const before=await ok('POST',route,{});assert.equal(before.job_id,prior);assert.deepEqual(before.pdf_quality,quality);
      assert.equal(await worker.runMaterialParseOnce({...deps,pdfQualityInspector:async()=>{throw Error('must reuse v2');}}),'succeeded');
      assert.equal((await ok('POST',route,{})).job_id,prior);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE material_id=$1',[legacy.material_id])).rows[0].n,2);
      const locked=await lock();assert.equal(locked.statusCode,201,locked.body);
      await ok('DELETE',path+'/materials/'+legacy.material_id);
    });
    await t.test('other task/role scope remains unchanged and copied audits receive their own inspection',async()=>{
      const review=await create('review'),m=await upload(review.project_id,rasterPdf(96,'review'));
      assert.equal((await send('POST','/api/v1/projects/'+review.project_id+'/materials/'+m.material_id+'/pdf-quality',{})).statusCode,422);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE project_id=$1',[review.project_id])).rows[0].n,0);
      const financial=await upload(id,rasterPdf(96,'financial'),'financial');assert.equal((await send('POST',path+'/materials/'+financial.material_id+'/pdf-quality',{})).statusCode,422);
      const copied=await ok('POST','/api/v1/projects/'+review.project_id+'/update-workspace',{});
      assert.equal((await pool.query('SELECT parser_version FROM bb_jobs WHERE project_id=$1',[copied.update_project_id])).rows[0].parser_version,PDF_QUALITY_VERSION);
    });
  }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
