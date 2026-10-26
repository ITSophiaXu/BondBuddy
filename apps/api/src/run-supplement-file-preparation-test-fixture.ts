// Synthetic Word bytes with real immutable business inputs, provider history,
// private working-file registration and authenticated pause/supplement receipts.
import assert from 'node:assert/strict';
import { M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_SUBTYPE, type ReviewMaterialPin,
  type RunSupplementChange, type RunSupplementDraftRequest } from '@bondbuddy/contracts';
import { digest, uid } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { loadM4Knowledge } from './m4-knowledge.js';
import { inputManifestHash } from './production-rule-pin.js';
import { saveSnapshotRef } from './observability.js';
import { checkpointStage, claim, finish, pauseAtCheckpoint, promoteWordArtifact, recordPotentialCall, type Lease } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { writeRunWorkingFile } from './run-working-files.js';
import { createRunSupplementPreparationTestContext } from './run-supplement-preparation-test-fixture.js';

const origin='http://bondbuddy.test',docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pin=(value:ReviewMaterialPin):ReviewMaterialPin=>({material_id:value.material_id,material_version:value.material_version,sha256:value.sha256});
const ok=(response:{statusCode:number;body:string;json():any})=>{
  assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();
};
export type RunSupplementFilePreparationFixtureOptions={
  operation?:'full_review'|'differential_review';partial?:boolean;wrongCheckpointPrompt?:boolean;
  wordBytes?:Buffer;method?:Record<string,unknown>;
};

/** Importing this helper never starts a service or creates a database. Worker
 * suites supply their private clone and, for M4, the actual frozen method pin. */
export async function createRunSupplementFilePreparationFixture(connectionString:string,kind:'review'|'m4',
  options:RunSupplementFilePreparationFixtureOptions={}){
  const c=await createRunSupplementPreparationTestContext(connectionString),{pool,blobs,owner,app,objects}=c;
  try{
    const access=uid(),csrf=uid();
    await pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),owner,digest(access),digest(uid()),digest(csrf)]);
    const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,
      headers:{origin,cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf}});
    const project=async(task:string,scope:string|null=null)=>{
      const id=uid();await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,execution_scope_project_id)
        VALUES($1,$2,'Synthetic saved file preparation',$3,'Frozen issuer','sse','private',$4)`,[id,owner,task,scope]);return id;
    };
    const material=async(projectId:string,label:string,role:'other'|'audit'|'historical'='other',id:string=uid(),version=1)=>{
      const upload=uid(),bytes=makeSyntheticDocxFixture({text:`Synthetic ${label} version ${version}`}),sha256=digest(bytes);
      const objectKey=`users/${owner}/projects/${projectId}/materials/${id}/${version}`;
      await blobs.put(objectKey,bytes,docx);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','completed')`,
      [upload,owner,projectId,`${label}.docx`,docx,bytes.length,sha256,role,`${objectKey}/upload`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'persisted')`,
      [id,version,owner,projectId,upload,role,`${label}.docx`,docx,bytes.length,sha256,objectKey]);
      return {...pin({material_id:id,material_version:version,sha256}),role,source_project_id:projectId,objectKey,bytes};
    };
    const task=kind==='review'?'review':'generation',sourceProject=kind==='m4'?await project('update'):null;
    const projectId=await project(task,sourceProject),runId=uid(),jobId=uid(),topic=kind==='m4'?uid():null;
    const first=await material(sourceProject??projectId,'unchanged-first',kind==='m4'?'historical':'other');
    const original=await material(projectId,'replace-middle',kind==='review'?'historical':'audit');
    const last=await material(projectId,kind==='m4'?'frozen-template':'unchanged-last');
    const materials=[first,original,last],scoped=(value:typeof first)=>({...pin(value),source_project_id:value.source_project_id});
    const inputRevision=kind==='review'&&options.operation==='differential_review'?2:1;
    const knowledge='Frozen review method: preserve exact source versions and report missing evidence.';
    const originPin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
    const reviewInput={source_material_ref:pin(original),material_versions:materials.map(pin),requirements:['Frozen review requirement'],as_of:'2026-09-30'};
    const reviewManifest=(operation:'full_review'|'differential_review',version:number,source:any=null)=>({
      issuer_name:'Frozen issuer',market:'sse',offering:'private',materials:materials.map(value=>({...pin(value),role:value.role})),
      review:{version:'review_v1',operation,report_id:uid(),version_number:version,input:structuredClone(reviewInput),
        source_report_id:source?.id??null,source_report_sha256:source?.sha256??null,finding_ids:source?[source.findingId]:[],
        origin:structuredClone(originPin),file_delivery:{version:'review-file-v1',knowledge:[{path:'frozen-review.md',markdown:knowledge,sha256:digest(knowledge)}]}}
    });
    const persistInput=async(manifest:any,revision:number)=>{
      const hash=inputManifestHash(manifest),pins=kind==='m4'?manifest.input.materials:manifest.materials;
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
        VALUES($1,$2,$3,1,$4,$5,$6,'[]','frozen-rules','frozen-template','frozen-reference')`,[projectId,revision,owner,hash,manifest,JSON.stringify(pins)]);
      return hash;
    };
    const persistRun=async(id:string,hash:string,revision:number)=>pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','queued')`,[id,owner,projectId,revision,hash,uid(),task,digest(uid())]);
    const persistReview=async(id:string,manifest:any)=>pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,owner,projectId,manifest.review.version_number,manifest.review.operation,manifest.review.source_report_id,
      {input:manifest.review.input,origin:manifest.review.origin,finding_ids:manifest.review.finding_ids,plan:null}]);
    let sourceReport:{id:string;sha256:string;findingId:string}|null=null;
    if(kind==='review'&&options.operation==='differential_review'){
      const sourceRun=uid(),manifest=reviewManifest('full_review',1),sourceHash=await persistInput(manifest,1),findingId=uid();
      await persistRun(sourceRun,sourceHash,1);await persistReview(sourceRun,manifest);
      // Generate the historical report while its own execution is running, then
      // complete its real Word delivery before creating the differential run.
      // The project mutex remains active throughout both executions.
      const sourceJob=uid();
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
        VALUES($1,$2,$3,'review','default','queued','queued')`,[sourceJob,owner,sourceRun]);
      const sourceLease=await claim(pool,300,{runKinds:['review']});
      assert.ok(sourceLease);assert.equal(sourceLease.runId,sourceRun);
      const report={report_id:manifest.review.report_id,project_id:projectId,run_id:sourceRun,input_revision:1,version:1,
        source_material:pin(original),scope:{mode:'full_review',finding_ids:[]},findings:[{finding_id:findingId,report_id:manifest.review.report_id,
          dimension:'financial',conclusion:'needs_evidence',severity:'P2',title:'Synthetic missing support',description:'Synthetic source needs supporting evidence.',
          target_refs:[],evidence_refs:[],limitations:['No synthetic assertion is production evidence.'],repairability:{can_revise:false,reason:'Evidence required',allowed_record_ids:[]},
          origin_report_id:manifest.review.report_id,check_status:'rechecked'}],coverage:[],limitations:['Synthetic source report'],created_at:new Date().toISOString()};
      const sha256=inputManifestHash(report);
      await pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report)
        VALUES($1,$2,$3,$4,1,$5,$6)`,[report.report_id,owner,projectId,sourceRun,sha256,report]);
      const sourceArtifact=await promoteWordArtifact(pool,sourceLease,
        makeSyntheticDocxFixture({text:'Synthetic historical review report: supporting evidence remains required.'}),blobs,'generated_review_v1');
      if(sourceArtifact.status!=='available')throw Error('Synthetic historical review Word delivery failed');
      await pool.query(`INSERT INTO bb_review_artifacts(owner_user_id,project_id,run_id,artifact_id,artifact_version,kind,filename)
        VALUES($1,$2,$3,$4,$5,'report','historical-report.docx')`,
      [owner,projectId,sourceRun,sourceArtifact.artifactId,sourceArtifact.artifactVersion]);
      const completedSource=await finish(pool,sourceLease,'succeeded',{artifactId:sourceArtifact.artifactId,
        artifactVersion:sourceArtifact.artifactVersion,blobs});
      assert.equal(completedSource.state,'succeeded');
      sourceReport={id:report.report_id,sha256,findingId};
    }
    let manifest:any;
    if(kind==='review')manifest=reviewManifest(options.operation??'full_review',inputRevision,sourceReport);
    else{
      await pool.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash)
        VALUES($1,$2,$3,$4,'Synthetic frozen M4 source',$5,$6)`,[topic,owner,projectId,sourceProject,uid(),digest(uid())]);
      const templateId=uid();
      await pool.query(`INSERT INTO bb_m4_templates(id,version,owner_user_id,document_type,name,broker,material,sha256,creation_request_id,request_hash,market,offering)
        VALUES($1,1,$2,'underwriter','Frozen private template','Frozen broker',$3,$4,$5,$6,'sse','private')`,
      [templateId,owner,scoped(last),last.sha256,uid(),digest(uid())]);
      manifest={version:'m4-document-input-v1',kind:'document',topic_id:topic,execution_scope_project_id:sourceProject,
        draft_version:1,market:'sse',offering:'private',billing_task:M4_DOCUMENT_BILLING_TASKS.underwriter,
        knowledge:loadM4Knowledge('sse','underwriter','private'),template_material:scoped(last),
        input:{document_type:'underwriter',source_material:scoped(first),materials:materials.map(scoped),
          template:{template_id:templateId,template_version:1,sha256:last.sha256},edit_base:null,scope:'whole',fields:{issuer_name:'Frozen issuer',broker:'Frozen broker'},
          requirements:[{requirement_id:uid(),text:'Frozen M4 requirement',message_id:uid(),message_version:1}]}};
    }
    const hash=await persistInput(manifest,inputRevision);
    await pool.query('UPDATE bb_projects SET latest_input_revision=$2 WHERE id=$1',[projectId,inputRevision]);
    await persistRun(runId,hash,inputRevision);
    if(kind==='review')await persistReview(runId,manifest);
    else await pool.query(`INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)`,[runId,owner,topic,manifest,hash]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,$4,$5,'queued','queued')`,[jobId,owner,runId,task,kind==='m4'?M4_DOCUMENT_SUBTYPE:'default']);
    const claimed=await claim(pool,300,{runKinds:[task]});assert.ok(claimed);const lease:Lease=claimed;assert.equal(lease.runId,runId);
    const schema=kind==='review'?'codex-review-file-v1':'codex-m4-document-v1',logical=kind==='review'?'review-file-v1':'m4-document-v1';
    const method=structuredClone(options.method??{version:'m4-document-method-v1',skill_id:'m4-underwriter',skill_version:'synthetic-v1',
      skill_sha256:digest('Frozen synthetic M4 skill'),helper_sha256:{'read_material.py':digest('Frozen synthetic reader')},
      model:{model_id:'synthetic-model',model_provider:'synthetic',base_url:null,model_config_version:'synthetic-model-v1',reasoning_effort:'low'}});
    if(kind==='m4')await checkpointStage(pool,lease,'m4_document_method',method);
    let promptVersion=0;
    async function completed(callLogical:string,selected:boolean){
      const promptId=uid(),promptKey=`users/${owner}/projects/${projectId}/snapshots/${promptId}`,promptBytes=Buffer.from(`Frozen original ${callLogical} prompt`);
      await blobs.put(promptKey,promptBytes,'text/plain');
      const prompt=await saveSnapshotRef(pool,{owner,projectId,runId,kind:'model_request',version:++promptVersion,objectKey:promptKey,
        sha256:digest(promptBytes),redactionVersion:'synthetic_v1',inputRevision,inputHash:hash,blobs});
      const intent:ProviderCallIntent={owner_user_id:owner,project_id:projectId,job_id:jobId,run_id:runId,trace_id:runId,logical_call_id:callLogical,
        call_id:uid(),attempt_no:1,model_id:'synthetic-model',model_config_version:'synthetic-model-v1',prompt_snapshot_ref:prompt};
      await recordPotentialCall(pool,lease,callLogical,1,{callId:intent.call_id,modelId:intent.model_id,promptSnapshotId:prompt});
      const files:Record<string,{key:string;sha256:string;byte_size:number}>={},fileBytes=new Map<string,Buffer>();
      for(const name of kind==='review'?['report.docx','model-report.docx','report.md','annotations.json']:['document.docx','preparation-note.docx']){
        const bytes=name.endsWith('.docx')?(options.wordBytes&&name!=='preparation-note.docx'?Buffer.from(options.wordBytes):
          makeSyntheticDocxFixture({text:`Saved ${selected?'selected':'unrelated'} ${name}`})):
          Buffer.from(name.endsWith('.json')?'[]':'# Saved review report\nSynthetic saved review findings.');
        const sha256=digest(bytes),prefix=kind==='review'?'review-files':'m4-documents';
        const key=`owners/${owner}/projects/${projectId}/runs/${runId}/${prefix}/${intent.call_id}/${sha256}/${name}`;
        await writeRunWorkingFile({pool,blobs,lease,projectId,source:{kind:'provider',attemptId:intent.call_id,resultSchemaVersion:schema},
          name,key,bytes,mediaType:name.endsWith('.docx')?docx:name.endsWith('.json')?'application/json':'text/markdown'});
        files[name]={key,sha256,byte_size:bytes.length};fileBytes.set(name,bytes);
      }
      const value={version:schema,input_hash:hash,files,...(kind==='m4'?{skill_sha256:method.skill_sha256,method_hash:inputManifestHash(method)}:{}),
        ...(selected&&options.partial?{error:'WORD_DELIVERY_UNAVAILABLE'}:{})};
      const validate=(value:unknown)=>!!value&&typeof value==='object'&&(value as any).input_hash===hash;
      const reference=await persistProviderResultObject({blobs,intent,bytes:Buffer.from(JSON.stringify(value)),resultSchemaVersion:schema,validate});
      await recordProviderCallObservation(pool,blobs,{...intent,...reference,provider_request_id:null,finish_reason:'stop',outcome:'completed',error_code:null,
        usage:{status:'measured',input_tokens:10,cached_input_tokens:0,output_tokens:5,reasoning_tokens:0,total_tokens:15}},validate,{lease,source:'provider'});
      const result=(await pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1',[intent.call_id])).rows[0];
      return {intent,prompt,result,files,fileBytes};
    }
    const unrelated=await completed(`unrelated-${logical}`,false),selected=await completed(logical,true);
    await checkpointStage(pool,lease,kind==='review'?'review_file_v1_prompt':'m4_document_v1_prompt',{snapshot_id:selected.prompt});
    await checkpointStage(pool,lease,'model_generation',{logical_call_id:logical,prompt_snapshot_ref:options.wrongCheckpointPrompt?unrelated.prompt:selected.prompt});
    ok(await send('POST',`/api/v1/runs/${runId}/pause`,{reason:'Synthetic saved file preparation boundary'}));
    assert.equal(await pauseAtCheckpoint(pool,lease),true);
    const checkpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[jobId])).rows[0].checkpoint;
    const replacement=kind==='review'?await material(projectId,'replacement',original.role,original.material_id,2):null;
    const added=await material(projectId,'added','audit');
    const changes:RunSupplementChange[]=[{material:pin(added),replaces:null},...(replacement?[{material:pin(replacement),replaces:pin(original)}]:[])];
    const requests:RunSupplementDraftRequest[]=[];
    const save=async(expectedRevision=0,requestedChanges:RunSupplementChange[]=changes)=>{
      const request={request_id:uid(),expected_revision:expectedRevision,base_input_revision:inputRevision,base_input_hash:hash,changes:requestedChanges};
      requests.push(request);return ok(await send('PUT',`/api/v1/runs/${runId}/supplement-draft`,request));
    };
    const saved=await save();assert.equal(saved.input_preview.status,'prepared',JSON.stringify(saved.input_preview));
    const preparationInput={db:pool,blobs,owner,projectId,runId,revision:saved.revision,expectedCheckpointHash:inputManifestHash(checkpoint),
      expectedCandidateInputHash:saved.input_preview.candidate_input_hash as string};
    const snapshot=async()=>{
      const state=await c.evidence();
      for(const table of ['bb_projects','bb_uploads','bb_review_executions','bb_review_execution_snapshots','bb_review_reports','bb_review_execution_reports',
        'bb_m4_executions','bb_m4_execution_snapshots','bb_m4_topics','bb_m4_templates','bb_m4_metering'])
        state[table]=(await pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`,[owner])).rows;
      return state;
    };
    return {kind,pool,app,blobs,owner,projectId,sourceProject,runId,jobId,topic,inputRevision,hash,preparationInput,saved,
      checkpoint,manifest,method,sourceReport,selected,unrelated,files:selected.files,fileBytes:selected.fileBytes,objects,
      materials,first,original,last,replacement,added,changes,requests,request:requests[0]!,snapshot,cleanup:c.close,save};
  }catch(error){await c.close();throw error;}
}
