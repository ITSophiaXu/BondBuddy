// Real paused HTTP capture, durable provider history and registered private DOCX
// bytes. Preparing continuation inputs never sends a provider request or adopts V2.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ZipFile } from 'yazl';
import { emptyUpdateDetails, type ProjectMessageSetMember, type ReviewMaterialPin, type RunSupplementChange, type RunSupplementDraftRequest } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { digest, transaction, uid, type PrivateBlobs } from './data.js';
import { creditBalance, grantCredits } from './billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { saveSnapshotRef } from './observability.js';
import { checkpointStage, claim, pauseAtCheckpoint, recordPotentialCall, type Lease } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { writeRunWorkingFile } from './run-working-files.js';
import type { loadRunSupplementAuthoringPreparation } from './run-supplement-preparation.js';

const origin='http://bondbuddy.test',docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const schema='codex-file-word-v1';
function ok(response:{statusCode:number;body:string;json():any}){
  assert.ok(response.statusCode>=200 && response.statusCode<300,response.body);return response.json();
}
const pin=(value:ReviewMaterialPin):ReviewMaterialPin=>({material_id:value.material_id,material_version:value.material_version,sha256:value.sha256});
async function word(text:string):Promise<Buffer>{
  const archive=new ZipFile(),chunks:Buffer[]=[];
  const result=new Promise<Buffer>((resolve,reject)=>{
    archive.outputStream.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    archive.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));archive.outputStream.on('error',reject);
  });
  const add=(name:string,xml:string)=>archive.addBuffer(Buffer.from(xml),name,{mtime:new Date('2026-01-01T00:00:00Z')});
  add('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  add('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  add('word/document.xml',`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  archive.end();return result;
}

export type RunSupplementPreparationFixtureOptions={partial?:boolean;wrongCheckpointPrompt?:boolean;wordBytes?:Buffer;requirementBody?:string};
export async function createRunSupplementPreparationTestContext(connectionString:string){
  const pool=new Pool({connectionString}),owner=`supp-preparation-${uid()}`;
  const objects=new Map<string,Buffer>();let writes=0,deletes=0;
  const blobs:PrivateBlobs={put:async(key,bytes)=>{writes++;objects.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},
    getIfExists:async key=>objects.get(key)??null,getIfExistsBounded:async(key,max)=>{
      const bytes=objects.get(key);if(bytes&&bytes.length>max)throw Error('Synthetic bounded read refused');return bytes??null;
    },exists:async key=>objects.has(key),delete:async key=>{deletes++;objects.delete(key);}};
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`supp_prep_${uid().replaceAll('-','').slice(0,16)}`]);
  const access=uid(),csrf=uid();
  await pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),owner,digest(access),digest(uid()),digest(csrf)]);
  await transaction(pool,db=>grantCredits(db,{owner,points:10000,key:uid(),source:'existing_grant',expiresAt:null,
    actor:'synthetic-test',reason:'Continuation preparation is read only'}));
  const app=createServer({pool,blobs,allowedOrigin:origin,enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,
    headers:{origin,cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf}});
  async function material(projectId:string,label:string,options:{id?:string;version?:number;role?:'other'|'audit'}={}){
    const id=options.id??uid(),version=options.version??1,role=options.role??'other',upload=uid();
    const bytes=await word(`Synthetic ${label} material version ${version}`),sha256=digest(bytes),key=`users/${owner}/projects/${projectId}/materials/${id}/${version}`;
    await blobs.put(key,bytes,docx);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','completed')`,[upload,owner,projectId,`${label}.docx`,docx,bytes.length,sha256,role,`${key}/upload`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'persisted')`,[id,version,owner,projectId,upload,role,`${label}.docx`,docx,bytes.length,sha256,key]);
    return {material_id:id,material_version:version,sha256,role,source_project_id:projectId,objectKey:key,bytes};
  }
  async function fixture(options:RunSupplementPreparationFixtureOptions={}){
    const projectId=uid(),runId=uid(),jobId=uid();
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'Synthetic continuation inputs','update','Frozen issuer')",[projectId,owner]);
    const first=await material(projectId,'unchanged-first'),original=await material(projectId,'replace-middle'),last=await material(projectId,'unchanged-last');
    const materials=[first,original,last];
    const requirement=options.requirementBody===undefined?null:await (async()=>{
      const messageId=uid();
      const saved=ok(await send('POST',`/api/v1/projects/${projectId}/messages`,{message_id:messageId,
        submission_request_id:uid(),expected_message_version:null,body:options.requirementBody,material_versions:[]}));
      const row=(await pool.query(`SELECT v.*,s.object_key,s.content_sha256 AS snapshot_sha256 FROM bb_user_submission_versions v
        JOIN bb_snapshot_refs s ON s.id=v.snapshot_id WHERE v.id=$1 AND v.owner_user_id=$2 AND v.project_id=$3
          AND v.submission_kind='project_message' AND v.message_id=$4 AND v.message_version=1`,
      [saved.submission_id,owner,projectId,messageId])).rows[0];
      assert.ok(row);assert.equal(row.snapshot_id,saved.prompt_snapshot_ref);
      const body=objects.get(row.object_key)!.toString('utf8');
      assert.equal(digest(body),row.content_sha256.trim());assert.equal(row.snapshot_sha256.trim(),row.content_sha256.trim());
      const pin:ProjectMessageSetMember={message_id:row.message_id,message_version:row.message_version,
        submission_id:row.id,content_sha256:row.content_sha256.trim()};
      return {messageId,pin,snapshotId:row.snapshot_id as string,body};
    })();
    const saveLaterRequirement=async(body:string)=>{
      assert.ok(requirement,'requirementBody must be configured before the input is frozen');
      return ok(await send('POST',`/api/v1/projects/${projectId}/messages`,{message_id:requirement.messageId,
        submission_request_id:uid(),expected_message_version:1,body,material_versions:[]}));
    };
    const knowledge='Frozen preparation policy';
    const manifest={draft_revision:1,issuer_name:'Frozen issuer',market:'sse',offering:'private',goals:['Frozen goal'],requirements:[requirement?.body??'Frozen user requirement'],
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},
      materials:materials.map(value=>({...pin(value),role:value.role})),rule_pack_version:'frozen-rules',template_version:'frozen-template',reference_release:'frozen-reference',
      authoring:{version:'unified_v1',source_prospectuses:[],requirements:requirement?[requirement.pin]:[],knowledge:[{path:'knowledge/frozen.md',markdown:knowledge,sha256:digest(knowledge)}],
        knowledge_status:'authoring_reference_not_compliance_approval'}};
    const hash=inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
      VALUES($1,1,$2,1,$3,$4,$5,$6,'frozen-rules','frozen-template','frozen-reference')`,
    [projectId,owner,hash,manifest,JSON.stringify(manifest.materials),JSON.stringify(requirement?[requirement.messageId]:[])]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued')`,[runId,owner,projectId,hash,uid(),digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'update','default','queued','queued')`,[jobId,owner,runId]);
    const claimed=await claim(pool,300,{runKinds:['update']});assert.ok(claimed);
    const lease:Lease=claimed;assert.equal(lease.runId,runId);
    let promptVersion=0;
    async function completed(logical:string,selected:boolean){
      const promptId=uid(),promptKey=`users/${owner}/projects/${projectId}/snapshots/${promptId}`,promptBytes=Buffer.from(`Original prompt ${promptId}`);
      await blobs.put(promptKey,promptBytes,'text/plain');
      const prompt=await saveSnapshotRef(pool,{owner,projectId,runId,kind:'model_request',version:++promptVersion,objectKey:promptKey,
        sha256:digest(promptBytes),redactionVersion:'synthetic_v1',inputRevision:1,inputHash:hash,blobs});
      const intent:ProviderCallIntent={owner_user_id:owner,project_id:projectId,job_id:jobId,run_id:runId,trace_id:runId,
        logical_call_id:logical,call_id:uid(),attempt_no:1,model_id:'synthetic-model',model_config_version:'synthetic-model-v1',prompt_snapshot_ref:prompt};
      await recordPotentialCall(pool,lease,logical,1,{callId:intent.call_id,modelId:intent.model_id,promptSnapshotId:prompt});
      const files:Record<string,{key:string;sha256:string;byte_size:number}>={},fileBytes=new Map<string,Buffer>();
      for(const name of ['tracked.docx','clean.docx','baseline.docx','delivery.md']){
        const bytes=name.endsWith('.docx')?(options.wordBytes?Buffer.from(options.wordBytes):await word(`Saved ${selected?'selected':'unrelated'} ${name} ${runId}`)):Buffer.from('Saved authoring summary');
        const sha256=digest(bytes),key=`owners/${owner}/projects/${projectId}/runs/${runId}/file-authoring/${intent.call_id}/${sha256}/${name}`;
        await writeRunWorkingFile({pool,blobs,lease,projectId,source:{kind:'provider',attemptId:intent.call_id,resultSchemaVersion:schema},
          name,key,bytes,mediaType:name.endsWith('.docx')?docx:'text/markdown'});
        files[name]={key,sha256,byte_size:bytes.length};fileBytes.set(name,bytes);
      }
      const value={version:schema,input_hash:hash,files,summary:{authoring_summary:['Saved authoring summary']},
        ...(selected&&options.partial?{error:'WORD_QUALITY_REJECTED'}:{})};
      const validate=(candidate:unknown)=>!!candidate&&typeof candidate==='object'&&(candidate as any).input_hash===hash;
      const reference=await persistProviderResultObject({blobs,intent,bytes:Buffer.from(JSON.stringify(value)),resultSchemaVersion:schema,validate});
      await recordProviderCallObservation(pool,blobs,{...intent,...reference,provider_request_id:null,finish_reason:'stop',outcome:'completed',error_code:null,
        usage:{status:'measured',input_tokens:10,cached_input_tokens:0,output_tokens:5,reasoning_tokens:0,total_tokens:15}},validate,{lease,source:'provider'});
      const result=(await pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1',[intent.call_id])).rows[0];
      return {intent,prompt,result,files,fileBytes};
    }
    const unrelated=await completed('unrelated-file-authoring-v1',false),selected=await completed('file-authoring-v1',true);
    await checkpointStage(pool,lease,'file_authoring_v1_prompt',{snapshot_id:selected.prompt});
    await checkpointStage(pool,lease,'model_generation',{logical_call_id:'file-authoring-v1',prompt_snapshot_ref:options.wrongCheckpointPrompt?unrelated.prompt:selected.prompt});
    ok(await send('POST',`/api/v1/runs/${runId}/pause`,{reason:'Synthetic continuation preparation boundary'}));
    assert.equal(await pauseAtCheckpoint(pool,lease),true);
    const checkpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[jobId])).rows[0].checkpoint;
    const replacement=await material(projectId,'replacement',{id:original.material_id,version:2}),added=await material(projectId,'added',{role:'audit'});
    const changes:RunSupplementChange[]=[{material:pin(added),replaces:null},{material:pin(replacement),replaces:pin(original)}];
    const url=`/api/v1/runs/${runId}/supplement-draft`;
    const requests:RunSupplementDraftRequest[]=[];
    const save=async(expectedRevision=0)=>{
      const request={request_id:uid(),expected_revision:expectedRevision,base_input_revision:1,base_input_hash:hash,changes};
      requests.push(request);return ok(await send('PUT',url,request));
    };
    return {projectId,runId,jobId,hash,manifest,materials,first,original,last,replacement,added,changes,checkpoint,selected,unrelated,requests,save,
      requirement,saveLaterRequirement};
  }
  async function evidence(){
    const state:Record<string,unknown>={};
    for(const table of ['bb_runs','bb_jobs','bb_run_execution_versions','bb_input_revisions','bb_material_versions','bb_model_call_attempts',
      'bb_model_call_execution_bindings','bb_provider_result_refs','bb_provider_call_observations','bb_usage_observations','bb_snapshot_refs',
      'bb_run_supplement_drafts','bb_run_supplement_saved_work','bb_run_supplement_saved_results','bb_run_working_objects','bb_run_working_sources',
      'bb_credit_events','bb_credit_lots','bb_credit_accounts','bb_credit_reservations','bb_artifact_versions','bb_artifact_download_grants',
      'bb_run_events','bb_outbox','bb_observability_events'])state[table]=(await pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`,[owner])).rows;
    state.working_state=(await pool.query(`SELECT s.* FROM bb_run_working_object_state s JOIN bb_run_working_objects o ON o.object_key=s.object_key
      WHERE o.owner_user_id=$1 ORDER BY s.object_key`,[owner])).rows;
    state.balance=await creditBalance(pool,owner);
    state.storage={writes,deletes,objects:[...objects].map(([key,bytes])=>[key,digest(bytes)]).sort()};return state;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const args=(f:Fixture,saved:any,overrides:Partial<Parameters<typeof loadRunSupplementAuthoringPreparation>[0]>={})=>{
    assert.equal(saved.input_preview.status,'prepared');
    return {db:pool,blobs,owner,projectId:f.projectId,runId:f.runId,revision:saved.revision,
      expectedCheckpointHash:inputManifestHash(f.checkpoint),expectedCandidateInputHash:saved.input_preview.candidate_input_hash as string,...overrides};
  };
  async function unchanged<T>(operation:()=>Promise<T>){const before=await evidence(),result=await operation();assert.deepEqual(await evidence(),before);return result;}
  return {pool,app,blobs,owner,objects,fixture,evidence,args,unchanged,close:async()=>{await app.close();await pool.end();}};
}

/** Shared real source boundary for API and worker integration suites. No database
 * is cloned or started by importing this module; the caller supplies its clone. */
export async function createRunSupplementPreparationFixture(connectionString:string,options:RunSupplementPreparationFixtureOptions={}){
  const context=await createRunSupplementPreparationTestContext(connectionString);
  try{
    const fixture=await context.fixture(options),saved=await fixture.save();
    return {...fixture,pool:context.pool,app:context.app,blobs:context.blobs,owner:context.owner,
      request:fixture.requests[0]!,saved,preparationInput:context.args(fixture,saved),
      files:fixture.selected.files,fileBytes:fixture.selected.fileBytes,objects:context.objects,
      snapshot:context.evidence,cleanup:context.close};
  }catch(error){await context.close();throw error;}
}

