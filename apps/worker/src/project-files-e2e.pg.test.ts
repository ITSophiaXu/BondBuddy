// Synthetic model proposals; real upload, database, private storage, queues, versioning and Word patching.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PROJECT_FILE_UPDATE_PRICE} from '@bondbuddy/contracts';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from '@bondbuddy/api';
import {azureBlobs,digest,transaction} from '@bondbuddy/api/data';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {checkpointStage} from '@bondbuddy/api/queue';
import {advanceProjectFileBatch} from '@bondbuddy/api/project-file-workspace';
import {advanceProjectFileUpdates} from '@bondbuddy/api/project-file-consistency';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';
import {CodexDurableJournal} from './durable-probe-journal.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage,type StageContext} from './run-pipeline.js';
import {m4DocumentStage} from './m4-document-stage.js';
import {projectFileModelStage,projectFileDeliveryStage} from './project-file-stage.js';
import {historicalWordDeliveryStage} from './historical-word-stage.js';
import {inspectProjectFile} from './project-file-tools.js';
import type {writeRunWorkingFile} from '@bondbuddy/api/run-working-files';

// Synthetic M4 collector IO; this writer deliberately makes no registry DB claim.
const syntheticWriter:typeof writeRunWorkingFile=async input=>input.blobs.put(input.key,input.bytes,input.mediaType);

const database=await isolatedTestDatabase(undefined,'project-files-e2e'),storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
test('project files: template batch, provenance, real checks with synthetic model, whole-file paid updates, stale CAS, Word and isolation',
 {skip:!database||!storage||!process.env.BONDBUDDY_TEST_PYTHON,timeout:300000},async()=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID(),container='bb-files-'+randomUUID().replaceAll('-',''),dir=await mkdtemp(join(tmpdir(),'bb-files-e2e-'));let actor=owner;
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.body?r.json():null;};
  const oldText='Synthetic. 发行规模100万元。2025年总资产200万元。';
  const newText='Synthetic. 发行规模120万元。2025年总资产220万元。';
  const oldBytes=makeSyntheticDocxFixture({text:oldText}),newBytes=makeSyntheticDocxFixture({text:newText});
  const upload=async(project:string,name:string,bytes:Buffer,role='other')=>{
    const p='/api/v1/projects/'+project,declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const u=await ok('POST',p+'/materials/uploads',{...declaration,filename:name,media_type:DOCX,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
    const m=await ok('POST',p+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  let calls=0;
  const model:typeof codexModelStage=options=>({name:options.name,replay:true,run:async(ctx:StageContext)=>{
    const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
    const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:options.validate});
    const prior=await journal.latestAttempt(options.logicalCallId);
    if(prior){const saved=await journal.readCompleted(options.logicalCallId,prior.attempt_no);assert.ok(saved);return {kind:'done',value:saved.value};}
    const version=Number((await pool.query("SELECT COALESCE(max(version),0)+1 AS n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",[owner,ctx.run.project_id])).rows[0].n);
    const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',version,body:await options.buildPrompt(ctx),inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:options.templateVersion});
    await checkpointStage(pool,ctx.lease,'synthetic_file_prompt',{snapshot_id:snapshot,synthetic_model:true});
    const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,
      logical_call_id:options.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:'synthetic-files-model',model_config_version:'synthetic-v1',prompt_snapshot_ref:snapshot};
    const cwd=join(dir,intent.call_id);await mkdir(cwd);await options.fileWorkspace!.prepare(cwd);await journal.recordIntent(intent);calls++;
    // Reproduce the real adapter's required writable scratch boundary, even with a synthetic model.
    await writeFile(join(cwd,'scratch/permission-result'),'probe');
    assert.equal(await readFile(join(cwd,'scratch/permission-result'),'utf8'),'probe');
    if(options.logicalCallId.startsWith('file-check-')){
      const source=JSON.parse(await readFile(join(cwd,'source-spans.json'),'utf8')),target=JSON.parse(await readFile(join(cwd,'target-spans.json'),'utf8'));
      const sp=source.spans.find((p:any)=>p.text.includes('发行规模')),tp=target.spans.find((p:any)=>p.text.includes('发行规模'));
      const findings=[['100万元','120万元','发行规模'],['200万元','220万元','总资产']].filter(([before])=>tp.text.includes(before)).map(([before,after,field])=>({kind:'conflict',target_span_id:tp.id,original:before,replacement:after,source_span_id:sp.id,source_quote:after,reason:'Synthetic comparison of exact amounts',field,period:field==='总资产'?'2025年':'本期',unit:'万元'}));
      await writeFile(join(cwd,'output/check.json'),JSON.stringify({coverage:'Synthetic proposals; exact source and target anchors are verified by host.',checked_span_ids:target.spans.map((p:any)=>p.id),findings,links:[{source_span_id:sp.id,source_quote:'Synthetic.',target_span_id:tp.id,target_quote:'Synthetic.',field:'标记',period:'',unit:''}]}));
    }else{
      await writeFile(join(cwd,'output/document.docx'),oldBytes);await writeFile(join(cwd,'output/preparation-note.docx'),makeSyntheticDocxFixture({text:'Synthetic preparation note'}));
      await writeFile(join(cwd,'output/file-links.json'),JSON.stringify({links:[{source_span_id:'p0',source_quote:'100万元',target_span_id:'p0',target_quote:'100万元',field:'发行规模',period:'本期',unit:'万元'}]}));
    }
    const value=await options.fileWorkspace!.collect(cwd,intent,{text:'Synthetic file authoring; no supplier call'});
    const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),options.resultSchemaVersion);
    await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage:{status:'measured',input_tokens:1000,cached_input_tokens:0,output_tokens:100,reasoning_tokens:0,total_tokens:1100},error_code:null});
    return {kind:'done',value};
  }});
  const config={...loadCodexAdapterConfig({}),model_id:'synthetic-files-model',model_config_version:'synthetic-v1'};
  const fileStage=projectFileModelStage({model});
  const replaySafeFileStage={...fileStage,run:async(ctx:StageContext)=>{
    const result=await fileStage.run(ctx);
    const op=(await pool.query('SELECT operation FROM bb_project_file_operations WHERE run_id=$1',[ctx.run.id])).rows[0];
    if(op.operation==='patch'&&result.kind==='done'){
      // Simulate a process loss after durable output save but before stage checkpoint.
      const replay=await fileStage.run({...ctx,checkpoint:{}});
      assert.equal(replay.kind,'done');if(replay.kind==='done')assert.deepEqual(replay.value,result.value);
    }
    return result;
  }};
  const execute=(operation:boolean)=>runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],
    stages:[inputLockStage,materialsReadyStage,operation?replaySafeFileStage:m4DocumentStage({config,model,writer:syntheticWriter}),operation?projectFileDeliveryStage():historicalWordDeliveryStage()],
    onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'files_'+randomUUID().slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:100000,expiresAt:null,actor:'synthetic',reason:'file e2e'}));
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic files project',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),id=p.project_id,path='/api/v1/projects/'+id,base=path+'/project-files';
    const source=await upload(id,'source-v1.docx',oldBytes,'historical');
    let versions=await ok('GET',path+'/prospectus-versions');
    const selected=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    let w=await ok('POST',base+'/workspace',{request_id:randomUUID()});assert.equal(Object.keys(w.workspace.drafts).length,12);
    w=await ok('POST',base+'/source',{source_version_id:selected.current_version_id,expected_selection_revision:selected.selection_revision});
    const batch={request_id:randomUUID(),source_version_id:selected.current_version_id,expected_selection_revision:selected.selection_revision,documents:[{document_type:'issuer',draft_version:w.workspace.drafts.issuer.version}]};
    assert.equal((await send('POST',base+'/batches',batch)).statusCode,422,'template required');
    const templateMaterial=await upload(id,'template.docx',oldBytes);
    for(const type of ['issuer','annual']){
      const t=(await ok('POST','/api/v1/m4/templates',{creation_request_id:randomUUID(),name:'Synthetic '+type,broker:'',document_type:type,material:templateMaterial,market:'sse',offering:'private'})).template;
      const {version,sha256,updated_at,...input}=w.workspace.drafts[type];input.template={template_id:t.template_id,template_version:t.template_version,sha256:t.sha256};
      const saved=await ok('PUT','/api/v1/m4/topics/'+w.workspace.topic.topic_id+'/drafts/'+type,{expected_version:version,input});w.workspace.drafts[type]=saved.draft;
    }
    batch.documents=['issuer','annual'].map(type=>({document_type:type,draft_version:w.workspace.drafts[type].version}));
    const submitted=await ok('POST',base+'/batches',batch);assert.equal((await ok('POST',base+'/batches',batch)).batch_id,submitted.batch_id);
    assert.equal(await advanceProjectFileBatch(pool),true);assert.equal(await execute(false),'succeeded');
    assert.equal(await advanceProjectFileBatch(pool),true);assert.equal(await execute(false),'succeeded');await advanceProjectFileBatch(pool);
    const generated=await ok('GET',base);assert.equal(generated.files.filter((f:any)=>f.latest).length,2);assert.equal(generated.files[0].links.length,1);assert.equal(generated.files[0].source_version_id,selected.current_version_id);
    const other=await ok('POST','/api/v1/projects',{kind:'generation',name:'Other own project',issuer_name:'Same owner',market:'sse',offering:'private'});
    const otherW=await ok('POST','/api/v1/projects/'+other.project_id+'/project-files/workspace',{request_id:randomUUID()});assert.equal(otherW.workspace.templates.length,2,'same-owner templates reused across projects');
    const next=await upload(id,'source-v2.docx',newBytes,'historical');versions=await ok('GET',path+'/prospectus-versions');
    await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:versions.selection_revision,version_id:versions.versions.find((v:any)=>v.material_id===next.material_id).version_id});
    w=await ok('GET',base+'/workspace');
    const req={request_id:randomUUID(),expected_source_version_id:w.source.version_id},check=await ok('POST',base+'/checks',req);
    assert.equal((await ok('POST',base+'/checks',req)).run_id,check.run_id);assert.equal(await execute(true),'succeeded');
    let c=(await ok('GET',base+'/checks')).checks[0];assert.equal(c.result.files.length,2);assert.ok(c.result.files.every((f:any)=>f.status==='conflict'&&f.findings.length===2));
    const target=c.result.files[0],accept={request_id:randomUUID(),expected_check_sha256:c.sha256,
      price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:9000,files:c.files.map((f:any)=>({file_version_id:f.file_version_id}))};
    assert.equal((await creditBalance(pool,owner)).available,91000,'checks are free');
    assert.equal((await send('POST',base+'/checks/'+c.run_id+'/updates',{...accept,expected_points:4500})).statusCode,409,'cannot understate quoted total');
    assert.equal((await send('POST',base+'/checks/'+c.run_id+'/updates',{...accept,files:[{file_version_id:target.file_version_id,issue_ids:[target.findings[0].id]}]})).statusCode,422,'per-finding updates are not a public flow');
    await pool.query('UPDATE bb_credit_lots SET frozen=remaining WHERE owner_user_id=$1',[owner]);
    assert.equal((await send('POST',base+'/checks/'+c.run_id+'/updates',accept)).statusCode,402,'insufficient funds do not submit a batch');
    await pool.query('UPDATE bb_credit_lots SET frozen=0 WHERE owner_user_id=$1',[owner]);
    const accepted=await ok('POST',base+'/checks/'+c.run_id+'/updates',accept);
    assert.equal((await ok('POST',base+'/checks/'+c.run_id+'/updates',accept)).batch_id,accepted.batch_id);
    await advanceProjectFileUpdates(pool);
    assert.equal((await creditBalance(pool,owner)).frozen,4500,'reserve one file before execution');
    const cancelled=(await ok('GET',base+'/updates')).batches[0].items[0].run_id;
    await ok('POST','/api/v1/runs/'+cancelled+'/cancel',{reason:'synthetic cancel'});
    assert.deepEqual(await creditBalance(pool,owner),{available:91000,frozen:0},'cancel releases the full hold');
    await advanceProjectFileUpdates(pool);
    await ok('POST',base+'/updates/'+accepted.batch_id+'/retry');
    assert.equal(await advanceProjectFileUpdates(pool),true);
    assert.equal(await runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],
      stages:[inputLockStage,{name:'model_generation',run:async()=>({kind:'fail',code:'FILE_OUTPUT_STORE_FAILED'})}]}),'failed');
    assert.deepEqual(await creditBalance(pool,owner),{available:91000,frozen:0},'platform failure releases the full hold');
    await advanceProjectFileUpdates(pool);
    await ok('POST',base+'/updates/'+accepted.batch_id+'/retry');
    assert.equal(await advanceProjectFileUpdates(pool),true);
    const beforePatchCalls=calls;
    assert.equal(await execute(true),'succeeded');await advanceProjectFileUpdates(pool);
    assert.equal(await execute(true),'succeeded');await advanceProjectFileUpdates(pool);
    assert.equal(calls,beforePatchCalls,'file revision does not call model');
    let files=(await ok('GET',base)).files;
    assert.equal(files.filter((f:any)=>f.latest&&f.consistency.status==='updated').length,2);
    const updated=files.find((f:any)=>f.file_id===c.files[0].file_id&&f.latest);
    assert.equal(updated.sequence,2);assert.ok(updated.revision_asset);assert.equal(updated.consistency.count,0);
    const download=async(v:any)=>{const a=await ok('GET','/api/v1/artifacts/'+v.asset.pin.artifact_id);return (await send('GET',a.download_url)).rawPayload;};
    await writeFile(join(dir,'clean.docx'),await download(updated));
    const text=await inspectProjectFile({signal:new AbortController().signal} as StageContext,join(dir,'clean.docx'));
    assert.ok(text.spans.some(s=>s.text.includes('120万元')&&s.text.includes('220万元')),'all verified conflicts included in one revision');
    const original=files.find((f:any)=>f.version_id===target.file_version_id);
    assert.equal(digest(await download(original)),original.asset.pin.sha256,'original bytes preserved');
    assert.deepEqual(await creditBalance(pool,owner),{available:82000,frozen:0},'4500 once per completed file, no charge for cancelled run');
    assert.equal((await ok('POST',base+'/checks/'+c.run_id+'/updates',accept)).batch_id,accepted.batch_id,'repeat request reuses batch without charge');
    assert.equal((await send('POST',base+'/checks/'+c.run_id+'/updates',{...accept,request_id:randomUUID()})).statusCode,409,'already updated file cannot be charged again');
    const directory=(await ok('GET',path+'/files')).items;assert.ok(directory.some((f:any)=>f.folder==='3'));assert.ok(directory.some((f:any)=>f.folder==='4.1'));assert.equal(directory.filter((f:any)=>f.file_key.startsWith('project-file:')&&f.latest).length,2);
    const importFile=await upload(id,'manual.docx',oldBytes);const live=files.find((f:any)=>f.latest&&f.document_type==='issuer');
    await ok('POST',base+'/imports',{request_id:randomUUID(),document_type:'issuer',material:importFile,expected_latest_version_id:live.version_id});
    assert.equal((await send('POST',base+'/checks/'+c.run_id+'/updates',{...accept,request_id:randomUUID()})).statusCode,409,'stale targets cannot be overwritten');
    // User changes during an accepted update must survive delivery; the generated result is retained as history.
    const raceCheck=await ok('POST',base+'/checks',{request_id:randomUUID(),expected_source_version_id:w.source.version_id});
    assert.equal(await execute(true),'succeeded');
    const rc=(await ok('GET',base+'/checks')).checks.find((x:any)=>x.run_id===raceCheck.run_id);
    const rt=rc.result.files.find((x:any)=>x.findings.some((f:any)=>f.kind==='conflict'));
    await ok('POST',base+'/checks/'+rc.run_id+'/updates',{request_id:randomUUID(),expected_check_sha256:rc.sha256,price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:4500,files:[{file_version_id:rt.file_version_id}]});
    await advanceProjectFileUpdates(pool);
    await ok('POST',base+'/imports',{request_id:randomUUID(),document_type:'issuer',material:importFile,expected_latest_version_id:rt.file_version_id});
    const userFile=(await ok('GET',base)).files.find((f:any)=>f.latest&&f.document_type==='issuer');
    const changed=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:w.source.selection_revision,version_id:selected.current_version_id});
    assert.equal(await execute(true),'succeeded');await advanceProjectFileUpdates(pool);
    files=(await ok('GET',base)).files;
    assert.equal(files.find((f:any)=>f.latest&&f.document_type==='issuer').version_id,userFile.version_id,'delivery does not replace user upload');
    assert.ok(files.some((f:any)=>f.revision_asset&&!f.latest&&f.sequence>userFile.sequence),'concurrent result remains downloadable history');
    assert.equal((await send('POST',base+'/source',{source_version_id:w.source.version_id,expected_selection_revision:changed.selection_revision})).statusCode,409,'old source ID cannot masquerade as current revision');
    assert.equal((await send('POST',base+'/batches',{...batch,request_id:randomUUID(),source_version_id:w.source.version_id,expected_selection_revision:changed.selection_revision})).statusCode,409);
    assert.equal((await send('POST',base+'/checks/'+rc.run_id+'/updates',{...accept,request_id:randomUUID(),expected_check_sha256:rc.sha256})).statusCode,409,'changed source invalidates acceptance');
    versions=await ok('GET',path+'/prospectus-versions');assert.equal(versions.versions.length,2,'patches never become prospectus versions');
    actor=randomUUID();
    assert.equal((await send('GET',base)).statusCode,404);assert.equal((await send('GET',base+'/checks')).statusCode,404);assert.equal((await send('POST',base+'/checks',req)).statusCode,404);
    actor=owner;const balance=await creditBalance(pool,owner);assert.equal(balance.available,77500,'two generated files and three delivered revisions, all checks free');
    const charges=(await ok('GET','/api/v1/credits/consumption-history')).items.filter((x:any)=>x.task_name==='更新关联文件');
    assert.equal(charges.filter((x:any)=>x.state==='settled'&&x.charged_points===4500).length,3);
    assert.equal(charges.filter((x:any)=>x.state==='released'&&x.charged_points===0&&x.released_points===4500).length,2);
  }finally{await app.close();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();await pool.end();await rm(dir,{recursive:true,force:true});}
});

