// Real PostgreSQL constraints over synthetic private Word fixtures. These tests
// never adopt V2, reserve additional credits or call an external provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { INITIAL_FIXED_PRICES, M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_SUBTYPE, type ReviewMaterialPin, type RunSupplementChange, type RunSupplementDraftRequest } from '@bondbuddy/contracts';
import { digest, transaction, uid } from './data.js';
import { publishPrices } from './billing.js';
import { debitAuthoringCredits } from './authoring-credit-debit.js';
import { canonicalInputManifest, inputManifestHash } from './production-rule-pin.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture, createRunSupplementPreparationTestContext, grantSyntheticSupplementInput } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture, type RunSupplementFilePreparationFixtureOptions } from './run-supplement-file-preparation-test-fixture.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { loadM4Knowledge } from './m4-knowledge.js';
import { saveSnapshotRef } from './observability.js';
import { checkpointStage, claim, finish, pauseAtCheckpoint, promoteWordArtifact, recordPotentialCall, type Lease } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { writeRunWorkingFile } from './run-working-files.js';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingKind } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlan } from './run-supplement-processing-plan.js';


// Local production-shaped review fixture: draft_revision is frozen before input,
// canonical business snapshots, provider bytes and pause/supplement receipts.
// Existing shared fixtures and their immutable historical inputs are not edited.
const origin='http://bondbuddy.test',docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pin=(value:ReviewMaterialPin):ReviewMaterialPin=>({material_id:value.material_id,material_version:value.material_version,sha256:value.sha256});
const ok=(response:{statusCode:number;body:string;json():any})=>{assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();};
async function buildSqlSupplementFileFixture(connectionString:string,kind:'review'|'m4',
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
      draft_revision:1,issuer_name:'Frozen issuer',market:'sse',offering:'private',materials:materials.map(value=>({...pin(value),role:value.role})),
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
    const channel=options.nonProduction?'non_production_test':'production';
    let testGrant:string|null=null;
    const persistRun=async(id:string,hash:string,revision:number)=>{
      const runChannel=options.nonProduction&&id===runId?channel:'production';
      testGrant=runChannel==='non_production_test'?await grantSyntheticSupplementInput(pool,owner,projectId,revision,hash):null;
      return pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,channel,test_grant_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','queued',$9,$10)`,[id,owner,projectId,revision,hash,uid(),task,digest(uid()),runChannel,testGrant]);
    };
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
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,channel,test_grant_id)
      VALUES($1,$2,$3,$4,$5,'queued','queued',$6,$7)`,[jobId,owner,runId,task,kind==='m4'?M4_DOCUMENT_SUBTYPE:'default',channel,testGrant]);
    const claimed=await claim(pool,300,{runKinds:[task]});assert.ok(claimed);const lease:Lease=claimed;assert.equal(lease.runId,runId);
    const schema=kind==='review'?'codex-review-file-v1':'codex-m4-document-v1',logical=kind==='review'?'review-file-v1':'m4-document-v1';
    const method=structuredClone(options.method??{version:'m4-document-method-v1',skill_id:'m4-underwriter',skill_version:'synthetic-v1',
      skill_sha256:digest('Frozen synthetic M4 skill'),helper_sha256:{'read_material.py':digest('Frozen synthetic reader')},
      model:{model_id:'synthetic-model',model_provider:'synthetic',base_url:null,model_config_version:'synthetic-model-v1',reasoning_effort:'low'}});
    if(kind==='m4')await checkpointStage(pool,lease,'m4_document_method',method);
    let promptVersion=0;
    async function promptSnapshot(callLogical:string){
      const promptId=uid(),promptKey=`users/${owner}/projects/${projectId}/snapshots/${promptId}`,promptBytes=Buffer.from(`Frozen original ${callLogical} prompt`);
      await blobs.put(promptKey,promptBytes,'text/plain');
      return saveSnapshotRef(pool,{owner,projectId,runId,kind:'model_request',version:++promptVersion,objectKey:promptKey,
        sha256:digest(promptBytes),redactionVersion:'synthetic_v1',inputRevision,inputHash:hash,blobs});
    }
    async function completed(callLogical:string,selected:boolean){
      const prompt=await promptSnapshot(callLogical);
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
    let unrelated:Awaited<ReturnType<typeof completed>>|null=null,selected:Awaited<ReturnType<typeof completed>>|null=null;
    let promptSnapshotRef:string|null=null;
    if(options.earlyPause==='after_prompt'){
      promptSnapshotRef=await promptSnapshot(logical);
      await checkpointStage(pool,lease,kind==='review'?'review_file_v1_prompt':'m4_document_v1_prompt',{snapshot_id:promptSnapshotRef});
    }else if(!options.earlyPause){
      unrelated=await completed(`unrelated-${logical}`,false);selected=await completed(logical,true);
      promptSnapshotRef=selected.prompt;
      await checkpointStage(pool,lease,kind==='review'?'review_file_v1_prompt':'m4_document_v1_prompt',{snapshot_id:selected.prompt});
      await checkpointStage(pool,lease,'model_generation',{logical_call_id:logical,prompt_snapshot_ref:options.wrongCheckpointPrompt?unrelated.prompt:selected.prompt});
    }
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
      checkpoint,manifest,method,sourceReport,selected,unrelated,earlyPause:options.earlyPause??null,promptSnapshotRef,
      files:selected?.files??{} as Record<string,{key:string;sha256:string;byte_size:number}>,fileBytes:selected?.fileBytes??new Map<string,Buffer>(),objects,
      materials,first,original,last,replacement,added,changes,requests,request:requests[0]!,snapshot,cleanup:c.close,save};
  }catch(error){await c.close();throw error;}
}

const connection = await isolatedTestDatabase(undefined, 'run-supplement-quotes-sql');
const options = { skip: !connection, timeout: 120000 };
async function fixture(kind: RunSupplementProcessingKind, empty = false, differential = false) {
  if (kind === 'authoring') return empty
    ? createRunSupplementPreparationFixture(connection!, { earlyPause: 'before_prompt' })
    : createRunSupplementPreparationFixture(connection!);
  const operation = differential ? 'differential_review' as const : 'full_review' as const;
  if (kind === 'review') return buildSqlSupplementFileFixture(connection!, kind, { operation, ...(empty ? { earlyPause: 'before_prompt' as const } : {}) });
  return empty
    ? createRunSupplementFilePreparationFixture(connection!, kind, { earlyPause: 'before_prompt', operation })
    : createRunSupplementFilePreparationFixture(connection!, kind, { operation });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prepare(f: Fixture, kind: RunSupplementProcessingKind) {
  const basis = await loadRunSupplementProcessingBasis(f.preparationInput, kind);
  const plan = await createRunSupplementProcessingPlan({ ...f.preparationInput, kind, requestId: uid(), expectedBasisHash: basis.basisHash });
  return { basis, plan };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function prices(pool: Pool, patch: Record<string, number> = {}) {
  const id = `synthetic-b1-${uid()}`;
  const effectiveAt = (await pool.query(`SELECT to_char((clock_timestamp()-interval '1 millisecond') AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`)).rows[0].time as string;
  const value = { ...INITIAL_FIXED_PRICES, new_authoring: 4500, full_review: 13900, differential_review: 1200, ...patch };
  await publishPrices(pool, { id, prices: value, effectiveAt, actor: 'synthetic_sql', reason: 'B1 constraint fixture; no production prices' });
  return { id, prices: value as Record<string, number> };
}
type Catalog = Awaited<ReturnType<typeof prices>>;
function itemFor(f: Fixture, kind: RunSupplementProcessingKind, empty: boolean, catalog?: Catalog, task?: string) {
  const manifest = f.manifest as any;
  const taskType: string = task ?? (kind === 'authoring' ? 'new_authoring' : kind === 'review' ? manifest.review.operation : manifest.billing_task);
  return {
    target_id: f.runId, document_name: 'Synthetic task target document', needs_redo: !empty,
    task_type: empty ? null : taskType,
    price_source: empty ? 'none' : kind === 'm4' ? 'm4_document_fixed' : 'fixed_catalog',
    price_version: empty ? null : kind === 'm4' ? 'm4-document-fixed-20261008-v1' : catalog!.id,
    full_price_points: empty ? null : kind === 'm4' ? 4500 : catalog!.prices[taskType],
    points: empty ? 0 : kind === 'm4' ? 4500 : catalog!.prices[taskType],
    billing_unit: kind === 'authoring' ? 'm1_word_pair' : kind === 'review' ? 'm3_review_outputs' : 'm4_document_and_note',
  };
}
const snapshotColumns = ['pricing_rule', 'owner_user_id', 'project_id', 'run_id', 'job_id', 'kind', 'source_execution_version',
  'source_input_revision', 'source_input_hash', 'supplement_revision', 'receipt_request_id', 'receipt_request_hash',
  'processing_plan_id', 'processing_plan_hash', 'checkpoint_hash', 'basis_hash', 'candidate_input_hash', 'source_quote_id', 'items', 'total_points'] as const;
type QuoteRow = Record<string, any>;
function seal(row: QuoteRow, patch: QuoteRow = {}) {
  const next = { ...row, ...patch };
  const snapshot = { version: 'run-supplement-rework-b1-v1', ...Object.fromEntries(snapshotColumns.map(key => [key, next[key]])) };
  next.canonical_snapshot_text = canonicalInputManifest(snapshot);
  next.quote_hash = digest(next.canonical_snapshot_text);
  return next;
}
function quote(f: Fixture, kind: RunSupplementProcessingKind, prepared: Prepared, item: ReturnType<typeof itemFor>, patch: QuoteRow = {}) {
  const requestId = uid(), { basis, plan } = prepared;
  return seal({ id: uid(), owner_user_id: f.owner, project_id: f.projectId, run_id: f.runId, job_id: f.jobId, kind,
    source_execution_version: basis.sourceExecution.executionVersion, source_input_revision: basis.sourceExecution.inputRevision,
    source_input_hash: basis.sourceExecution.inputHash, supplement_revision: f.saved.revision,
    receipt_request_id: plan.body.receipt.requestId, receipt_request_hash: plan.body.receipt.requestHash,
    processing_plan_id: plan.id, processing_plan_hash: plan.planHash, checkpoint_hash: basis.checkpointHash,
    basis_hash: basis.basisHash, candidate_input_hash: basis.candidateInputHash, source_quote_id: null,
    pricing_rule: 'b1_full_document_v1', items: [item], total_points: item.points,
    request_id: requestId, request_hash: inputManifestHash({ request_id: requestId, plan_id: plan.id, plan_hash: plan.planHash }),
    valid_for_seconds: 300, ...patch });
}
const quoteColumns = ['id', ...snapshotColumns, 'canonical_snapshot_text', 'quote_hash', 'request_id', 'request_hash', 'valid_for_seconds'];
async function insert(f: Fixture, row: QuoteRow) {
  return (await f.pool.query(`INSERT INTO bb_run_supplement_quotes(${quoteColumns.join(',')})
    VALUES(${quoteColumns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
  quoteColumns.map(key => key === 'items' ? JSON.stringify(row[key]) : row[key]))).rows[0];
}
async function confirm(f: Fixture, row: QuoteRow, patch: QuoteRow = {}) {
  const requestId = uid(), value = { id: uid(), owner_user_id: f.owner, project_id: f.projectId, run_id: f.runId,
    quote_id: row.id, quote_hash: row.quote_hash, total_points: row.total_points, request_id: requestId,
    request_hash: inputManifestHash({ request_id: requestId, quote_id: row.id, quote_hash: row.quote_hash, total_points: Number(row.total_points) }),
    confirmed_by: f.owner, ...patch };
  const columns = Object.keys(value);
  return (await f.pool.query(`INSERT INTO bb_run_supplement_quote_confirmations(${columns.join(',')})
    VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(value))).rows[0];
}
const check = (constraint: string) => (error: unknown) => (error as any)?.code === '23514' && (error as any)?.constraint === constraint;
async function records(f: Fixture) {
  const tables = ['bb_run_supplement_quotes', 'bb_run_supplement_quote_confirmations'];
  return Promise.all(tables.map(async table => (await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE owner_user_id=$1 ORDER BY id`, [f.owner])).rows));
}
async function unchanged(f: Fixture, operation: () => Promise<unknown>) {
  const before = await f.snapshot(), metadata = await records(f);
  await operation();
  assert.deepEqual(await f.snapshot(), before); assert.deepEqual(await records(f), metadata);
}
async function sourcePaid(f: Fixture, kind: RunSupplementProcessingKind, catalog: Catalog, task?: string) {
  const manifest = f.manifest as any;
  const id = uid(), reservation = uid(), taskType: string = task ?? (kind === 'authoring' ? 'new_authoring' : kind === 'review' ? manifest.review.operation : manifest.billing_task);
  const points = kind === 'm4' ? 4500 : catalog.prices[taskType];
  if (kind === 'm4') {
    await f.pool.query(`INSERT INTO bb_m4_quotes(id,owner_user_id,topic_id,intent_hash,task_type,config_id,reserve_points,multiplier,
      snapshot,expires_at,billing_method,fixed_price_version,billing_policy)
      VALUES($1,$2,$3,$4,$5,NULL,$6,1,$7,clock_timestamp()+interval '5 minutes','fixed','m4-document-fixed-20261008-v1','authoring_balance_v2')`,
    [id, f.owner, manifest.topic_id, f.hash, taskType, points, f.manifest]);
  } else {
    const revision = kind === 'review' ? manifest.draft_revision : 'inputRevision' in f ? f.inputRevision : 1;
    const intentHash = kind === 'review' ? inputManifestHash({ fixture: 'synthetic-review-intent', run_id: f.runId, source_hash: f.hash }) : null;
    await f.pool.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason,intent_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic original paid task',$9)`, [id, f.owner, f.projectId, revision, intentHash ?? f.hash, catalog.id, taskType, points, intentHash]);
  }
  await transaction(f.pool, async db => {
    await db.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points)
      VALUES($1,$2,$3,$4,$5,'authoring_balance_v2',0)`, [reservation, f.owner, f.runId, id, points]);
    await db.query(`UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1`, [f.runId, reservation]);
  });
  return { id, reservation, taskType };
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  test(`${kind}: genuine zero-attempt work quotes and confirms zero without any price catalog`, options, async () => {
    const f = await fixture(kind, true);
    try {
      const prepared = await prepare(f, kind), before = await f.snapshot();
      assert.equal(prepared.plan.body.priorWorkStatus, 'no_prior_work');
      const row = await insert(f, quote(f, kind, prepared, itemFor(f, kind, true)));
      assert.equal(Number(row.total_points), 0); assert.equal(row.items[0].needs_redo, false); assert.equal(row.items[0].task_type, null);
      const accepted = await confirm(f, row); assert.equal(Number(accepted.total_points), 0);
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_run_execution_versions WHERE run_id=$1', [f.runId])).rows[0].n, 1);
      assert.equal((await f.pool.query('SELECT bb_material_bytes_pinned($1,$2,$3,$4) AS pinned',
        [f.owner, f.projectId, f.added.material_id, f.added.material_version])).rows[0].pinned, false);
    } finally { await f.cleanup(); }
  });
}

for (const [kind, differential] of [['authoring', false], ['review', false], ['review', true], ['m4', false]] as const) {
  test(`${kind}${differential ? ' differential' : ''}: captured work uses one whole-document price and retains original paid accounting`, options, async () => {
    const f = await fixture(kind, false, differential);
    try {
      const catalog = await prices(f.pool), original = await sourcePaid(f, kind, catalog);
      await transaction(f.pool, async db => {
        const run = (await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE', [f.runId])).rows[0];
        await debitAuthoringCredits(db, run, 100);
      });
      const prepared = await prepare(f, kind), before = await f.snapshot();
      const row = await insert(f, quote(f, kind, prepared, itemFor(f, kind, false, catalog), { source_quote_id: original.id }));
      assert.equal(row.items.length, 1); assert.equal(row.items[0].needs_redo, true);
      assert.equal(Number(row.total_points), kind === 'm4' ? 4500 : catalog.prices[original.taskType]);
      await confirm(f, row); assert.deepEqual(await f.snapshot(), before);
      await unchanged(f, () => assert.rejects(insert(f, seal({ ...row, id: uid(), request_id: uid() }, { source_quote_id: null })), check('bb_supplement_quote_source_price')));
      await unchanged(f, () => assert.rejects(confirm(f, row, { quote_hash: 'd'.repeat(64) }), check('bb_supplement_quote_confirmation_exact')));
      await unchanged(f, () => assert.rejects(confirm(f, row, { total_points: Number(row.total_points) + 1 }), check('bb_supplement_quote_confirmation_exact')));
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_run_execution_versions WHERE run_id=$1', [f.runId])).rows[0].n, 1);
    } finally { await f.cleanup(); }
  });
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  test(`${kind}: an existing paid zero-attempt source retains its real quote while confirming zero with a null task`, options, async () => {
    const f = await fixture(kind, true);
    try {
      const catalog = await prices(f.pool), original = await sourcePaid(f, kind, catalog), prepared = await prepare(f, kind);
      const before = await f.snapshot(), value = quote(f, kind, prepared, itemFor(f, kind, true), { source_quote_id: original.id });
      const row = await insert(f, value); await confirm(f, row);
      assert.equal(row.items[0].task_type, null); assert.equal(Number(row.total_points), 0);
      assert.deepEqual(await f.snapshot(), before);
      await unchanged(f, () => assert.rejects(insert(f, seal({ ...value, id: uid(), request_id: uid() }, { source_quote_id: uid() })), check('bb_supplement_quote_source_price')));
      await unchanged(f, () => assert.rejects(insert(f, seal({ ...value, id: uid(), request_id: uid() },
        { items: [{ ...value.items[0], task_type: original.taskType }] })), check('bb_supplement_quote_prior_work')));
    } finally { await f.cleanup(); }
  });
}

test('SQL rejects altered scope, invented free work, split delivery pricing and forged snapshot hashes', options, async () => {
  const f = await fixture('authoring');
  try {
    const catalog = await prices(f.pool), prepared = await prepare(f, 'authoring');
    const valid = quote(f, 'authoring', prepared, itemFor(f, 'authoring', false, catalog));
    for (const patch of [{ owner_user_id: uid() }, { project_id: uid() }, { run_id: uid() }, { job_id: uid() },
      { source_input_hash: 'a'.repeat(64) }, { receipt_request_hash: 'b'.repeat(64) },
      { processing_plan_hash: 'c'.repeat(64) }, { candidate_input_hash: 'd'.repeat(64) }]) {
      await unchanged(f, () => assert.rejects(insert(f, seal({ ...valid, id: uid(), request_id: uid() }, patch)), check('bb_supplement_quote_origin')));
    }
    await unchanged(f, () => assert.rejects(insert(f, seal(valid, { items: [itemFor(f, 'authoring', true)], total_points: 0 })), check('bb_supplement_quote_prior_work')));
    await unchanged(f, () => assert.rejects(insert(f, seal(valid, { items: [valid.items[0], valid.items[0]], total_points: valid.total_points * 2 })), check('bb_supplement_quote_items')));
    await unchanged(f, () => assert.rejects(insert(f, seal(valid, { items: [{ ...valid.items[0], billing_unit: 'm4_document_and_note' }] })), check('bb_supplement_quote_items')));
    await unchanged(f, () => assert.rejects(insert(f, seal(valid, { items: [{ ...valid.items[0], arbitrary_discount: 0.1 }] })), check('bb_supplement_quote_items')));
    await unchanged(f, () => assert.rejects(insert(f, seal(valid, { total_points: valid.total_points - 1 })), check('bb_supplement_quote_items')));
    await unchanged(f, () => assert.rejects(insert(f, { ...valid, quote_hash: 'f'.repeat(64) }), check('bb_supplement_quote_snapshot')));
    await unchanged(f, () => assert.rejects(insert(f, { ...valid, canonical_snapshot_text: JSON.stringify({ ...JSON.parse(valid.canonical_snapshot_text), private_body: 'forbidden' }) }), check('bb_supplement_quote_snapshot')));
    await unchanged(f, () => assert.rejects(insert(f, seal(valid, { source_quote_id: uid() })), check('bb_supplement_quote_source_price')));
    const row = await insert(f, valid);
    const confirmations = await Promise.allSettled([confirm(f, row, { request_id: 'same-confirmation-key' }), confirm(f, row, { request_id: 'same-confirmation-key' })]);
    assert.equal(confirmations.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(confirmations.filter(result => result.status === 'rejected' && result.reason.code === '23505').length, 1);
  } finally { await f.cleanup(); }
});

test('paid source classification and current price are both bound; a changed price needs a new quote', options, async () => {
  const f = await fixture('authoring');
  try {
    const initial = await prices(f.pool), original = await sourcePaid(f, 'authoring', initial, 'annual');
    const prepared = await prepare(f, 'authoring');
    const valid = quote(f, 'authoring', prepared, itemFor(f, 'authoring', false, initial, 'annual'), { source_quote_id: original.id });
    const row = await insert(f, valid);
    await unchanged(f, () => assert.rejects(insert(f, seal({ ...valid, id: uid(), request_id: uid() },
      { items: [itemFor(f, 'authoring', false, initial, 'interim')], total_points: initial.prices.interim })), check('bb_supplement_quote_source_price')));
    const current = await prices(f.pool, { annual: initial.prices.annual + 1 });
    await unchanged(f, () => assert.rejects(confirm(f, row), check('bb_supplement_quote_current_price')));
    await unchanged(f, () => assert.rejects(insert(f, { ...valid, id: uid(), request_id: uid() }), check('bb_supplement_quote_current_price')));
    const fresh = await insert(f, quote(f, 'authoring', prepared, itemFor(f, 'authoring', false, current, 'annual'), { source_quote_id: original.id }));
    await confirm(f, fresh);
    assert.equal((await f.pool.query('SELECT quote_id FROM bb_credit_reservations WHERE id=$1', [original.reservation])).rows[0].quote_id, original.id);
  } finally { await f.cleanup(); }
});

test('real database time expires a short internal TTL; history remains readable and both tables reject mutation and truncate', options, async () => {
  const f = await fixture('authoring', true);
  try {
    const prepared = await prepare(f, 'authoring'), valid = quote(f, 'authoring', prepared, itemFor(f, 'authoring', true), { valid_for_seconds: 1 });
    const expired = await insert(f, valid);
    assert.equal(new Date(expired.expires_at).getTime() - new Date(expired.created_at).getTime(), 1000);
    await f.pool.query('SELECT pg_sleep(1.05)');
    assert.equal((await f.pool.query('SELECT clock_timestamp()>expires_at AS expired FROM bb_run_supplement_quotes WHERE id=$1', [expired.id])).rows[0].expired, true);
    await unchanged(f, () => assert.rejects(confirm(f, expired), check('bb_supplement_quote_expired')));
    const fresh = await insert(f, quote(f, 'authoring', prepared, itemFor(f, 'authoring', true))), accepted = await confirm(f, fresh);
    await f.save(1);
    const historical = await records(f);
    await unchanged(f, () => assert.rejects(confirm(f, expired), check('bb_supplement_quote_origin')));
    assert.deepEqual(await records(f), historical);
    for (const [table, id] of [['bb_run_supplement_quotes', fresh.id], ['bb_run_supplement_quote_confirmations', accepted.id]]) {
      await unchanged(f, () => assert.rejects(f.pool.query(`UPDATE ${table} SET request_id=request_id WHERE id=$1`, [id]), { code: '23514' }));
      await unchanged(f, () => assert.rejects(f.pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]), { code: '23514' }));
      await unchanged(f, () => assert.rejects(f.pool.query(`TRUNCATE ${table} CASCADE`), { code: '23514' }));
    }
  } finally { await f.cleanup(); }
});

test('latest receipt, material deletion and row locks are rechecked before accepting a quote', options, async () => {
  const f = await fixture('m4', true);
  try {
    const prepared = await prepare(f, 'm4'), valid = quote(f, 'm4', prepared, itemFor(f, 'm4', true)), row = await insert(f, valid);
    const blocker = await f.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR UPDATE`,
        [f.owner, f.projectId, f.added.material_id, f.added.material_version]);
      await unchanged(f, () => assert.rejects(confirm(f, row), { code: '55P03' }));
      await blocker.query('ROLLBACK');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await f.pool.query(`UPDATE bb_material_versions SET deleted_at=clock_timestamp() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
      [f.owner, f.projectId, f.added.material_id, f.added.material_version]);
    await unchanged(f, () => assert.rejects(confirm(f, row), check('bb_supplement_quote_materials')));
    await unchanged(f, () => assert.rejects(insert(f, { ...valid, id: uid(), request_id: uid() }), check('bb_supplement_quote_materials')));
  } finally { await f.cleanup(); }
});

test('concurrent quote keys create one immutable row and cannot name a different amount', options, async () => {
  const f = await fixture('authoring', true);
  try {
    const prepared = await prepare(f, 'authoring'), valid = quote(f, 'authoring', prepared, itemFor(f, 'authoring', true));
    const before = await f.snapshot(), outcomes = await Promise.allSettled([insert(f, valid), insert(f, { ...valid, id: uid() })]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.code === '23505').length, 1);
    assert.equal((await records(f))[0]!.length, 1); assert.deepEqual(await f.snapshot(), before);
    await unchanged(f, () => assert.rejects(insert(f, seal({ ...valid, id: uid() }, { items: [{ ...valid.items[0], points: 1 }], total_points: 1 })), check('bb_supplement_quote_prior_work')));
  } finally { await f.cleanup(); }
});
