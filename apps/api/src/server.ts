import { installAccountRecovery } from './account-recovery.js';
import { listProjects, archiveProject } from './project-list.js';
import { readOcr, readOcrPage, correctOcr } from './ocr.js';
import type { OcrCorrectionRequest } from '@bondbuddy/contracts';
import Fastify, { type FastifyRequest } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { M1_UPLOAD_MIME_TYPES, M1_UPLOAD_LIMITS, openApiDocument, schemas, emptyUpdateDetails, updateDetailsErrors, type UpdateDetails, type Market, type Offering } from '@bondbuddy/contracts';
import { azureBlobs, canonical, checkedPair, conflict, date, digest, executionKeyStorage, inputDto, material, materialDto, missing, Problem, project, projectDto, putBlobFile, readBlobToFile, run, runDto, transaction, uid, unavailable, verifiedMediaFile, type PrivateBlobs } from './data.js';
import { clearSpoolDirectory, discardSpool, reserveSpool, spoolDirectory, spoolStream, type Spooled } from './upload-spool.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { installAuth, principal as sessionPrincipal, type AuthConfig } from './auth.js';
import { installLibraryAdminRoutes } from './library-admin-routes.js';
import { action as queueAction, enqueue } from './queue.js';
import { executionKeyHash, isPgInputRevision, recordLogicalJob, recordOperation, rejectOperation, validExecutionKey } from './observability.js';
import { installAdminRoutes } from './admin-routes.js';
import { DOCX_LIMITS, WORD_MEDIA_TYPE } from './docx-inspector.js';
import { installEventStreams, type StreamSettings } from './stream.js';
import { sendMaterial } from './material-download.js';
import { dataPolicyFromEnv } from './deletion-lifecycle.js';
import { dataLifecycleSchemas } from '@bondbuddy/contracts';
import { RUN_PIPELINE_SUBTYPE } from '@bondbuddy/contracts';
import { admitProjectCreate, admitRunSubmit, admitUploadCreate, reportTrialRejection, sourceHash, TrialLimitProblem, trialConfigFromEnv, type TrialConfig } from './trial-guard.js';
import { installTrialRoutes } from './trial-routes.js';
import { installPlatformProbeRoutes } from './platform-probe.js';
import { cancelMaterialParse, documentParserVersion, enqueueMaterialParse, materialParseJobDto, readMaterialParseJob } from './material-jobs.js';
import { correctHistoricalProfile, historicalProfileCorrectionProblem } from './historical-profile-corrections.js';
import { installFactReviewRoutes } from './fact-review.js';
import { loadVerifiedIssuerIdentitySourceRecord } from './issuer-identity-source.js';
import { issuerIdentityBindingMatches, isVerifiedIssuerIdentityBinding, pendingIssuerIdentityBinding, verifiedIssuerIdentityBinding } from './issuer-identity-binding.js';
import { inputManifestHash, lockProductionRulePack, revalidateStoredProductionRulePin, type ReviewedContextLoader, type RuleApplicabilityContextRef } from './production-rule-pin.js';
import { classifyUpdateDifficultyFailure, ensureCurrentUpdateDifficultySnapshotWithClient, type StoredUpdateDifficultySnapshot } from './update-difficulty-repository.js';

export type Principal = { userId: string; csrfVerified: boolean };
export type Settings = { pool?: Pool; blobs?: PrivateBlobs; principal?: (request: FastifyRequest) => Promise<Principal | null>; allowedOrigin?: string; auth?: Omit<AuthConfig,'pool'|'allowedOrigin'>; enableRunStaging?: boolean; enableSyntheticQueue?: boolean; /** #17: queue real runs for the worker runtime (env BB_RUN_RUNTIME_ENABLED=1). */ enableRunRuntime?: boolean; stream?: StreamSettings; /** #35 trial limits; defaults to BB_TRIAL_* configuration. */ trial?: TrialConfig; reviewedContextLoader?: ReviewedContextLoader; /** #79 plaintext route deadline; defaults to 60 seconds. */ promptViewDeadlineMs?: number };
const param = (request: FastifyRequest, name: string) => (request.params as Record<string,string>)[name];
const body = <T>(request: FastifyRequest) => request.body as T;
const now = () => new Date().toISOString();
const MAX_BYTES = M1_UPLOAD_LIMITS.fileBytes;
const DEFAULT_PROJECT_EVENT_PAGE_SIZE = 50;
const MAX_PROJECT_EVENT_PAGE_SIZE = 100;
const [DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE, XLSX_MEDIA_TYPE, CSV_MEDIA_TYPE, TEXT_MEDIA_TYPE, PNG_MEDIA_TYPE, JPEG_MEDIA_TYPE] = M1_UPLOAD_MIME_TYPES;

function stableJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const fields=value as Record<string,unknown>;
    return `{${Object.keys(fields).sort().map(key=>`${JSON.stringify(key)}:${stableJson(fields[key])}`).join(',')}}`;
  }
  const encoded=JSON.stringify(value);
  if(encoded===undefined)throw new Error('Non-JSON request value');
  return encoded;
}

async function appendProjectMaterialEvent(client: PoolClient, ownerId: string, projectId: string, materialId: string, byteSize: number) {
  const allocated = await client.query('UPDATE bb_projects SET event_cursor=event_cursor+1 WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING event_cursor', [ownerId, projectId]);
  if (!allocated.rows[0]) throw missing();
  const payload = { material_id: materialId, uploaded_bytes: byteSize, total_bytes: byteSize };
  await client.query('INSERT INTO bb_project_events(id,owner_user_id,project_id,seq,trace_id,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [uid(), ownerId, projectId, allocated.rows[0].event_cursor, uid(), 'material.upload_progress', payload]);
}

function projectEventCursor(value: string | undefined) {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid project event cursor');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor > 2147483647) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid project event cursor');
  return cursor;
}

function projectEventPageSize(value: string | undefined) {
  if (value === undefined) return DEFAULT_PROJECT_EVENT_PAGE_SIZE;
  if (!/^[1-9][0-9]{0,2}$/.test(value)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid project event page size');
  const limit = Number(value);
  if (limit > MAX_PROJECT_EVENT_PAGE_SIZE) throw new Problem(422, 'VALIDATION_FAILED', 'Project event page size exceeds limit');
  return limit;
}

export function createServer(settings: Settings = {}) {
  // Trust only an explicitly configured reverse proxy for client source addresses.
  // Preflight jobs persist request IDs; keep them unique across server restarts.
  const app = Fastify({ logger: false, genReqId: uid, trustProxy: process.env.BB_TRUSTED_PROXY_CIDR ?? false, bodyLimit: MAX_BYTES + 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const pool = settings.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  const allowedOrigin=settings.allowedOrigin ?? process.env.BB_ALLOWED_ORIGIN;
  const auth:AuthConfig={pool,allowedOrigin,termsVersion:settings.auth?.termsVersion ?? process.env.BB_TERMS_VERSION,supportContact:settings.auth?.supportContact ?? process.env.BB_SUPPORT_CONTACT};
  const blobs = settings.blobs ?? (process.env.AZURE_STORAGE_CONNECTION_STRING ? azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING) : null);
  // Upload bytes stay a stream here; the route authorises first, then spools to disk while hashing.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send({ code: error.code, message: error.message, retryable: error.status === 503, field_errors: [], correlation_id: request.id });
    if (error instanceof Error && 'validation' in error && error.validation) {
      let disposition:{status:number;code:string}={status:422,code:'VALIDATION_FAILED'};
      if ('validationContext' in error && error.validationContext==='body' && request.method==='POST' &&
          (request.routeOptions.url==='/api/v1/runs/execute'||request.routeOptions.url==='/api/v1/projects/:project_id/preflight')) {
        try { disposition=await auditSchemaRejection(request); }
        catch { return reply.code(503).send({code:'DATA_UNAVAILABLE',message:'Rejection evidence unavailable',retryable:true,field_errors:[],correlation_id:request.id}); }
      }
      return reply.code(disposition.status).send({ code: disposition.code, message: disposition.status===422?'Request validation failed':'Request key is bound to another input', retryable: false, field_errors: [], correlation_id: request.id });
    }
    request.log.error(error);
    return reply.code(500).send({ code: 'DATA_UNAVAILABLE', message: 'Internal error', retryable: true, field_errors: [], correlation_id: request.id });
  });
  installAuth(app,auth);
  installAccountRecovery(app,auth);
  // #17: the worker runtime executes queued runs; the synthetic flag remains for older tests.
  const runRuntime=settings.enableRunRuntime ?? process.env.BB_RUN_RUNTIME_ENABLED==='1';
  const queueEnabled=!!settings.enableSyntheticQueue||runRuntime;
  async function owner(request: FastifyRequest) {
    const principal = await (settings.principal ? settings.principal(request) : sessionPrincipal(request,auth));
    if (!principal?.userId || !/^[A-Za-z0-9_-]{1,128}$/.test(principal.userId)) throw new Problem(401,'UNAUTHENTICATED','Trusted session required');
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      if (!principal.csrfVerified || !allowedOrigin || request.headers.origin !== allowedOrigin) throw new Problem(403,'CSRF_DENIED','CSRF or Origin check failed');
    }
    return principal.userId;
  }
  function db() { if (!process.env.DATABASE_URL && !settings.pool) throw unavailable(); return pool; }
  async function auditSchemaRejection(request:FastifyRequest):Promise<{status:number;code:string}> {
    let user:string;
    try { user=await owner(request); } catch(error) { if(error instanceof Problem && [401,403].includes(error.status))return {status:422,code:'VALIDATION_FAILED'}; throw error; }
    const kind=request.routeOptions.url==='/api/v1/runs/execute'?'execute' as const:'preflight' as const;
    const submitted=request.body&&typeof request.body==='object'&&!Array.isArray(request.body)?request.body as Record<string,unknown>:{};
    const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
    const projectId=kind==='preflight'?param(request,'project_id'):submitted.project_id;
    const inputRevision=isPgInputRevision(submitted.input_revision)?submitted.input_revision:undefined;
    const inputHash=typeof submitted.input_hash==='string'&&/^[a-f0-9]{64}$/.test(submitted.input_hash)?submitted.input_hash:undefined;
    const requestId=request.id,traceId=uid();
    return transaction(db(),async client=>{
      const owned=safeId(projectId)&&await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,projectId]);
      if(!owned||!owned.rowCount){
        await recordOperation(client,{owner:user,projectId:null,requestId,traceId,kind,status:'rejected',errorCode:'VALIDATION_FAILED'});
        return {status:422,code:'VALIDATION_FAILED'};
      }
      if(kind==='preflight'){
        await recordLogicalJob(client,{owner:user,projectId,requestId,traceId,kind,jobType:'preflight',status:'rejected',errorCode:'VALIDATION_FAILED',inputRevision,inputHash,stage:'schema_validation',httpStatus:422,schemaRejected:true});
        return {status:422,code:'VALIDATION_FAILED'};
      }
      // A bounded canonical fingerprint permits business-key replay without storing the body.
      const json=JSON.stringify(request.body);
      if(!json||Buffer.byteLength(json,'utf8')>16384){
        await recordOperation(client,{owner:user,projectId,requestId,traceId,kind,status:'rejected',errorCode:'VALIDATION_FAILED',inputRevision,inputHash});
        return {status:422,code:'VALIDATION_FAILED'};
      }
      const requestHash=digest(stableJson(request.body));
      const executionRequestId=validExecutionKey(submitted.execution_request_id)?submitted.execution_request_id:undefined;
      if(executionRequestId){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${executionKeyHash(executionRequestId)}`]);
        const priorRun=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,executionKeyStorage(executionRequestId)]);
        if(priorRun.rows[0]){
          await recordOperation(client,{owner:user,projectId:priorRun.rows[0].project_id,runId:priorRun.rows[0].id,requestId,traceId,kind,status:'rejected',errorCode:'IDEMPOTENCY_CONFLICT'});
          return {status:409,code:'IDEMPOTENCY_CONFLICT'};
        }
      }
      const logged=await recordLogicalJob(client,{owner:user,projectId,requestId,traceId,kind,jobType:'submission',status:'rejected',errorCode:'VALIDATION_FAILED',inputRevision,inputHash,stage:'schema_validation',executionRequestId,requestHash,httpStatus:422,schemaRejected:true});
      return {status:logged.httpStatus!,code:logged.errorCode!};
    });
  }
  function blob() { if (!blobs) throw unavailable(); return blobs; }
  async function verifiedArtifactBytes(artifact:any):Promise<Buffer> {
    let bytes:Buffer|null;
    if(artifact.media_type===WORD_MEDIA_TYPE){
      const expectedSize=Number(artifact.delivery_evidence_byte_size);
      if(!Number.isSafeInteger(expectedSize)||expectedSize<0||expectedSize>DOCX_LIMITS.archiveBytes)
        throw new Problem(503,'DATA_UNAVAILABLE','Artifact integrity check failed');
      try { bytes=await blob().getIfExistsBounded(artifact.object_key,expectedSize); }
      catch { throw new Problem(503,'DATA_UNAVAILABLE','Artifact integrity check failed'); }
      if(!bytes||bytes.length!==expectedSize)throw new Problem(503,'DATA_UNAVAILABLE','Artifact integrity check failed');
    }else{
      bytes=await blob().get(artifact.object_key);
    }
    if(digest(bytes)!==artifact.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Artifact integrity check failed');
    return bytes;
  }
  installAdminRoutes(app,{db,blobs:blob,owner,promptViewDeadlineMs:settings.promptViewDeadlineMs});
  installEventStreams(app,{db,owner},settings.stream);
  const trial=settings.trial ?? trialConfigFromEnv();
  installTrialRoutes(app,{db,blobs,owner,config:trial});
  installPlatformProbeRoutes(app,{db,owner,config:trial}); // #79/#16 operator-only platform probe
  // #35: a trial rejection is still a logged #79 operation and may raise the quota alert.
  async function trialRejected(error:unknown,user:string,kind:string,projectId:string|null,requestId:string){
    if(!(error instanceof TrialLimitProblem))return;
    await rejectOperation(db(),{owner:user,projectId,requestId,traceId:uid(),kind,status:'rejected',errorCode:error.code});
    await reportTrialRejection(db(),error,user);
  }
  app.get('/health', { schema: { response: { 200: schemas.HealthResponse } } }, async () => ({ status: 'ok' as const, service: 'bondbuddy-m1-api-skeleton' as const, implementation: 'health-and-contract-only' as const }));
  app.get('/openapi.json', async () => openApiDocument());
  installLibraryAdminRoutes(app,{db,blobs:blob,owner});
  installFactReviewRoutes(app,{db,owner});
  app.get('/api/v1/projects',{schema:{querystring:schemas.ProjectListQuery,response:{200:schemas.ProjectListResponse}}},async request =>
    listProjects(db(),await owner(request),request.query as import('@sinclair/typebox').Static<typeof schemas.ProjectListQuery>));
  app.post('/api/v1/projects/:project_id/archive',{schema:{body:schemas.ProjectArchiveRequest,response:{200:schemas.ProjectResponse}}},async request =>
    archiveProject(db(),await owner(request),param(request,'project_id'),body<{archived:boolean}>(request).archived));
  app.post('/api/v1/projects',{schema:{body:schemas.ProjectCreateRequest}},async (request,reply) => {
    const user=await owner(request), b=body<{name:string;kind:string;issuer_name:string|null;market:Market|null;offering:Offering|null;update_details?:UpdateDetails}>(request);
    checkedPair(b.market,b.offering);
    const details={...emptyUpdateDetails(),...b.update_details};
    const errors=updateDetailsErrors(details);if(errors.length)throw new Problem(422,'VALIDATION_FAILED',errors[0].message);
    const id=uid(), value=await transaction(db(),async client=>{
      await admitProjectCreate(client,trial,user,sourceHash(request.ip));
      const row=await client.query('INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,user,b.name,b.kind,b.issuer_name,b.market,b.offering,JSON.stringify(details)]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.created',{project_id:id}]);
      return projectDto(row.rows[0]);
    }).catch(async error=>{await trialRejected(error,user,'project_create',null,request.id);throw error;});
    return reply.code(201).send(value);
  });
  app.get('/api/v1/projects/:project_id',async request=>projectDto(await project(db(),await owner(request),param(request,'project_id'))));
  app.patch('/api/v1/projects/:project_id',{schema:{body:schemas.ProjectPatchRequest}},async request=>{
    const user=await owner(request), id=param(request,'project_id'), expected=Number(request.headers['if-match']);
    if (!Number.isInteger(expected)||expected<1) throw new Problem(422,'VALIDATION_FAILED','If-Match draft revision required');
    return transaction(db(),async client=>{
      const old=await project(client,user,id,true);
      if(old.draft_revision!==expected) throw conflict('INPUT_REVISION_CONFLICT','Draft revision changed');
      const b=body<Record<string,unknown>>(request);
      const next={name:b.name ?? old.name,issuer_name:'issuer_name' in b?b.issuer_name:old.issuer_name,market:'market' in b?b.market:old.market,offering:'offering' in b?b.offering:old.offering};
      checkedPair(next.market as Market|null,next.offering as Offering|null);
      const submittedDetails='update_details' in b ? b.update_details as UpdateDetails : undefined;
      const priorDetails={...emptyUpdateDetails(),...old.update_details};
      const details={...emptyUpdateDetails(),...(submittedDetails ?? priorDetails),
        // Compatibility for browsers predating target periods: omission preserves the server value;
        // an explicit [] is the only way to clear the list.
        ...(!submittedDetails || !Object.hasOwn(submittedDetails,'target_reporting_periods')
          ? (priorDetails.target_reporting_periods === undefined ? {} : {target_reporting_periods:priorDetails.target_reporting_periods})
          : {})};
      const errors=updateDetailsErrors(details);if(errors.length)throw new Problem(422,'VALIDATION_FAILED',errors[0].message);
      const result=await client.query('UPDATE bb_projects SET name=$3,issuer_name=$4,market=$5,offering=$6,update_details=$7,draft_revision=draft_revision+1,updated_at=now() WHERE owner_user_id=$1 AND id=$2 RETURNING *',[user,id,next.name,next.issuer_name,next.market,next.offering,JSON.stringify(details)]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.draft_updated',{project_id:id,draft_revision:result.rows[0].draft_revision}]);
      return projectDto(result.rows[0]);
    });
  });
  // #6: public, unauthenticated policy numbers rendered by the upload area and the data-policy page.
  app.get('/api/v1/data-policy',{schema:{response:{200:dataLifecycleSchemas.DataPolicyResponse}}},async (_request,reply)=>{
    let policy;
    try { policy=dataPolicyFromEnv(); } catch { throw new Problem(503,'DATA_UNAVAILABLE','Data policy configuration is invalid'); }
    return reply.header('cache-control','public, max-age=300').send(policy);
  });
  app.delete('/api/v1/projects/:project_id',async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id');
    await transaction(db(),async client=>{
      const found=await client.query('SELECT deleted_at FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[user,id]);
      if(!found.rows[0])throw missing();
      if(found.rows[0].deleted_at!==null)return; // Owned repeat deletion is idempotent.
      const active=await client.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND state NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1",[user,id]);
      if(active.rows[0])throw conflict('PROJECT_DELETE_BLOCKED','Cancel or finish active runs before deleting the project');
      // Material soft deletion writes 0006 storage tombstones; 0026 purges derived content after the same window.
      const materials=await client.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL',[user,id]);
      const artifacts=await client.query("UPDATE bb_artifact_versions a SET delivery_status='revoked' FROM bb_runs r WHERE r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.owner_user_id=$1 AND r.project_id=$2 AND a.delivery_status<>'revoked' RETURNING a.id,a.version",[user,id]);
      for(const a of artifacts.rows)await client.query('DELETE FROM bb_artifact_download_grants WHERE owner_user_id=$1 AND artifact_id=$2 AND artifact_version=$3',[user,a.id,a.version]);
      await client.query('UPDATE bb_projects SET deleted_at=now(),updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id]);
      await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'project.deleted',$4)",[uid(),user,id,{material_versions_deleted:materials.rowCount??0,artifacts_revoked:artifacts.rowCount??0}]);
    });
    return reply.code(204).send();
  });
  app.post('/api/v1/projects/:project_id/input-revisions',{schema:{body:schemas.InputRevisionCreateRequest}},async (request,reply)=>{
    const user=await owner(request), id=param(request,'project_id');
    const b=body<{draft_revision:number;material_versions:{material_id:string;material_version:number}[];requirement_message_ids:string[];rule_applicability_context_ref?:RuleApplicabilityContextRef}>(request);
    if(b.requirement_message_ids.length) throw unavailable(); // #7/#conversation persistence must authenticate these associations.
    const result=await transaction(db(),async client=>{
      const p=await project(client,user,id,true);
      if(p.draft_revision!==b.draft_revision) throw conflict('INPUT_REVISION_CONFLICT','Draft revision changed');
      const refs=[...b.material_versions].sort((a,z)=>a.material_id.localeCompare(z.material_id)||a.material_version-z.material_version);
      if(new Set(refs.map(r=>r.material_id)).size!==refs.length) throw new Problem(422,'VALIDATION_FAILED','Duplicate material IDs');
      const resolved=[];
      for(const ref of refs){const q=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL FOR SHARE',[user,id,ref.material_id,ref.material_version]);if(!q.rows[0])throw missing();resolved.push({material_id:ref.material_id,material_version:ref.material_version,role:q.rows[0].role,sha256:q.rows[0].sha256.trim()});}
      let issuerIdentity: ReturnType<typeof pendingIssuerIdentityBinding> | ReturnType<typeof verifiedIssuerIdentityBinding> | undefined;
      if(p.kind==='update'){
        const historical=resolved.filter(ref=>ref.role==='historical');
        const historicalMaterials=historical.map(ref=>({material_id:ref.material_id,material_version:ref.material_version}));
        if(historical.length!==1){
          issuerIdentity=pendingIssuerIdentityBinding(historical.length===0?'historical_material_not_selected':'historical_material_selection_ambiguous',historicalMaterials);
        }else{
          const selected=historical[0]!;
          const verified=await loadVerifiedIssuerIdentitySourceRecord(client,{ownerUserId:user,projectId:id,materialId:selected.material_id,materialVersion:selected.material_version});
          if(!verified){
            issuerIdentity=pendingIssuerIdentityBinding('issuer_identity_source_missing_unreviewed_or_conflicting',historicalMaterials);
          }else{
            if(verified.materialId!==selected.material_id||verified.materialVersion!==selected.material_version)throw new Error('ISSUER_IDENTITY_SCOPE_MISMATCH');
            issuerIdentity=verifiedIssuerIdentityBinding(verified);
          }
        }
      }
      const revision=(p.latest_input_revision??0)+1;
      // Update generation must only see the reviewed historical issuer name, never the browser draft label.
      const manifest={draft_revision:p.draft_revision,name:p.name,kind:p.kind,issuer_name:p.kind==='update'?(issuerIdentity?.status==='verified'?issuerIdentity.issuer_display_name:null):p.issuer_name,market:p.market,offering:p.offering,update_details:projectDto(p).update_details,materials:resolved,requirement_message_ids:[],rule_pack_version:null,template_version:null,reference_release:null};
      if(p.kind==='update'){
        Object.assign(manifest,{issuer_identity:issuerIdentity,issuer_entity_id:issuerIdentity?.status==='verified'?issuerIdentity.entity_id:null});
      }
      const ruleBinding=await lockProductionRulePack(client,p,{draftRevision:p.draft_revision,materials:resolved},
        issuerIdentity?.status==='verified'?issuerIdentity:undefined,b.rule_applicability_context_ref,settings.reviewedContextLoader);
      Object.assign(manifest,{manifest_schema:'production_rule_pin_v1',rule_pack_selection:ruleBinding.status,
        rule_pack_block_reasons:ruleBinding.status==='blocked'?ruleBinding.reasons:[],
        rule_pack_pin:ruleBinding.status==='selected'?ruleBinding.pin:null,
        rule_pack_context:ruleBinding.status==='selected'?ruleBinding.pin.applicabilityContext:null,
        rule_applicability_pin:ruleBinding.status==='selected'?ruleBinding.applicability:null,
        rule_pack_snapshot_refs:ruleBinding.status==='selected'?{
          release_event_id:ruleBinding.pin.releaseEventId,
          pack_id:ruleBinding.pin.packId,pack_version:ruleBinding.pin.version,pack_hash:ruleBinding.pin.contentHash,
          template_id:ruleBinding.pin.templateId,template_version:ruleBinding.pin.templateVersion,template_hash:ruleBinding.pin.templateHash,
          coverage_id:ruleBinding.pin.coverageId,coverage_version:ruleBinding.pin.coverageVersion,coverage_hash:ruleBinding.pin.coverageHash,
        }:null,
        rule_pack_version:ruleBinding.status==='selected'?ruleBinding.pin.version:null,
        template_version:ruleBinding.status==='selected'?ruleBinding.pin.templateVersion:null});
      const hash=inputManifestHash(manifest);
      const q=await client.query('INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[id,revision,user,p.draft_revision,hash,manifest,JSON.stringify(refs),'[]',ruleBinding.status==='selected'?ruleBinding.pin.version:null,ruleBinding.status==='selected'?ruleBinding.pin.templateVersion:null]);
      await client.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.input_locked',{project_id:id,input_revision:revision,input_hash:hash}]);
      return inputDto(q.rows[0]);
    });
    return reply.code(201).send(result);
  });
  app.get('/api/v1/projects/:project_id/input-revisions/:input_revision',async request=>{
    const user=await owner(request),id=param(request,'project_id');await project(db(),user,id);
    const q=await db().query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,id,Number(param(request,'input_revision'))]);
    if(!q.rows[0])throw missing();return inputDto(q.rows[0]);
  });
  app.post('/api/v1/projects/:project_id/materials/uploads',{schema:{body:schemas.UploadCreateRequest}},async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),b=body<{filename:string;media_type:string;byte_size:number;sha256:string;role:string}>(request);
    await project(db(),user,id);blob();
    if(b.byte_size>MAX_BYTES)throw new Problem(422,'VALIDATION_FAILED','Upload exceeds limit');
    const suffix=b.filename.toLowerCase().split('.').at(-1);
    const expectedExtensions:Record<string,string[]>={[PDF_MEDIA_TYPE]:['pdf'],[DOCX_MEDIA_TYPE]:['docx'],[XLSX_MEDIA_TYPE]:['xlsx'],[CSV_MEDIA_TYPE]:['csv'],[TEXT_MEDIA_TYPE]:['txt'],[PNG_MEDIA_TYPE]:['png'],[JPEG_MEDIA_TYPE]:['jpg','jpeg']};
    if(!suffix || !expectedExtensions[b.media_type]?.includes(suffix))throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Filename extension and declared type differ');
    const uploadId=uid(),key=`users/${user}/projects/${id}/uploads/${uploadId}`,expires=new Date(Date.now()+15*60_000);
    await transaction(db(),async client=>{
      await admitUploadCreate(client,trial,user,sourceHash(request.ip),b.byte_size);
      await client.query('INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[uploadId,user,id,b.filename,b.media_type,b.byte_size,b.sha256,b.role,key,expires]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'upload',uploadId,'upload.created',{project_id:id}]);
    }).catch(async error=>{await trialRejected(error,user,'upload_create',id,request.id);throw error;});
    return reply.code(201).send({upload_id:uploadId,state:'uploading',upload_url:`/api/v1/projects/${id}/materials/uploads/${uploadId}/bytes`,expires_at:expires.toISOString(),max_bytes:MAX_BYTES});
  });
  app.put('/api/v1/projects/:project_id/materials/uploads/:upload_id/bytes',async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),uploadId=param(request,'upload_id');await project(db(),user,id);
    const stream=request.body as Readable|undefined;if(!stream||typeof stream.pipe!=='function')throw new Problem(422,'VALIDATION_FAILED','Binary upload required');
    // Reject unknown, finished or expired uploads before accepting any bytes; the locked re-check below stays authoritative.
    const pre=(await db().query('SELECT state,byte_size,expires_at FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,uploadId])).rows[0];
    if(!pre)throw missing();
    if(pre.state==='completed')throw conflict('IDEMPOTENCY_CONFLICT','Upload already completed');
    if(pre.state!=='uploading'&&pre.state!=='received')throw missing();
    if(new Date(pre.expires_at).getTime()<Date.now())throw new Problem(422,'VALIDATION_FAILED','Upload expired');
    const declared=Number(pre.byte_size),length=request.headers['content-length'];
    const mismatch=()=>new Problem(422,'MATERIAL_CONTENT_MISMATCH','Bytes or hash mismatch');
    if(length!==undefined&&Number(length)!==declared)throw mismatch();
    const release=reserveSpool(declared);let spooled:Spooled|undefined;
    try{
      spooled=await spoolStream(stream,declared,mismatch);
      const bytes=spooled;
      await transaction(db(),async client=>{
        const q=await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,uploadId]);const u=q.rows[0];if(!u)throw missing();
        if((await client.query('SELECT 1 FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND upload_id=$2',[user,uploadId])).rowCount)throw conflict('IDEMPOTENCY_CONFLICT','Upload already resolved; retry completion');
        if(u.state==='completed')throw conflict('IDEMPOTENCY_CONFLICT','Upload already completed');
        if(u.state!=='uploading'&&u.state!=='received')throw missing();
        if(new Date(u.expires_at).getTime()<Date.now())throw new Problem(422,'VALIDATION_FAILED','Upload expired');
        if(bytes.byteSize!==Number(u.byte_size)||bytes.sha256!==u.sha256.trim())throw mismatch();
        await verifiedMediaFile(bytes.path,bytes.byteSize,u.declared_media_type);
        if(u.state==='received'){
          if(u.received_sha256?.trim()!==bytes.sha256||Number(u.received_bytes)!==bytes.byteSize)throw new Problem(503,'DATA_UNAVAILABLE','Stored upload receipt is inconsistent');
          const stored=await readBlobToFile(blob(),u.object_key,null,MAX_BYTES).catch(error=>{if(error instanceof Problem)return null;throw error;});
          if(stored===null||stored.byteSize!==bytes.byteSize||stored.sha256!==u.sha256.trim()){
            await putBlobFile(blob(),u.object_key,bytes.path,u.declared_media_type);
            const restored=await readBlobToFile(blob(),u.object_key,null,MAX_BYTES);
            if(!restored||restored.byteSize!==bytes.byteSize||restored.sha256!==u.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Upload bytes could not be restored');
          }
          return;
        }
        // The upload row lock is shared with completion and orphan cleanup. Keep it until Blob and DB state agree.
        await putBlobFile(blob(),u.object_key,bytes.path,u.declared_media_type);
        const updated=await client.query("UPDATE bb_uploads SET state='received',received_sha256=$4,received_bytes=$5 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND state='uploading'",[user,id,uploadId,bytes.sha256,bytes.byteSize]);
        if(updated.rowCount!==1)throw new Problem(503,'DATA_UNAVAILABLE','Upload state changed before bytes were recorded');
        await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'upload',uploadId,'upload.received',{project_id:id,byte_size:bytes.byteSize}]);
      });
    }finally{
      await discardSpool(spooled?.path);release();
    }
    return reply.code(204).send();
  });
  app.post('/api/v1/projects/:project_id/materials/uploads/:upload_id/complete',{schema:{body:schemas.UploadCompleteRequest}},async request=>{
    const user=await owner(request),id=param(request,'project_id'),uploadId=param(request,'upload_id'),b=body<{byte_size:number;sha256:string}>(request);
    const traceId=uid();
    try { return await transaction(db(),async client=>{
      // Same lock order as deletion/snapshot creation; concurrent equal uploads resolve once.
      await project(client,user,id,true);
      const q=await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,uploadId]);const u=q.rows[0];if(!u)throw missing();
      if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
      const receipt=await client.query('SELECT material_id,material_version FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId]);
      // The parse job, its outbox/log rows and the #79 operation commit with the verified completion.
      const accepted=async (m:any)=>{
        await enqueueMaterialParse(client,{owner:user,projectId:id,materialId:m.id,materialVersion:m.version,sha256:m.sha256.trim(),traceId});
        await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'material_complete',status:'submitted'});
        return materialDto(m);
      };
      const checkedMaterial=async (m:any)=>{
        if(!m)throw missing();
        const stored=await readBlobToFile(blob(),m.object_key,null,Number(m.byte_size)).catch(error=>{if(error instanceof Problem)return null;throw error;});
        if(!stored||stored.byteSize!==Number(m.byte_size)||stored.sha256!==m.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Saved material is temporarily unavailable');
        return accepted(m);
      };
      if(receipt.rows[0]){
        const r=receipt.rows[0];
        const existing=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[user,id,r.material_id,r.material_version]);
        return checkedMaterial(existing.rows[0]);
      }
      if(u.state==='completed'){const existing=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND upload_id=$2 AND deleted_at IS NULL',[user,uploadId]);return checkedMaterial(existing.rows[0]);}
      if(u.state==='deleting'||u.state==='purged')throw missing();
      if(u.state!=='received')throw new Problem(422,'MATERIAL_UNREADABLE','Upload bytes not received');
      // Re-verify the stored object from a disk copy: hash while streaming, then inspect the file.
      const release=reserveSpool(b.byte_size),copy=join(spoolDirectory(),`${uid()}.blob`);
      let media:string;
      try{
        await mkdir(spoolDirectory(),{recursive:true,mode:0o700});
        const stored=await readBlobToFile(blob(),u.object_key,copy,MAX_BYTES).catch(error=>{if(error instanceof Problem&&error.status===413)return false as const;throw error;});
        if(stored===null)throw new Problem(503,'DATA_UNAVAILABLE','Stored upload bytes are temporarily unavailable');
        if(!stored||stored.byteSize!==b.byte_size||stored.sha256!==b.sha256)throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Stored bytes or hash mismatch');
        media=await verifiedMediaFile(copy,stored.byteSize,u.declared_media_type);
      }finally{await discardSpool(copy);release();}
      const duplicate=await client.query(`SELECT * FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND role=$3 AND sha256=$4 AND byte_size=$5 AND media_type=$6 AND deleted_at IS NULL
        ORDER BY persisted_at,id,version LIMIT 1`,[user,id,u.role,b.sha256,b.byte_size,media]);
      if(duplicate.rows[0]){
        const m=duplicate.rows[0], result=await checkedMaterial(m);
        await client.query('INSERT INTO bb_upload_reuse_receipts(upload_id,owner_user_id,project_id,material_id,material_version) VALUES($1,$2,$3,$4,$5)',[uploadId,user,id,m.id,m.version]);
        await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'upload',$3,'upload.reused',$4)",[uid(),user,uploadId,{project_id:id,material_id:m.id,material_version:m.version}]);
        return result;
      }
      const capacity=(await client.query('SELECT count(*)::int AS files,COALESCE(sum(byte_size),0)::bigint AS bytes FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL',[user,id])).rows[0];
      if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+b.byte_size>M1_UPLOAD_LIMITS.projectBytes)
        throw new Problem(422,'VALIDATION_FAILED','Project material limit: 60 files / 500 MiB');
      const materialId=uid();
      const inserted=await client.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted') RETURNING *",[materialId,user,id,uploadId,u.role,u.filename,media,b.byte_size,b.sha256,u.object_key]);
      await client.query("UPDATE bb_uploads SET state='completed' WHERE owner_user_id=$1 AND id=$2",[user,uploadId]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'material',materialId,'material.persisted',{material_id:materialId,material_version:1,project_id:id}]);
      await appendProjectMaterialEvent(client, user, id, materialId, Number(inserted.rows[0].byte_size));
      return accepted(inserted.rows[0]);
    }); } catch(error) {
      if(error instanceof Problem){
        const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,id]);
        await rejectOperation(db(),{owner:user,projectId:owned.rowCount?id:null,requestId:request.id,traceId,kind:'material_complete',status:'rejected',errorCode:error.code});
      }
      throw error;
    }
  });
  app.get('/api/v1/projects/:project_id/materials/:material_id',async request=>{
    const m=await material(db(),await owner(request),param(request,'project_id'),param(request,'material_id'));
    try { if(!await blob().exists(m.object_key)) throw missing(); }
    catch(error) {
      if(error instanceof Problem) throw error;
      throw new Problem(503,'DATA_UNAVAILABLE','Material storage is temporarily unavailable');
    }
    return materialDto(m);
  });
  app.get('/api/v1/projects/:project_id/materials/:material_id/download',async (request,reply)=>{
    const m=await material(db(),await owner(request),param(request,'project_id'),param(request,'material_id'));
    return sendMaterial(reply,db(),blob(),m);
  });
  app.delete('/api/v1/projects/:project_id/materials/:material_id',async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),materialId=param(request,'material_id');
    await transaction(db(),async client=>{
      // Snapshot creation takes this same project lock, so a new immutable reference cannot race deletion.
      await project(client,user,id,true);
      const found=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 ORDER BY version DESC FOR UPDATE',[user,id,materialId]);
      if(!found.rows.length)throw missing();
      const live=found.rows.filter(row=>row.deleted_at===null);
      if(!live.length)return; // Owned repeat deletion is idempotent and emits no duplicate side effects.
      const deleted=await client.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING *',[user,id,materialId]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'material',materialId,'material.deleted',{project_id:id,versions:deleted.rows.length}]);
    });
    return reply.code(204).send();
  });
  app.get('/api/v1/projects/:project_id/events',{schema:{response:{200:schemas.ProjectEventsResponse}}},async request=>{
    const user=await owner(request),id=param(request,'project_id');
    // Check ownership before parsing attacker-controlled cursor/limit values.
    await project(db(),user,id);
    const query=request.query as {after?:string;limit?:string};
    const after=projectEventCursor(query.after),limit=projectEventPageSize(query.limit);
    const result=await db().query(`
      SELECT e.id,e.trace_id,e.project_id,e.seq,e.occurred_at,e.type,e.payload
        FROM bb_project_events e
       WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.seq>$3
         AND EXISTS (
           SELECT 1 FROM bb_material_versions m
           JOIN bb_uploads u ON u.owner_user_id=m.owner_user_id AND u.id=m.upload_id AND u.state='completed'
            WHERE m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
              AND m.id=e.payload->>'material_id' AND m.deleted_at IS NULL
         )
       ORDER BY e.seq ASC LIMIT $4`,[user,id,after,limit+1]);
    const hasMore=result.rows.length>limit,rows=result.rows.slice(0,limit);
    const items=rows.map(event=>({event_id:event.id,schema_version:1 as const,trace_id:event.trace_id,project_id:event.project_id,seq:Number(event.seq),occurred_at:date(event.occurred_at),type:event.type,payload:{material_id:event.payload.material_id,uploaded_bytes:event.payload.uploaded_bytes,total_bytes:event.payload.total_bytes}}));
    return {items,next_cursor:hasMore?items.at(-1)!.seq:null};
  });
  app.post('/api/v1/runs/execute',{schema:{body:schemas.ExecuteRequest}},async (request,reply)=>{
    const user=await owner(request);
    const b=body<{execution_request_id:string;project_id:string;input_revision:number;input_hash:string;task_kind:string;input_manifest_ref:string;storage_origin:string;workspace_id:string}>(request);
    const traceId=uid();
    const requestHash=digest(canonical({project_id:b.project_id,input_revision:b.input_revision,input_hash:b.input_hash,task_kind:b.task_kind,input_manifest_ref:b.input_manifest_ref,storage_origin:b.storage_origin,workspace_id:b.workspace_id}));
    const storedExecutionKey=executionKeyStorage(b.execution_request_id);
    const wideRevision=!isPgInputRevision(b.input_revision);
    const logical=(errorCode:string,httpStatus:number,stage:string)=>({owner:user,projectId:b.project_id,requestId:request.id,traceId,kind:'execute' as const,jobType:b.task_kind as 'update'|'review'|'generation'|'qa',status:'rejected' as const,errorCode,inputRevision:wideRevision?undefined:b.input_revision,inputHash:wideRevision?undefined:b.input_hash,stage,executionRequestId:b.execution_request_id,requestHash,httpStatus,revisionRejected:wideRevision&&stage==='revision_out_of_range'});
    const priorRejection=async(client:PoolClient,prior:any)=>{
      if(wideRevision){
        const same=prior.request_hash.trim()===requestHash;
        await recordOperation(client,{owner:user,projectId:prior.project_id,jobId:prior.id,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:same?prior.error_code:'IDEMPOTENCY_CONFLICT'});
        return {errorCode:same?prior.error_code as string:'IDEMPOTENCY_CONFLICT',httpStatus:same?prior.rejection_http_status as number:409};
      }
      const logged=await recordLogicalJob(client,logical(prior.error_code,prior.rejection_http_status,prior.stage));
      return {errorCode:logged.errorCode!,httpStatus:logged.httpStatus!};
    };
    if(!settings.enableRunStaging && !queueEnabled){
      const response=await transaction(db(),async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${executionKeyHash(b.execution_request_id)}`]);
        const old=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,storedExecutionKey]);
        if(old.rows[0]){
          const same=old.rows[0].request_hash.trim()===requestHash;
          await recordOperation(client,{owner:user,projectId:old.rows[0].project_id,runId:old.rows[0].id,requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,inputHash:same?b.input_hash:undefined});
          return same?{run:runDto(old.rows[0])}:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409};
        }
        const prior=await client.query("SELECT id,project_id,request_hash,error_code,rejection_http_status,stage FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2 AND subtype IN ('execute_rejected','execute_schema_rejected')",[user,executionKeyHash(b.execution_request_id)]);
        if(prior.rows[0])return priorRejection(client,prior.rows[0]);
        const owned=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,b.project_id]);
        if(!owned.rowCount){await recordOperation(client,{owner:user,projectId:null,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:'CAPABILITY_NOT_READY'});return {errorCode:'CAPABILITY_NOT_READY',httpStatus:501};}
        if(wideRevision){const logged=await recordLogicalJob(client,logical('VALIDATION_FAILED',422,'revision_out_of_range'));return {errorCode:logged.errorCode!,httpStatus:logged.httpStatus!};}
        const logged=await recordLogicalJob(client,logical('CAPABILITY_NOT_READY',501,'capability_not_ready'));
        return {errorCode:logged.errorCode!,httpStatus:logged.httpStatus!};
      });
      if('run' in response)return reply.code(202).send(response.run);
      throw new Problem(response.httpStatus,response.errorCode,'Execution request was rejected');
    }
    let result;
    try {result=await transaction(db(),async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${executionKeyHash(b.execution_request_id)}`]);
      const old=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,storedExecutionKey]);
      if(old.rows[0]){
        const same=old.rows[0].request_hash.trim()===requestHash;
        await recordOperation(client,{owner:user,projectId:old.rows[0].project_id,runId:old.rows[0].id,requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,inputHash:same?b.input_hash:undefined});
        return same?runDto(old.rows[0]):{rejection:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409}};
      }
      const prior=await client.query("SELECT id,project_id,request_hash,error_code,rejection_http_status,stage FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2 AND subtype IN ('execute_rejected','execute_schema_rejected')",[user,executionKeyHash(b.execution_request_id)]);
      if(prior.rows[0])return {rejection:await priorRejection(client,prior.rows[0])};
      await project(client,user,b.project_id);
      if(wideRevision)throw new Problem(422,'VALIDATION_FAILED','Input revision exceeds storage range');
      const input=await client.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,b.project_id,b.input_revision]);
      if(!input.rows[0])throw missing();
      if(input.rows[0].input_hash.trim()!==b.input_hash)throw conflict('INPUT_REVISION_CONFLICT','Input hash changed');
      await admitRunSubmit(client,trial,user,sourceHash(request.ip));
      const runId=uid(),trace=uid(),eventId=uid();
      const q=await client.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,event_cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0) RETURNING *",[runId,user,b.project_id,b.input_revision,b.input_hash,storedExecutionKey,b.task_kind,requestHash,queueEnabled?'queued':'paused']);
      await recordOperation(client,{owner:user,projectId:b.project_id,runId,requestId:request.id,traceId:runId,kind:'execute',status:'submitted',inputRevision:b.input_revision,inputHash:b.input_hash});
      if(queueEnabled) {
        await enqueue(client,q.rows[0],runRuntime?RUN_PIPELINE_SUBTYPE:'default');
        return runDto({...q.rows[0],state:'queued',stage:'queued',event_cursor:1,updated_at:new Date()});
      }
      await client.query("UPDATE bb_runs SET event_cursor=1 WHERE id=$1",[runId]);
      await client.query("INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,payload) VALUES($1,$2,$3,1,$4,'run.state_changed','paused',$5)",[eventId,user,runId,trace,{reason:'capability_not_ready'}]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'run',runId,'run.staged',{run_id:runId,event_id:eventId}]);
      return runDto({...q.rows[0],event_cursor:1});
    });} catch(error) {
      if(error instanceof Problem){
        const disposition=await transaction(db(),async client=>{
          // The validation transaction released its lock on rollback. Recheck under
          // the same business-key lock before recording a terminal rejection.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${executionKeyHash(b.execution_request_id)}`]);
          const priorRun=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,storedExecutionKey]);
          if(priorRun.rows[0]){
            const same=priorRun.rows[0].request_hash.trim()===requestHash;
            await recordOperation(client,{owner:user,projectId:priorRun.rows[0].project_id,runId:priorRun.rows[0].id,requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,inputHash:same?b.input_hash:undefined});
            return same?{run:runDto(priorRun.rows[0])}:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409,replay:true};
          }
          const owned=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,b.project_id]);
          if(owned.rowCount){
            const logged=await recordLogicalJob(client,logical(error.code,error.status,wideRevision?'revision_out_of_range':'submission_rejected'));
            return {errorCode:logged.errorCode!,httpStatus:logged.httpStatus!,replay:logged.replay};
          }
          await recordOperation(client,{owner:user,projectId:null,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:error.code});
          return {errorCode:error.code,httpStatus:error.status,replay:false};
        });
        if('run' in disposition)return reply.code(202).send(disposition.run);
        if(!disposition.replay)await reportTrialRejection(db(),error,user);
        throw new Problem(disposition.httpStatus,disposition.errorCode,!disposition.replay&&disposition.errorCode===error.code?error.message:'Execution request was rejected');
      }
      throw error;
    }
    if('rejection' in result)throw new Problem(result.rejection.httpStatus,result.rejection.errorCode,'Execution request was rejected');
    return reply.code(202).send(result);
  });
  app.get('/api/v1/runs/:run_id',async request=>runDto(await run(db(),await owner(request),param(request,'run_id'))));
  app.get('/api/v1/runs/:run_id/events',async request=>{
    const user=await owner(request),id=param(request,'run_id');await run(db(),user,id);
    const after=Number((request.query as {after?:string}).after??0);if(!Number.isSafeInteger(after)||after<0)throw new Problem(422,'VALIDATION_FAILED','Invalid cursor');
    const q=await db().query('SELECT * FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 AND seq>$3 ORDER BY seq LIMIT 100',[user,id,after]);
    const items=q.rows.map(e=>({event_id:e.id,schema_version:1,trace_id:e.trace_id,run_id:e.run_id,seq:e.seq,occurred_at:date(e.occurred_at),stage:e.stage,type:e.type,state:e.state,payload:e.payload}));
    return {items,next_cursor:items.length?items.at(-1)!.seq:after};
  });
  for(const kind of ['cancel','resume'] as const) app.post(`/api/v1/runs/:run_id/${kind}`,{schema:{body:schemas.RunActionRequest}},async request=>{
    const user=await owner(request),id=param(request,'run_id');await run(db(),user,id);
    if(!queueEnabled)throw unavailable();
    return queueAction(db(),user,id,kind);
  });
  app.get('/api/v1/artifacts/:artifact_id',async request=>{
    const user=await owner(request),id=param(request,'artifact_id');
    const q=await db().query(`SELECT a.*,e.byte_size AS delivery_evidence_byte_size FROM bb_artifact_versions a
      JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state='succeeded'
      LEFT JOIN bb_word_delivery_evidence e ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.id=$2 AND a.quality_status='passed' AND a.delivery_status='available' ORDER BY a.version DESC LIMIT 1`,[user,id]);
    if(!q.rows[0])throw missing();const a=q.rows[0];await verifiedArtifactBytes(a);
    const pairRow=await db().query("SELECT checkpoint->'stages'->'word_delivery_pair' AS pair FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2",[user,a.run_id]);
    const pair=pairRow.rows[0]?.pair as Record<string,unknown>|undefined;
    const variant=pair?.revision_artifact_id===a.id?'revision':pair?.clean_artifact_id===a.id?'clean':pair?.baseline_artifact_id===a.id?'baseline':null;
    const wordDelivery=variant ? {variant,revision_artifact_id:pair!.revision_artifact_id,clean_artifact_id:pair!.clean_artifact_id,
      baseline_artifact_id:pair!.baseline_artifact_id,writer_version:pair!.writer_version,
      source_sha256:pair!.source_sha256,baseline_hash:pair!.baseline_hash,
      effective_baseline_sha256:pair!.effective_baseline_sha256,plan_hash:pair!.plan_hash,
      replacements:pair!.replacements,columns:pair!.columns,pending_review_count:pair!.pending,
      pending_review:pair!.pending_review} : undefined;
    const grant=uid(),expires=new Date(Date.now()+5*60_000);
    await db().query('INSERT INTO bb_artifact_download_grants(token_hash,owner_user_id,artifact_id,artifact_version,expires_at) VALUES($1,$2,$3,$4,$5)',[digest(grant),user,id,a.version,expires]);
    return {artifact_id:a.id,run_id:a.run_id,version:a.version,media_type:a.media_type,sha256:a.sha256.trim(),quality_status:a.quality_status,delivery_status:a.delivery_status,download_url:`/api/v1/artifacts/${id}/download?grant=${grant}`,expires_at:expires.toISOString(),...(wordDelivery?{word_delivery:wordDelivery}:{})};
  });
  app.get('/api/v1/artifacts/:artifact_id/download',async (request,reply)=>{
    const user=await owner(request),id=param(request,'artifact_id');
    const q=await db().query(`SELECT a.*,e.byte_size AS delivery_evidence_byte_size FROM bb_artifact_versions a
      JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state='succeeded'
      LEFT JOIN bb_word_delivery_evidence e ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.id=$2 AND a.quality_status='passed' AND a.delivery_status='available' ORDER BY a.version DESC LIMIT 1`,[user,id]);
    if(!q.rows[0])throw missing();const a=q.rows[0],grant=(request.query as {grant?:string}).grant;
    if(!grant)throw missing();const g=await db().query('SELECT 1 FROM bb_artifact_download_grants WHERE token_hash=$1 AND owner_user_id=$2 AND artifact_id=$3 AND artifact_version=$4 AND expires_at>now()',[digest(grant),user,id,a.version]);if(!g.rows[0])throw missing();
    const bytes=await verifiedArtifactBytes(a);
    return reply.header('content-type',a.media_type).header('cache-control','private, no-store').send(bytes);
  });
  const ocrPath='/api/v1/projects/:project_id/materials/:material_id/ocr';
  app.get(ocrPath,{schema:{response:{200:schemas.OcrReview}}},async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    return readOcr(db(),blob(),await owner(request),param(request,'project_id'),param(request,'material_id'));
  });
  app.get(`${ocrPath}/pages/:snapshot_id/:page`,async(request,reply)=>{
    const bytes=await readOcrPage(db(),blob(),await owner(request),param(request,'project_id'),param(request,'material_id'),param(request,'snapshot_id'),param(request,'page'));
    return reply.header('content-type','image/png').header('x-content-type-options','nosniff').header('cache-control','private, no-store').send(bytes);
  });
  app.post(`${ocrPath}/corrections`,{schema:{body:schemas.OcrCorrectionRequest,response:{201:schemas.OcrCorrection}}},async(request,reply)=>{
    const result=await correctOcr(db(),blob(),await owner(request),param(request,'project_id'),param(request,'material_id'),body<OcrCorrectionRequest>(request));
    return reply.code(201).send(result);
  });
  const sourceProfile='/api/v1/projects/:project_id/materials/:material_id/source-profile';
  const parseJob='/api/v1/projects/:project_id/materials/:material_id/parse-job';
  app.get(parseJob,{schema:{response:{200:schemas.MaterialParseJobResponse}}},async request=>
    materialParseJobDto(await readMaterialParseJob(db(),await owner(request),param(request,'project_id'),param(request,'material_id'))));
  app.post(`${parseJob}/cancel`,{schema:{body:schemas.RunActionRequest,response:{200:schemas.MaterialParseJobResponse}}},async request=>{
    const user=await owner(request),id=param(request,'project_id'),materialId=param(request,'material_id'),traceId=uid();
    try {
      return await transaction(db(),async client=>{
        await project(client,user,id);
        const job=await cancelMaterialParse(client,user,id,materialId);
        await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:job.trace_id,kind:'material_parse_cancel',status:'submitted'});
        return materialParseJobDto(job);
      });
    } catch(error) {
      if(error instanceof Problem){
        const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,id]);
        await rejectOperation(db(),{owner:user,projectId:owned.rowCount?id:null,requestId:request.id,traceId,kind:'material_parse_cancel',status:'rejected',errorCode:error.code});
      }
      throw error;
    }
  });
  app.get(sourceProfile,{schema:{response:{200:schemas.RecognitionResponse}}},async(request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),m=await material(db(),user,id,param(request,'material_id'));
    // Source profiles exist only for historical prospectus partitions; other materials share the owner-safe 404.
    if(m.role!=='historical'||![DOCX_MEDIA_TYPE,PDF_MEDIA_TYPE].includes(m.media_type))throw missing();
    reply.header('cache-control','private, no-store');
    const profile=await db().query(`SELECT recognition FROM bb_historical_profiles WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      ORDER BY profile_version DESC LIMIT 1`,[user,id,m.id,m.version]);
    if(profile.rows[0])return profile.rows[0].recognition;
    const job=await readMaterialParseJob(db(),user,id,m.id).catch(error=>{if(error instanceof Problem&&error.status===404)return null;throw error;});
    // Never synthesize a recognition: the durable job has not produced one yet (or failed).
    if(job?.state==='failed')throw new Problem(409,job.error_code,'Source profile parse job failed');
    throw new Problem(409,'CAPABILITY_NOT_READY','Source profile is pending its durable parse job');
  });
  app.patch(sourceProfile,{schema:{body:schemas.RecognitionPatchRequest,response:{200:schemas.RecognitionResponse}}},async(request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),materialId=param(request,'material_id');
    const m=await material(db(),user,id,materialId);
    if(m.role!=='historical'||![DOCX_MEDIA_TYPE,PDF_MEDIA_TYPE].includes(m.media_type))throw missing();
    const traceId=uid();
    try {
      const header=request.headers['if-match'];
      if(typeof header!=='string'||!/^(?:[1-9][0-9]{0,9})$/.test(header))throw new Problem(422,'VALIDATION_FAILED','If-Match profile version required');
      const expected=Number(header),patch=body<{profile_version:number;reason:string;source_market?:Market|null;source_offering?:Offering|null;evidence_refs:string[];reporting_periods?:unknown[]}>(request);
      if(!Number.isSafeInteger(expected)||expected>2147483647)throw new Problem(422,'VALIDATION_FAILED','If-Match profile version is out of range');
      if(patch.profile_version!==expected)throw conflict('INPUT_REVISION_CONFLICT','If-Match and profile_version must match');
      const result=await transaction(db(),async client=>{
        const corrected=await correctHistoricalProfile(client,blobs,{owner:user,projectId:id,materialId,materialVersion:m.version,actorId:user,requestId:request.id},patch);
        await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'source_profile_correction',status:'submitted'});
        return corrected.recognition;
      });
      return reply.header('cache-control','private, no-store').send(result);
    } catch(error) {
      const mapped=historicalProfileCorrectionProblem(error);
      if(mapped)error=mapped;
      if(error instanceof Problem){
        const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,id]);
        await rejectOperation(db(),{owner:user,projectId:owned.rowCount?id:null,requestId:request.id,traceId,kind:'source_profile_correction',status:'rejected',errorCode:error.code});
      }
      throw error;
    }
  });
  app.post('/api/v1/projects/:project_id/preflight',{schema:{body:schemas.PreflightRequest,response:{200:schemas.PreflightResponse}}},async request=>{
    const user=await owner(request),id=param(request,'project_id'),b=body<{input_revision:number;input_hash:string}>(request),traceId=uid();
    try {
      return await transaction(db(),async client=>{
        await project(client,user,id);
        if(!isPgInputRevision(b.input_revision))throw new Problem(422,'VALIDATION_FAILED','Input revision exceeds storage range');
        const input=(await client.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,id,b.input_revision])).rows[0];
        if(!input)throw missing();
        if(input.input_hash.trim()!==b.input_hash)throw conflict('INPUT_REVISION_CONFLICT','Input hash changed');
        const missingInputs:string[]=[],uncertainty:string[]=[];
        const manifest=input.manifest as Record<string,unknown>;
        const ruleCheck=await revalidateStoredProductionRulePin(client,{ownerUserId:user,projectId:id},input,settings.reviewedContextLoader);
        if(ruleCheck.status!=='valid')missingInputs.push(ruleCheck.status==='tampered'&&ruleCheck.reason==='input_manifest_hash_mismatch'
          ?ruleCheck.reason:`rule_pack:${ruleCheck.reason}`);
        let updateDifficulty: StoredUpdateDifficultySnapshot | undefined;
        if(manifest.kind==='update'){
          const binding=manifest.issuer_identity;
          if(!isVerifiedIssuerIdentityBinding(binding)){
            const pending=binding&&typeof binding==='object'&&!Array.isArray(binding)?(binding as Record<string,unknown>).reason:null;
            missingInputs.push(`issuer_identity_not_bound:${typeof pending==='string'?pending:'historical_issuer_identity_not_bound'}`);
          }else if(manifest.issuer_entity_id!==binding.entity_id){
            missingInputs.push('issuer_identity_pin_mismatch');
          }else{
            const material=(await client.query(`SELECT role,sha256,deleted_at FROM bb_material_versions
              WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,[user,id,binding.material_id,binding.material_version])).rows[0];
            if(!material||material.role!=='historical'||material.deleted_at||material.sha256.trim()!==binding.source_content_sha256){
              missingInputs.push(`issuer_material_stale:${binding.material_id}:${binding.material_version}`);
            }else{
              const current=await loadVerifiedIssuerIdentitySourceRecord(client,{ownerUserId:user,projectId:id,materialId:binding.material_id,materialVersion:binding.material_version});
              if(!current||!issuerIdentityBindingMatches(binding,current))missingInputs.push(`issuer_identity_stale:${binding.material_id}:${binding.material_version}`);
            }
          }
        }
        const refs=input.material_versions as {material_id:string;material_version:number}[];
        if(!refs.length)missingInputs.push('material_versions');
        for(const ref of refs){
          // The input revision pins exact versions, so pinned rows are read even after later deletion.
          const row=(await client.query(`SELECT m.role,m.media_type,j.state,j.error_code,j.result FROM bb_material_versions m
            LEFT JOIN bb_jobs j ON j.job_type='parse' AND j.owner_user_id=m.owner_user_id AND j.project_id=m.project_id AND j.material_id=m.id
              AND j.material_version=m.version AND j.subtype='material_parse' AND j.parser_version=$5
            WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4`,[user,id,ref.material_id,ref.material_version,documentParserVersion()])).rows[0];
          if(!row)throw missing();
          const key=`${ref.material_id}:${ref.material_version}`;
          if(!row.state){missingInputs.push(`material_parse_not_enqueued:${key}`);continue;}
          if(row.state==='failed'){missingInputs.push(`material_parse_failed:${key}:${row.error_code}`);continue;}
          if(row.state==='cancelled'){missingInputs.push(`material_parse_cancelled:${key}`);continue;}
          if(row.state==='paused'&&row.result?.pending_capabilities?.includes('ocr')){missingInputs.push(`ocr_pending:${key}`);continue;}
          if(row.state!=='succeeded'){missingInputs.push(`material_parse_pending:${key}`);continue;}
          if(row.result?.outcome==='needs_confirmation')uncertainty.push(`material_needs_confirmation:${key}`);
          if(row.role==='historical'&&[DOCX_MEDIA_TYPE,PDF_MEDIA_TYPE].includes(row.media_type)){
            const profile=(await client.query(`SELECT recognition->>'state' AS state FROM bb_historical_profiles WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
              ORDER BY profile_version DESC LIMIT 1`,[user,id,ref.material_id,ref.material_version])).rows[0];
            if(!profile)missingInputs.push(`source_profile_missing:${key}`);
            else if(profile.state!=='ready')uncertainty.push(`source_profile_${profile.state}:${key}`);
          }
        }
        if(manifest.kind==='update'){
          // Free difficulty evidence is independent of execution capability or
          // unrelated readiness gaps; the repository itself enforces its pins.
          try {
            updateDifficulty=await ensureCurrentUpdateDifficultySnapshotWithClient(client,{
              ownerUserId:user,projectId:id,inputRevision:b.input_revision,inputHash:b.input_hash,
            });
            if(updateDifficulty.estimate.status==='needs_confirmation')
              uncertainty.push('update_difficulty_needs_confirmation');
          } catch(error) {
            const classified=classifyUpdateDifficultyFailure(error);
            if(classified.category==='pending_input') missingInputs.push(`update_difficulty_pending:${classified.code.toLowerCase()}`);
            else if(classified.category==='stale_input') throw conflict('INPUT_REVISION_CONFLICT','Preflight input is no longer current');
            else if(classified.category==='not_found') throw missing();
            else if(classified.category==='invalid_request') throw new Problem(422,'VALIDATION_FAILED','Invalid preflight input');
            else throw new Problem(503,'DATA_UNAVAILABLE','Update difficulty snapshot could not be verified');
          }
        }
        // Execution stays 501 until #16/#79/Word delivery are live, so preflight cannot report an executable input.
        if(!settings.enableRunStaging&&!queueEnabled)missingInputs.push('execution_capability_not_ready');
        const status=missingInputs.length?'blocked' as const:uncertainty.length?'needs_confirmation' as const:'ready' as const;
        await recordLogicalJob(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'preflight',jobType:'preflight',status:'submitted',inputRevision:b.input_revision,inputHash:b.input_hash,stage:status});
        return {project_id:id,input_revision:b.input_revision,input_hash:b.input_hash,status,missing_inputs:missingInputs,uncertainty,billing_mode:'platform_trial' as const,
          ...(updateDifficulty?{update_difficulty:{snapshot_id:updateDifficulty.id,status:updateDifficulty.estimate.status,estimated_n:updateDifficulty.estimate.estimatedN,
             structure_adaptation_required:updateDifficulty.estimate.structureAdaptationRequired,confirmation_reasons:updateDifficulty.estimate.confirmationReasons,
             source_profile_version:updateDifficulty.sourceProfileVersion}}:{})};
      });
    } catch(error) {
      if(error instanceof Problem){
        const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,id]);
        if(owned.rowCount)await transaction(db(),client=>recordLogicalJob(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'preflight',jobType:'preflight',status:'rejected',errorCode:error.code,inputRevision:isPgInputRevision(b.input_revision)?b.input_revision:undefined,inputHash:isPgInputRevision(b.input_revision)?b.input_hash:undefined,stage:isPgInputRevision(b.input_revision)?'submission_rejected':'revision_out_of_range',httpStatus:isPgInputRevision(b.input_revision)?undefined:422,revisionRejected:!isPgInputRevision(b.input_revision)}));
        else await rejectOperation(db(),{owner:user,projectId:null,requestId:request.id,traceId,kind:'preflight',status:'rejected',errorCode:error.code});
      }
      throw error;
    }
  });
  app.post('/api/v1/conversations/:conversation_id/messages',async request=>{await owner(request);throw unavailable();});
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app=createServer(),port=Number(process.env.PORT??'3000');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  // Spool files left by a killed process are never resumed; clear them before accepting uploads.
  await clearSpoolDirectory();
  app.listen({host:process.env.HOST??'127.0.0.1',port}).catch(error=>{app.log.error(error);process.exitCode=1;});
}
