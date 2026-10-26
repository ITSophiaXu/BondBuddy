// Synthetic search provider; actual API, database, billing, queue, blob storage and Word delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from '@bondbuddy/api';
import {azureBlobs,digest,transaction} from '@bondbuddy/api/data';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {INTEGRITY_PRICE,INTEGRITY_SELECTABLE_SITES,type IntegrityInput} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {CodexDurableJournal} from './durable-probe-journal.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,codexModelStage} from './run-pipeline.js';
import {integrityModelStage,integrityDeliveryStage} from './integrity-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {chromium} from 'playwright';
import {collectInContext} from './integrity-browser.js';
import {integrityWebsiteFixture} from './integrity-browser-fixture.js';

const database=await isolatedTestDatabase(undefined,'integrity-e2e'),storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('integrity E2E: saved scope, paid round, evidence, free exports, archive, replay, cancellation and isolation',
 {skip:!database||!storage||!process.env.BONDBUDDY_TEST_PYTHON||!process.env.BB_TEST_INTEGRITY_BROWSER,timeout:300000},async()=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),other=randomUUID(),container='bb-integrity-'+randomUUID().replaceAll('-','');let actor=owner,calls=0,searchEnabled=true;
 const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';
 const app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
 const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.body?r.json():null;};
 let firstPause=true;
 const model:typeof codexModelStage=o=>({name:o.name,replay:true,run:async ctx=>{
  if(firstPause){firstPause=false;return {kind:'pause',stage:'user_paused',reason:'synthetic pause after durable browser capture'};}
  const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
  // Exercise the real prompt snapshot/checkpoint path before substituting the provider.
  // A hyphenated stage name used to fail here, before any search or model attempt.
  const boundary=new Error('synthetic provider boundary reached');
  await assert.rejects(codexModelStage({...o,config:()=>{throw boundary;}}).run(ctx),error=>error===boundary);
  assert.ok(ctx.checkpoint[`${o.name}_prompt`]?.snapshot_id,'real prompt checkpoint persisted');
  const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:o.validate}),old=await journal.latestAttempt(o.logicalCallId);
  if(old){const saved=await journal.readCompleted(o.logicalCallId,old.attempt_no);assert.ok(saved);return {kind:'done',value:saved.value};}
  const prompt=await o.buildPrompt(ctx);assert.ok(!prompt.includes('123456789012345678'),'private identity not sent to public search');
  const version=Number((await pool.query("SELECT coalesce(max(version),0)+1 n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",[owner,ctx.run.project_id])).rows[0].n);
  const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',version,body:prompt,inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:o.templateVersion});
  const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,logical_call_id:o.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:'synthetic-integrity',model_config_version:'synthetic-v1',prompt_snapshot_ref:snapshot};
  await journal.recordIntent(intent);calls++;
  if(['integrity-browser-interpretation-v1','integrity-browser-assessment-v2'].includes(o.resultSchemaVersion)){
   const captures=(await pool.query('SELECT c.* FROM bb_integrity_browser_captures c WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id',[owner,ctx.run.id])).rows;
   const current=captures.find(c=>'integrity_browser_'+inputManifestHash({subject:c.subject_id,site:c.site_id}).slice(0,24)===o.logicalCallId)!;
   const text=(await blobs.get(current.text_key)).toString('utf8');
   const value={summary:'Synthetic model interpretation',findings:[{capture_id:current.id,quote:text.includes('被要求补充材料')?text.slice(text.indexOf('查询结果')):text,explanation:'合成记录显示被要求补充材料，不能据此认定存在违法失信。',...(o.resultSchemaVersion==='integrity-browser-assessment-v2'?{title:'申报事项：被要求补充材料',nature:'information',subject_match:'unconfirmed'}:{})}]};
   assert.ok(o.validate(value));
   assert.equal(o.validate({summary:'forged',findings:[{capture_id:current.id,quote:'未出现的伪造引用',explanation:'forged'}]}),false,'model cannot cite invented evidence');
   const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),o.resultSchemaVersion);
   await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage:{status:'measured',input_tokens:100,cached_input_tokens:0,output_tokens:20,reasoning_tokens:0,total_tokens:120},error_code:null});
   return {kind:'done',value};
  }
  const input=(await pool.query('SELECT manifest FROM bb_integrity_runs WHERE run_id=$1',[ctx.run.id])).rows[0].manifest as IntegrityInput,subject=input.draft.subjects.find(s=>'integrity-'+inputManifestHash(s.id).slice(0,24)===o.logicalCallId)!;
  const query=subject.name+' site:'+ (subject.kind==='company'?'www.gsxt.gov.cn':'zxgk.court.gov.cn'),url='https://'+(subject.kind==='company'?'www.gsxt.gov.cn':'zxgk.court.gov.cn')+'/synthetic',quote=subject.name+' synthetic public record';
  await journal.recordWebSearchEvents(intent,searchEnabled?[{observed_at:new Date().toISOString(),item:{type:'web_search',id:'synthetic-tool',action:{type:'search',query},results:[{url,title:'Synthetic',text:quote}]}}]:[]);
  const value={sites:input.draft.site_ids.filter(site=>subject.kind==='company'||site!=='gsxt').map(site_id=>({site_id,note:'Synthetic response; no actual external website queried',sources:site_id===(subject.kind==='company'?'gsxt':'execution')&&searchEnabled?[{url,quote}]:[]}))};
  assert.ok(o.validate(value),'synthetic provider obeys response contract');
  const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),o.resultSchemaVersion);
  await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage:{status:'measured',input_tokens:100,cached_input_tokens:0,output_tokens:20,reasoning_tokens:0,total_tokens:120},error_code:null});
  return {kind:'done',value};
 }});
 const browser=await chromium.launch({headless:true});let browserCalls=0;
 const stage=integrityModelStage({model,config:()=>loadCodexAdapterConfig({}),collector:async(site,subject,signal)=>{
  assert.ok(!('identifier' in subject),'private identifier excluded from browser');browserCalls++;
  if(!searchEnabled)return {query:'',search_performed:false,outcome:'failed',scope:'Synthetic unavailable',limitation:'Synthetic only',reason:'未取得查询记录',captures:[]};
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await integrityWebsiteFixture(context,subject.kind==='company'&&site.id==='execution'?'failure':'hits');
  try{const collection=await collectInContext(context,site,subject,signal,{waitMs:5000,maxPages:1});
   // Simulate one pre-upgrade immutable batch alongside new v2 batches, including pause/resume replay.
   if(subject.kind==='company'&&site.id==='gsxt')delete collection.diagnostic;
   return collection;
  }finally{await context.close();}
 }});
 const execute=()=>runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,stage,integrityDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
 try{
  for(const id of [owner,other])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'integrity_'+id.slice(0,8)]);
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:20000,expiresAt:null,actor:'synthetic',reason:'integrity test'}));
  const scopeProject=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic expanded scope',issuer_name:'Synthetic issuer',market:'sse',offering:'private'});
  const scopeBase='/api/v1/projects/'+scopeProject.project_id+'/integrity';
  assert.deepEqual((await ok('GET',scopeBase)).draft.site_ids,[],'new projects start with no silently selected sites');
  const allSites=INTEGRITY_SELECTABLE_SITES.map(s=>s.id);
  await ok('POST',scopeBase+'/draft',{expected_revision:0,draft:{subjects:[],site_ids:allSites,notes:''}});
  assert.deepEqual((await ok('GET',scopeBase)).draft.site_ids,allSites,'all 54 sites survive API validation and reload');
  assert.equal((await send('POST',scopeBase+'/draft',{expected_revision:1,draft:{subjects:[],site_ids:['unknown-site'],notes:''}})).statusCode,422);
  assert.deepEqual(await creditBalance(pool,owner),{available:20000,frozen:0},'selecting sites is free');
  const project=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic integrity project',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),id=project.project_id,path='/api/v1/projects/'+id,base=path+'/integrity';
  const draft={subjects:[{id:'subject',kind:'company',name:'合成诚信测试企业',identifier:'123456789012345678',role:'发行人',province:'广东',city:'深圳市'},{id:'person',kind:'person',name:'合成测试人员',identifier:'123456789012345678',role:'董事',province:'',city:''}],site_ids:['gsxt','execution'],notes:'Synthetic only'};
  let w=await ok('GET',base);assert.equal(w.price.points,5000);assert.equal(w.revision,0);
  w=await ok('POST',base+'/draft',{expected_revision:0,draft});assert.equal(w.revision,1);
  assert.equal((await send('POST',base+'/draft',{expected_revision:0,draft})).statusCode,409);
  const request={request_id:randomUUID(),expected_revision:1,price_version:INTEGRITY_PRICE.version,expected_points:5000};
  assert.equal((await send('POST',base+'/runs',{...request,expected_points:1})).statusCode,422);
  const run=await ok('POST',base+'/runs',request);assert.equal((await ok('POST',base+'/runs',request)).run_id,run.run_id);
  assert.deepEqual(await creditBalance(pool,owner),{available:15000,frozen:5000});
  assert.equal((await send('POST',base+'/runs',{...request,request_id:randomUUID()})).statusCode,409);
  actor=other;assert.equal((await send('GET',base)).statusCode,404);actor=owner;
  assert.equal(await execute(),'paused');assert.equal(browserCalls,1);assert.equal(calls,0);
  assert.equal((await pool.query('SELECT count(*) n FROM bb_integrity_browser_batches WHERE run_id=$1',[run.run_id])).rows[0].n,'1');
  await ok('POST','/api/v1/runs/'+run.run_id+'/resume',{reason:'synthetic resume'});
  assert.equal(await execute(),'succeeded');assert.equal(calls,2);
  assert.deepEqual(await creditBalance(pool,owner),{available:15000,frozen:0});
  w=await ok('GET',base);const checked=w.rounds[0];assert.equal(checked.charged_points,5000);assert.equal(checked.artifacts.length,2);assert.equal(checked.records.length,4);assert.equal(checked.records.find((r:any)=>r.subject_id==='subject'&&r.site_id==='gsxt').status,'public_matches');assert.equal(checked.records.find((r:any)=>r.subject_id==='subject'&&r.site_id==='execution').status,'query_failed');
  assert.equal(browserCalls,3,'one collection per applicable subject/site');
  const capture=checked.records.find((r:any)=>r.subject_id==='subject'&&r.site_id==='gsxt').browser.captures[0];
  const captureUrl=base+'/runs/'+run.run_id+'/captures/'+capture.id;
  const screenshot=await send('GET',captureUrl);assert.equal(screenshot.statusCode,200);assert.equal(digest(screenshot.rawPayload),capture.screenshot_sha256);
  actor=other;assert.equal((await send('GET',captureUrl)).statusCode,404);actor=owner;
  const captureKey=(await pool.query('SELECT screenshot_key FROM bb_integrity_browser_captures WHERE id=$1',[capture.id])).rows[0].screenshot_key;
  await blobs.put(captureKey,Buffer.from('corrupted synthetic screenshot'),'image/png');
  assert.equal((await send('GET',captureUrl)).statusCode,409,'tampered bytes are not downloaded');
  await blobs.put(captureKey,screenshot.rawPayload,'image/png');
  assert.equal((await send('GET',scopeBase+'/runs/'+run.run_id+'/captures/'+capture.id)).statusCode,404,'same owner cannot cross project boundary');
  await assert.rejects(pool.query("UPDATE bb_integrity_browser_batches SET payload='{}' WHERE run_id=$1",[run.run_id]),/immutable/);
  const artifact=await ok('GET','/api/v1/artifacts/'+checked.artifact_id);assert.match(artifact.filename,/诚信核查底稿/);
  const documents=async(round:any,label:string)=>{
   for(const a of round.artifacts){
    const meta=await ok('GET','/api/v1/artifacts/'+a.artifact_id),download=await send('GET',meta.download_url);
    assert.equal(download.statusCode,200);assert.equal(digest(download.rawPayload),meta.sha256);
    const text=execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','import sys,io,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print("".join(E.fromstring(z.read("word/document.xml")).itertext()))'],{input:download.rawPayload,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    assert.match(text,/的签字页/);assert.match(text,/公开搜索不替代/);
    if(a.kind==='company'){assert.match(text,/合成诚信测试企业/);assert.ok(!text.includes('合成测试人员'));}
    else{assert.match(text,/合成测试人员/);assert.ok(!text.includes('合成诚信测试企业'));assert.ok(!text.includes('123456789012345678'));assert.match(text,/\*\*\*\*5678/);}
    if(label==='supplemented'&&a.kind==='company'){assert.match(text,/Synthetic manual claim/);assert.match(text,/用户提交，未独立核验/);}
    if(process.env.BB_INTEGRITY_TEST_OUTPUT_DIRECTORY){await mkdir(process.env.BB_INTEGRITY_TEST_OUTPUT_DIRECTORY,{recursive:true});await writeFile(join(process.env.BB_INTEGRITY_TEST_OUTPUT_DIRECTORY,`synthetic-${label}-${a.kind}.docx`),download.rawPayload);}
    actor=other;try{assert.equal((await send('GET',meta.download_url)).statusCode,404);}finally{actor=owner;}
   }
  };
  await documents(checked,'original');
  const files=await ok('GET',path+'/files');assert.ok(files.items.some((f:any)=>f.folder==='4.3'&&f.file_id===checked.artifact_id));
  const tasks=await ok('GET',path+'/tasks');assert.equal(tasks.items[0].operation,'integrity_check');
  const history=await ok('GET','/api/v1/credits/consumption-history');assert.equal(history.items[0].task_name,'诚信核查');
  const bytes=makeSyntheticDocxFixture({text:'Synthetic manual evidence; test only'}),declaration={byte_size:bytes.length,sha256:digest(bytes)};
  const upload=await ok('POST',path+'/materials/uploads',{...declaration,filename:'manual-evidence.docx',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'other'});
  assert.equal((await send('PUT',upload.upload_url,bytes)).statusCode,204);const m=await ok('POST',path+'/materials/uploads/'+upload.upload_id+'/complete',declaration);
  const evidence={request_id:randomUUID(),subject_id:'subject',site_id:'execution',queried_at:new Date().toISOString(),url:'https://zxgk.court.gov.cn/',note:'Synthetic manual claim; no live website query',conclusion:'unresolved',material:{source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256}};
  assert.equal((await send('POST',base+'/runs/'+run.run_id+'/evidence',{...evidence,url:'https://evil.test'})).statusCode,422);
  w=await ok('POST',base+'/runs/'+run.run_id+'/evidence',evidence);w=await ok('POST',base+'/runs/'+run.run_id+'/evidence',evidence);assert.equal(w.rounds[0].evidence.length,1);
  const exportRequest={request_id:randomUUID(),expected_evidence_ids:w.rounds[0].evidence.map((e:any)=>e.id)};
  assert.equal((await send('POST',base+'/runs/'+run.run_id+'/exports',{...exportRequest,expected_evidence_ids:[]})).statusCode,409);
  const exported=await ok('POST',base+'/runs/'+run.run_id+'/exports',exportRequest);assert.equal((await ok('POST',base+'/runs/'+run.run_id+'/exports',exportRequest)).run_id,exported.run_id);
  assert.equal(await execute(),'succeeded');assert.equal(calls,2,'re-export does not invoke search or model');assert.equal(browserCalls,3,'re-export reuses screenshots');assert.deepEqual(await creditBalance(pool,owner),{available:15000,frozen:0});
  w=await ok('GET',base);assert.equal(w.rounds[0].charged_points,0);assert.equal(w.rounds[0].operation,'export');assert.notEqual(w.rounds[0].artifact_id,checked.artifact_id);
  await documents(w.rounds[0],'supplemented');
  assert.equal(digest((await send('GET',artifact.download_url)).rawPayload),artifact.sha256,'original workpaper bytes remain available and unchanged');
  const versions=(await ok('GET',path+'/files')).items.filter((f:any)=>f.folder==='4.3');assert.equal(versions.length,4);assert.ok(versions.every((f:any)=>f.version_count===2));
  const cancelled=await ok('POST',base+'/runs',{...request,request_id:randomUUID()});await ok('POST','/api/v1/runs/'+cancelled.run_id+'/cancel',{reason:'synthetic cancellation'});assert.deepEqual(await creditBalance(pool,owner),{available:15000,frozen:0});
  await ok('POST',base+'/runs/'+cancelled.run_id+'/exports',{request_id:randomUUID(),expected_evidence_ids:[]});assert.equal(await execute(),'succeeded');assert.equal(calls,2);assert.deepEqual(await creditBalance(pool,owner),{available:15000,frozen:0});
  const fallback=await ok('GET',base);assert.ok(fallback.rounds[0].records.every((r:any)=>!r.search_performed));
  searchEnabled=false;await ok('POST',base+'/runs',{...request,request_id:randomUUID()});assert.equal(await execute(),'failed');assert.deepEqual(await creditBalance(pool,owner),{available:15000,frozen:0},'no actual recorded search releases all credits');
  w=await ok('GET',base);assert.equal(w.rounds[0].charged_points,0);assert.ok(w.rounds[0].records.every((r:any)=>!r.search_performed));
  await assert.rejects(pool.query("UPDATE bb_integrity_runs SET manifest='{}' WHERE run_id=$1",[run.run_id]),/immutable/);
  const result=(await pool.query('SELECT result,result_hash FROM bb_integrity_runs WHERE run_id=$1',[run.run_id])).rows[0];assert.equal(inputManifestHash(result.result),result.result_hash.trim());
 }finally{await browser.close();await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
