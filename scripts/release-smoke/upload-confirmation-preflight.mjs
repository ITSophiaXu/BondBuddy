import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256} from './support.mjs';
import {CONFIRMATION_BUDGET_MS,CONFIRMATION_MODES,CONFIRMATION_SQL,SMALL_MAX_BYTES,assertConfirmationReceipt,confirmationDeadline,verifyConfirmationRuntime} from './upload-confirmation-evidence.mjs';

export function confirmationService(image,common){
 // Deliberately copy only storage/test scope. No model environment or credentials.
 const environment=Object.fromEntries(['DATABASE_URL','AZURE_STORAGE_CONNECTION_STRING','BB_DEPLOYMENT_TIER','BB_RELEASE_TEST_INSTANCE'].map(k=>[k,common[k]]));
 Object.assign(environment,{BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_CONFIRMATION_LANE:'large',BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'0',BB_UPLOAD_CONFIRMATION_CONTAINER:'bondbuddy-private',BB_UPLOAD_SPOOL_DIR:'/var/lib/bondbuddy/upload-confirmation',BB_UPLOAD_SPOOL_MAX_BYTES:'134217728',NODE_OPTIONS:'--max-old-space-size=320'});
 return {image,init:true,user:'1000:1000',command:['node','apps/worker/dist/upload-confirmation-runtime.js'],environment,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],tmpfs:['/tmp:rw,nosuid,nodev,size=16m'],volumes:['confirmation:/var/lib/bondbuddy/upload-confirmation'],mem_limit:'512m',cpus:0.5,stop_grace_period:'10m',profiles:['upload-size-split']};
}
export function describeConfirmationRuntime(service,actual,image){
 assert.equal(image.Id,actual.Image,'Container image inspection differs');
 assert.deepEqual(actual.Config?.Cmd,image.Config?.Cmd,'Container command differs from the tested image');
 assert.deepEqual(actual.Config?.Entrypoint,image.Config?.Entrypoint,'Container entrypoint differs from the tested image');
 const env=Object.fromEntries((actual.Config?.Env??[]).map(s=>{const n=s.indexOf('=');return [s.slice(0,n),s.slice(n+1)];}));
 const result={containerId:actual.Id,imageId:actual.Image,revision:actual.Config?.Labels?.['org.opencontainers.image.revision'],platform:image.Os+'/'+image.Architecture,startedAt:actual.State?.StartedAt,running:actual.State?.Running,command:actual.Config?.Cmd};
 if(service==='api')return result;
 Object.assign(result,{enabled:env.BB_UPLOAD_CONFIRMATION_ENABLED,lane:env.BB_UPLOAD_CONFIRMATION_LANE??'general',smallSlot:env.BB_UPLOAD_CONFIRMATION_SMALL_SLOT??'0',spoolBytes:env.BB_UPLOAD_SPOOL_MAX_BYTES});
 if(service==='upload-confirmation'){
  const mounts=actual.Mounts??[],spool=mounts.find(m=>m.Destination==='/var/lib/bondbuddy/upload-confirmation');
  Object.assign(result,{readOnly:actual.HostConfig?.ReadonlyRootfs,modelConfiguration:Object.entries(env).some(([k,v])=>v&&/^(BB_(CODEX|MODEL|DEEPSEEK|WORKER_JOB_KINDS|WORKER_RUN_KINDS|PLATFORM_PROBE)|CODEX_|COPILOT_|OPENAI_|DEEPSEEK_|ANTHROPIC_)/.test(k)),credentialMounts:mounts.some(m=>!['/var/lib/bondbuddy/upload-confirmation','/tmp'].includes(m.Destination)),memoryBytes:actual.HostConfig?.Memory,spoolType:spool?.Type,spoolDestination:spool?.Destination,command:actual.Config?.Cmd});
 }
 return result;
}
export function selectConfirmationFixtures(fixtures){
 const found=fixtures.financial.map(path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:sha256(bytes),filename:basename(path)};});
 const small=found.find(f=>f.bytes<=SMALL_MAX_BYTES),large=found.find(f=>f.bytes>SMALL_MAX_BYTES);
 assert.ok(small&&large,'Original fixed financial fixtures must cover both upload lanes');return {small,large};
}
export function nextUploadAction(upload){
 if(upload.httpReceipt)return 'verify';
 if(upload.bytesPutAt)return 'confirm';
 if(upload.createStartedAt||upload.uploadId||upload.putStartedAt)throw Error('An original upload request is unresolved; refusing a new session or repeated PUT');
 return 'create';
}
export function confirmationPhases(log,service,containerId,uploadId){
 return log.split(/\r?\n/).flatMap(line=>{try{const e=JSON.parse(line);return e.kind==='upload_confirmation_phase'&&e.upload_id===uploadId?[{service,containerId,...e}]:[];}catch{return [];}});
}
function requestBudget(mode){return Math.max(1,Math.min(25000,confirmationDeadline(mode)));}
const transaction={isolation:'repeatable read',readOnly:true};

/** Only this harness's isolated API/DB is addressed. Accepted work is never recreated on resume. */
export async function runConfirmationPreflight({report,privateData,save,directory,requestFactory,configure,snapshot,logs,execReadOnly}){
 const controllerSha256=sha256(readFileSync(join(directory,'upload-confirmation-preflight.mjs'))),fixtures=selectConfirmationFixtures(privateData.fixtures);
 report.uploadConfirmation??={schema:'release-upload-confirmation-v1',commit:report.sha,tree:report.tree,controllerSha256,status:'pending',modes:[]};
 const preflight=report.uploadConfirmation;
 assert.equal(preflight.commit,report.sha);assert.equal(preflight.tree,report.tree);assert.equal(preflight.controllerSha256,controllerSha256);
 const client=await requestFactory({baseURL:report.baseURL,extraHTTPHeaders:{origin:report.baseURL}});
 try{
  const login=await client.post('/api/v1/auth/login',{data:privateData.account,timeout:25000});assert.equal(login.status(),200,'Preflight login failed');
  const owner=(await login.json()).user_id;assert.ok(owner);if(preflight.ownerId)assert.equal(preflight.ownerId,owner);preflight.ownerId=owner;save();
  const csrf=(await client.storageState()).cookies.find(c=>c.name==='bb_csrf')?.value;assert.ok(csrf,'Preflight CSRF cookie missing');
  const post=(path,data,mode,headers={})=>client.post(path,{data,headers:{'x-bb-csrf':csrf,...headers},timeout:requestBudget(mode)});
  for(const name of CONFIRMATION_MODES){
   let mode=preflight.modes.find(m=>m.name===name);
   if(mode?.status==='passed')continue;
   if(!mode){
    const start=Date.now();mode={name,status:'pending',startedAt:new Date(start).toISOString(),deadlineAt:new Date(start+CONFIRMATION_BUDGET_MS).toISOString(),budgetMs:CONFIRMATION_BUDGET_MS,uploads:[]};preflight.modes.push(mode);save();
    await configure(name);mode.runtime=await snapshot(name);verifyConfirmationRuntime(mode.runtime,name,report.images);save();
   }else{
    confirmationDeadline(mode);
    assert.deepEqual(await snapshot(name),mode.runtime,'Upload runtime changed during an incomplete preflight; no restart or resubmission');
   }
   if(!mode.projectId){
    assert.ok(!mode.projectStartedAt,'Project creation response is unresolved; preserve original request');mode.projectStartedAt=new Date().toISOString();mode.projectRequestId=randomUUID();save();
    // Unified authoring deliberately stores these original PDFs without creating a separate parse job.
    const response=await post('/api/v1/projects',{creation_request_id:mode.projectRequestId,name:'Upload confirmation '+name,kind:'update',issuer_name:'Synthetic release upload scope',market:'sse',offering:'private',update_details:{has_historical:null,reporting_cutoff:'2026-09-30',registration_amount:null,issuance_amount:null,bond_terms:null,underwriting:null,other_agencies:null,rating_enhancement:null,funding_uses:[],other_information:null,supplementary_notes:null,authoring_mode:'unified_v1'}},mode);
    assert.equal(response.status(),201,'Preflight project creation failed');mode.projectId=(await response.json()).project_id;assert.ok(mode.projectId);save();
   }
   for(const sizeClass of ['small','large']){
    const fixture=fixtures[sizeClass];let upload=mode.uploads.find(u=>u.sizeClass===sizeClass);
    if(!upload){upload={sizeClass,sha256:fixture.sha256,bytes:fixture.bytes,filename:fixture.filename};mode.uploads.push(upload);save();}
    assert.equal(upload.sha256,fixture.sha256);assert.equal(upload.bytes,fixture.bytes);assert.equal(upload.filename,fixture.filename);
    const base=`/api/v1/projects/${encodeURIComponent(mode.projectId)}/materials/uploads`;
    if(nextUploadAction(upload)==='create'){
     upload.createStartedAt=new Date().toISOString();save();
     const response=await post(base,{role:'audit',filename:fixture.filename,media_type:'application/pdf',byte_size:fixture.bytes,sha256:fixture.sha256},mode);
     assert.equal(response.status(),201,'Preflight upload session failed');const session=await response.json();upload.uploadId=session.upload_id;assert.ok(upload.uploadId);save();
     const url=new URL(session.upload_url,report.baseURL);assert.equal(url.origin,report.baseURL,'Preflight expected same-origin byte transport');
     assert.equal(url.pathname,base+'/'+encodeURIComponent(upload.uploadId)+'/bytes');
     upload.putStartedAt=new Date().toISOString();save();
     const put=await client.put(session.upload_url,{data:readFileSync(fixture.path),headers:{'x-bb-csrf':csrf,'content-type':'application/octet-stream'},timeout:Math.min(180000,confirmationDeadline(mode))});
     assert.equal(put.status(),204,'Preflight byte upload failed');upload.bytesPutAt=new Date().toISOString();save();
    }
    const query=()=>execReadOnly({text:CONFIRMATION_SQL,values:[owner,mode.projectId,upload.uploadId],transaction});
    while(!upload.httpReceipt){
     confirmationDeadline(mode);const rows=(await query()).rows;assert.ok(rows.length<=1);const row=rows[0];
     if(row?.state==='failed')throw Error('Original upload confirmation failed; no automatic re-enqueue');
     if(!row&&upload.confirmationStartedAt)throw Error('Original confirmation acceptance is unresolved; no resubmission');
     if(!upload.confirmationStartedAt){upload.confirmationStartedAt=new Date().toISOString();save();}
     const response=await post(base+'/'+encodeURIComponent(upload.uploadId)+'/complete',{byte_size:upload.bytes,sha256:upload.sha256},mode,{Prefer:'respond-async'});
     assert.ok([200,202].includes(response.status()),'Preflight confirmation refused');upload.acceptedAt??=new Date().toISOString();save();
     if(response.status()===200){upload.httpReceipt=await response.json();save();break;}
     assert.equal((await response.json()).upload_id,upload.uploadId);await new Promise(r=>setTimeout(r,Math.min(500,confirmationDeadline(mode))));
    }
    // HTTP 200 observes the committed DB transaction, but the consumer writes
    // its final timing log after that transaction returns. Observe rather than
    // assuming Docker's log transport has already flushed the final phase.
    for(;;){
     confirmationDeadline(mode);const rows=(await query()).rows;assert.ok(rows.length<=1);upload.database=rows[0]??null;
     if(upload.database?.state==='failed')throw Error('Accepted upload has a failed confirmation record');
     upload.phases=[];
     for(const service of Object.keys(mode.runtime).filter(k=>k!=='api'))upload.phases.push(...confirmationPhases(await logs(mode.runtime[service].containerId,mode.startedAt),service,mode.runtime[service].containerId,upload.uploadId));
     upload.observationPolls=(upload.observationPolls??0)+1;save();
     if(upload.database?.state==='completed'&&upload.database.drained===true&&['read','inspection','commit'].every(phase=>upload.phases.some(e=>e.phase===phase)))break;
     await new Promise(r=>setTimeout(r,Math.min(500,confirmationDeadline(mode))));
    }
    assertConfirmationReceipt(upload,upload.database,owner,mode.projectId);
    upload.finishedAt=new Date().toISOString();save();
   }
   confirmationDeadline(mode);assert.deepEqual(await snapshot(name),mode.runtime,'Preflight runtime changed before completion');mode.finishedAt=new Date().toISOString();mode.status='passed';save();
  }
  preflight.status='passed';save();
 }finally{await client.dispose();}
}
