// Actual Word extraction, HTTP admission, PostgreSQL holds and delivery;
// in-memory private blobs and synthetic model proposals, no supplier spending.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {ZipFile} from 'yazl';
import {createServer} from '@bondbuddy/api';
import {AUTOMATIC_TASK_TARIFF} from '@bondbuddy/contracts';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {creditBalance,grantCredits} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {readBoundedOfficeParts} from '../../api/dist/docx-inspector.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage} from './run-pipeline.js';
import {projectFileModelStage,projectFileDeliveryStage} from './project-file-stage.js';
import {CodexDurableJournal} from './durable-probe-journal.js';

const database=await isolatedTestDatabase(undefined,'ordinary-file-paid-coverage');
async function targetDocument(image=false){
  const parts=new Map(readBoundedOfficeParts(makeSyntheticDocxFixture({text:'合成发行人总资产100万元。'}))),zip=new ZipFile(),chunks:Buffer[]=[];
  parts.set('word/header1.xml',Buffer.from('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>合成文件页眉</w:t></w:r></w:p></w:hdr>'));
  parts.set('word/document.xml',Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:sectPr/>','<w:sectPr><w:headerReference w:type="default" r:id="syntheticHeader"/></w:sectPr>')));
  parts.set('word/_rels/document.xml.rels',Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>','<Relationship Id="syntheticHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>')));
  parts.set('[Content_Types].xml',Buffer.from(parts.get('[Content_Types].xml')!.toString().replace('</Types>','<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'+(image?'<Default Extension="png" ContentType="image/png"/>':'')+'</Types>')));
  if(image)parts.set('word/media/synthetic.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHpsAAAAASUVORK5CYII=','base64'));
  const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
  for(const [name,bytes] of parts)zip.addBuffer(bytes,name);zip.end();return done;
}

test('ordinary paid checks release incomplete coverage and unverified replay, require real headers, and reject unread image content',
 {skip:!database,timeout:180000},async()=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID(),origin='https://synthetic-coverage.invalid',store=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>{const b=store.get(k);assert.ok(b);return b;},getIfExists:async k=>store.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=store.get(k);if(b&&b.length>n)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,enableSubscriptionBilling:true,enableOutcomePricing:true,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode} ${r.body}`);return r.json();};
  const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const upload=async(base:string,project:string,name:string,bytes:Buffer,role='other')=>{
    const declaration={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type:docx,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  let mode:'incomplete'|'replayed'|'complete'='incomplete',calls=0,replays=0;
  const model:typeof codexModelStage=options=>({name:options.name,run:async ctx=>{
    const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:options.validate});
    if(mode==='complete'){
      const prior=await journal.latestAttempt(options.logicalCallId);
      if(prior){const completed=await journal.readCompleted(options.logicalCallId,prior.attempt_no);assert.ok(completed);replays++;return {kind:'done',value:completed.value};}
    }
    calls++;
    const dir=await mkdtemp(join(tmpdir(),'bb-ordinary-check-model-'));
    try{
      await options.fileWorkspace!.prepare(dir);
      const source=JSON.parse(await readFile(join(dir,'source-spans.json'),'utf8')),target=JSON.parse(await readFile(join(dir,'target-spans.json'),'utf8'));
      assert.ok(target.spans.some((s:any)=>s.id==='header1-p0'&&s.text==='合成文件页眉'));
      if(mode==='replayed')return {kind:'done',value:{version:'project-file-check-v1',files:[{file_version_id:options.logicalCallId.slice('file-check-'.length),status:'manual',coverage:'尚未检查',findings:[],links:[]}]}};
      const sp=source.spans.find((s:any)=>s.text.includes('总资产')),tp=target.spans.find((s:any)=>s.text.includes('总资产'));
      await writeFile(join(dir,'output/check.json'),JSON.stringify({coverage:'Synthetic whole-file comparison',checked_span_ids:mode==='complete'?target.spans.map((s:any)=>s.id):[tp.id],findings:[],
        links:[{source_span_id:sp.id,source_quote:'合成发行人',target_span_id:tp.id,target_quote:'合成发行人',field:'主体',period:'',unit:''}]}));
      const value=await options.fileWorkspace!.collect(dir,{} as any,{text:'Synthetic only'});
      if(mode==='complete'){
        // Exactly reproduce loss after the adapter's completed observation and
        // before projectFileModelStage regains control. Its replay skips collect.
        const version=Number((await pool.query("SELECT COALESCE(max(version),0)+1 AS n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",[owner,ctx.run.project_id])).rows[0].n);
        const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',version,body:await options.buildPrompt(ctx),inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:options.templateVersion});
        const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,logical_call_id:options.logicalCallId,
          call_id:randomUUID(),attempt_no:1,model_id:'synthetic-files-model',model_config_version:'synthetic-v1',prompt_snapshot_ref:snapshot};
        await journal.recordIntent(intent);
        const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),options.resultSchemaVersion);
        await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage:{status:'measured',input_tokens:100,cached_input_tokens:0,output_tokens:10,reasoning_tokens:0,total_tokens:110},error_code:null});
        throw Error('SYNTHETIC_CRASH_AFTER_COMPLETED_CHECK');
      }
      return {kind:'done',value};
    }finally{await rm(dir,{recursive:true,force:true});}
  }});
  const fileStage=projectFileModelStage({model});
  const replayStage={...fileStage,run:async(ctx:Parameters<typeof fileStage.run>[0])=>{
    try{return await fileStage.run(ctx);}catch(error){
      if(!(error instanceof Error)||error.message!=='SYNTHETIC_CRASH_AFTER_COMPLETED_CHECK')throw error;
      return fileStage.run({...ctx,checkpoint:{}});
    }
  }};
  const execute=()=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,replayStage,projectFileDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'coverage_'+owner.slice(0,8)]);
    const initial=5*AUTOMATIC_TASK_TARIFF.check.points;await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:initial,expiresAt:null,actor:'synthetic',reason:'Synthetic coverage test'}));
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic ordinary paid check',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),base='/api/v1/projects/'+p.project_id,files=base+'/project-files';
    await upload(base,p.project_id,'source.docx',makeSyntheticDocxFixture({text:'合成发行人总资产100万元。'}),'historical');
    const versions=await ok('GET',base+'/prospectus-versions'),source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const target=await upload(base,p.project_id,'target.docx',await targetDocument());
    const imported=await ok('POST',files+'/imports',{request_id:randomUUID(),document_type:'init',material:target,expected_latest_version_id:null});
    let version=imported.files.find((f:any)=>f.latest).version_id;
    const start=async()=>{
      const request={request_id:randomUUID(),expected_source_version_id:source.current_version_id,file_version_ids:[version]},quote=await ok('POST',files+'/checks/quote',request);
      assert.equal(quote.points,AUTOMATIC_TASK_TARIFF.check.points);
      return (await ok('POST',files+'/checks',{...request,expected_points:quote.points,price_version:quote.price_version,scope_quote_id:quote.scope_quote_id})).run_id as string;
    };
    for(const selected of ['incomplete','replayed'] as const){
      mode=selected;const run=await start();assert.equal(await execute(),'failed');
      assert.deepEqual(await creditBalance(pool,owner),{available:initial,frozen:0});
      assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1',[run])).rows[0].state,'released');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_file_check_evidence WHERE run_id=$1',[run])).rows[0].n,0);
    }
    mode='complete';const good=await start();assert.equal(await execute(),'succeeded');
    assert.equal(replays,1,'completed durable model result resumes without another collect or charge');
    const e=(await pool.query('SELECT checked_spans,total_spans FROM bb_project_file_check_evidence WHERE run_id=$1',[good])).rows[0];assert.deepEqual(e,{checked_spans:2,total_spans:2});
    assert.deepEqual(await creditBalance(pool,owner),{available:initial-AUTOMATIC_TASK_TARIFF.check.points,frozen:0});
    await assert.rejects(pool.query('UPDATE bb_project_file_check_evidence SET checked_spans=checked_spans WHERE run_id=$1',[good]),/immutable/);
    const image=await upload(base,p.project_id,'unread-image.docx',await targetDocument(true)),changed=await ok('POST',files+'/imports',{request_id:randomUUID(),document_type:'init',material:image,expected_latest_version_id:version});
    version=changed.files.find((f:any)=>f.latest).version_id;
    const unread=await start(),beforeCalls=calls;assert.equal(await execute(),'failed');assert.equal(calls,beforeCalls,'unread content fails before model spending');
    assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1',[unread])).rows[0].state,'released');
    assert.deepEqual(await creditBalance(pool,owner),{available:initial-AUTOMATIC_TASK_TARIFF.check.points,frozen:0});
  }finally{await app.close();await pool.end();}
});
