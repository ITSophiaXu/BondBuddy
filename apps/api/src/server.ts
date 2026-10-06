import { installAccountRecovery } from './account-recovery.js';
import { listProjects, archiveProject } from './project-list.js';
import { listArtifactHistory } from './artifact-history.js';
import { readOcr, readOcrPage, correctOcr } from './ocr.js';
import type { OcrCorrectionRequest } from '@bondbuddy/contracts';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerReviewRoutes } from './review-workspace.js';
import { registerReadableReview } from './review-readable.js';
import { Value } from '@sinclair/typebox/value';
import { ReviewRevisionHandlingSchema } from '@bondbuddy/contracts';
import { Pool, type PoolClient } from 'pg';
import { GENERATION_ISSUER_MATERIAL_ROLES, M1_UPLOAD_MIME_TYPES, M1_UPLOAD_LIMITS, MARKET_OFFERINGS, openApiDocument, schemas, emptyUpdateDetails, updateDetailsErrors, type GenerationIssuerBindingRef, type ProjectMessageSetRef, type UpdateDetails, type Market, type Offering } from '@bondbuddy/contracts';
import { autoTestExecutionKeyStorage, azureBlobs, canonical, checkedPair, conflict, date, digest, executionKeyStorage, inputDto, material, materialDto, missing, Problem, project, projectDto, publicProblem, putBlobFile, readBlobToFile, run, runDto, transaction, uid, unavailable, verifiedMediaFile, verifiedMediaFileDetailed, type PrivateBlobs } from './data.js';
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
import { installFactEvidenceReviewRoutes } from './fact-evidence-reviews.js';
import { installFactEvidenceReadRoutes } from './fact-evidence-read.js';
import { installCreditFacilitySupplementRoutes } from './credit-facility-supplements.js';
import { lockCreditFacilitySupplementPins } from './credit-facility-supplements-repository.js';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer, listIssuerIdentitySourceRecords, loadVerifiedIssuerIdentitySourceRecord, reviewIssuerIdentitySourceRecord } from './issuer-identity-source.js';
import { issuerIdentityBindingMatches, isVerifiedIssuerIdentityBinding, pendingIssuerIdentityBinding, verifiedIssuerIdentityBinding } from './issuer-identity-binding.js';
import type { GenerationIssuerBindingSeam } from './generation-issuer-binding-consumer.js';
import { appendGenerationIssuerBinding, loadApprovedGenerationIssuerBindingForLock, reviewGenerationIssuerBinding, type GenerationIssuerBindingDecisionInput, type GenerationIssuerBindingDisputeInput } from './generation-issuer-binding.js';
import { assertProjectMessageSetRefMatches, isProjectMessageSetLockError, loadCurrentProjectMessageSetPin } from './project-message-set-lock.js';
import { inputManifestHash, lockProductionRulePack, revalidateStoredProductionRulePin, type ReviewedContextLoader, type RuleApplicabilityContextRef } from './production-rule-pin.js';
import { confirmTargetIntent, loadTargetConfirmation, type TargetConfirmationRequest } from './target-confirmation.js';
import { insertUserReferencePin, resolveUserReferencePin, type UserReferenceChoice } from './user-reference-lock.js';
import { classifyUpdateDifficultyFailure, ensureCurrentUpdateDifficultySnapshotWithClient, type StoredUpdateDifficultySnapshot } from './update-difficulty-repository.js';
import { createRuleApplicabilityContextDraft, loadReviewedRuleApplicabilityContext, readRuleApplicabilityContextDraftRef } from '@bondbuddy/rule-applicability-context';
import { appendRuleApplicabilityOverallReview, type AppendRuleApplicabilityOverallReviewInput } from './rule-applicability-overall-reviews.js';
import { assertGenerationIssuerBinding, assertLockedInputIntegrity, assertTestChannelReadable, assertTestGrant, autoWorkingDraftGrant, testChannelEnabled, workingDraftConfigured } from './non-production-test.js';
import { isTestIssuerCandidate, loadTestIssuerCandidate, testIssuerCandidateMatches } from './test-issuer-candidate.js';
import { classifyPreflightReadiness } from './preflight-readiness.js';
import { isUnifiedInput, lockUnifiedAuthoring, assertAuthoringSourceInformation } from './unified-authoring.js';
import { lockTestRuleApplicabilityRef } from './test-rule-applicability-pin.js';
import { installIssuerAnnualProfileReviewRoutes } from './issuer-annual-profile-reviews.js';
import { runEventPayloadDto } from './run-event-dto.js';
import { prepareUserSubmission, verifiedMaterialVersions } from './user-submissions.js';
import { readProjectMessageVersion, readProjectMessages, saveProjectMessage, type SaveProjectMessage } from './project-messages.js';
import { scrubSecrets } from './log-ops.js';
import { installBrowserErrorRoutes } from './browser-errors.js';
import { appendTargetPeriodEvidenceDecision, withdrawTargetPeriodEvidenceDecision } from './target-period-evidence-decisions.js';
import { installProductionReviewLedgerRoutes } from './production-review-ledger.js';
import { installProductionRulePackReleaseRoutes } from './production-rule-pack-releases.js';
import { configuredUploadInspectionException, uploadInspectionExceptionMatches } from './upload-inspection-exception.js';

import { creditBalance, quoteCredits, reserveCredits, quoteDto } from './billing.js';
import { classifyFixedPrice } from './billing-classification.js';
import { installPayments, type PaymentProvider } from './payments.js';

export type Principal = { userId: string; csrfVerified: boolean; sessionId?: string };
export type Settings = { paymentProviders?: readonly PaymentProvider[]; enablePaidAuthoring?: boolean; enablePaidReview?: boolean; pool?: Pool; blobs?: PrivateBlobs; principal?: (request: FastifyRequest) => Promise<Principal | null>; allowedOrigin?: string; auth?: Omit<AuthConfig,'pool'|'allowedOrigin'>; enableRunStaging?: boolean; enableSyntheticQueue?: boolean; /** #17: queue real runs for the worker runtime (env BB_RUN_RUNTIME_ENABLED=1). */ enableRunRuntime?: boolean; /** Controlled message persistence seam, disabled until conversation integration. */ enableUserSubmissionSeam?: boolean; stream?: StreamSettings; /** #35 trial limits; defaults to BB_TRIAL_* configuration. */ trial?: TrialConfig; reviewedContextLoader?: ReviewedContextLoader; /** #79 plaintext route deadline; defaults to 60 seconds. */ promptViewDeadlineMs?: number; /** Legacy injectable seam; admission reads only the immutable input pin. */ generationIssuerBinding?: GenerationIssuerBindingSeam };
const param = (request: FastifyRequest, name: string) => (request.params as Record<string,string>)[name];
const body = <T>(request: FastifyRequest) => request.body as T;
const now = () => new Date().toISOString();
const MAX_BYTES = M1_UPLOAD_LIMITS.fileBytes;
const DEFAULT_PROJECT_EVENT_PAGE_SIZE = 50;
const MAX_PROJECT_EVENT_PAGE_SIZE = 100;
const REVIEWER_PARSE_EVIDENCE_PAGE_SIZE = 50;
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

// Keep this in step with the browser's update request key. Only the exact key
// for the submitted immutable input is reserved for a production click.
function isBrowserUpdateKey(value:unknown, projectId:unknown, revision:unknown, inputHash:unknown):boolean {
  return typeof value==='string' && typeof projectId==='string' &&
    isPgInputRevision(revision) && typeof inputHash==='string' && /^[a-f0-9]{64}$/.test(inputHash) &&
    value===`web-update-${digest(JSON.stringify([projectId,revision,inputHash]))}`;
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
  const paidAuthoring = settings.enablePaidAuthoring ?? process.env.BB_PAID_AUTHORING_ENABLED === '1';
  const paidReview = settings.enablePaidReview ?? process.env.BB_PAID_REVIEW_ENABLED === '1';
  const allowedOrigin=settings.allowedOrigin ?? process.env.BB_ALLOWED_ORIGIN;
  const uploadInspectionException = configuredUploadInspectionException();
  const auth:AuthConfig={pool,allowedOrigin,termsVersion:settings.auth?.termsVersion ?? process.env.BB_TERMS_VERSION,supportContact:settings.auth?.supportContact ?? process.env.BB_SUPPORT_CONTACT};
  const blobs = settings.blobs ?? (process.env.AZURE_STORAGE_CONNECTION_STRING ? azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING) : null);
  // Upload bytes stay a stream here; the route authorises first, then spools to disk while hashing.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send(publicProblem(error, request.id));
    if (request.routeOptions.url === '/api/v1/browser-errors' && error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply.code(422).send({ code: 'VALIDATION_FAILED', message: 'Browser diagnostic exceeds limit', retryable: false, field_errors: [], correlation_id: request.id });
    if (error instanceof Error && 'validation' in error && error.validation) {
      let disposition:{status:number;code:string}={status:422,code:'VALIDATION_FAILED'};
      if ('validationContext' in error && error.validationContext==='body' && request.routeOptions.url===
          '/api/v1/projects/:project_id/materials/:material_id/versions/:material_version/issuer-identity/observations/:source_record_id/review') {
        disposition={status:400,code:'ISSUER_IDENTITY_VERIFICATION_INVALID'};
      }
      if ('validationContext' in error && error.validationContext==='body' && request.method==='POST' &&
          (request.routeOptions.url==='/api/v1/runs/execute'||request.routeOptions.url==='/api/v1/projects/:project_id/preflight')) {
        try { disposition=await auditSchemaRejection(request); }
        catch { return reply.code(503).send({code:'DATA_UNAVAILABLE',message:'Rejection evidence unavailable',retryable:true,field_errors:[],correlation_id:request.id}); }
      }
      return reply.code(disposition.status).send({ code: disposition.code, message: disposition.status===422?'Request validation failed':disposition.status===400?'Issuer identity review input is invalid':'Request key is bound to another input', retryable: false, field_errors: [], correlation_id: request.id });
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
  registerReviewRoutes(app, db, owner, paidReview);
  registerReadableReview(app, db, owner, blob);
  installPayments(app,pool,owner,paidAuthoring,settings.paymentProviders??[]);
  app.post('/api/v1/projects/:project_id/target-period-evidence-decisions',{
    schema:{body:schemas.TargetPeriodEvidenceDecisionRequest,response:{200:schemas.TargetPeriodEvidenceDecisionResponse}}},async request=>{
    const user=await owner(request),projectId=param(request,'project_id');
    try{return await appendTargetPeriodEvidenceDecision(db(),{userId:user},projectId,body(request),undefined,blob());}
    catch(error){
      const code=error instanceof Error?error.message:'TARGET_PERIOD_DECISION_FAILED';
      if(code==='TARGET_PERIOD_REVIEWER_FORBIDDEN')throw new Problem(403,'DATA_NOT_ENTITLED','Financial period reviewer authority is required');
      if(code==='TARGET_PERIOD_DECISION_NOT_FOUND')throw missing();
      if(code.includes('REPLAY_CONFLICT'))throw conflict('IDEMPOTENCY_CONFLICT','The request key is bound to another decision');
      if(code.includes('STALE')||code.includes('TARGET_MISMATCH'))throw conflict('INPUT_REVISION_CONFLICT','The locked financial period evidence changed');
      if(code.includes('INVALID')||code.includes('INCOMPLETE')||code.includes('AMBIGUOUS')||code.includes('NOT_LOCKED'))throw new Problem(422,'VALIDATION_FAILED','Financial period evidence is invalid or incomplete');
      throw new Problem(503,'DATA_UNAVAILABLE','Financial period evidence decision could not be persisted');
    }
  });
  app.post('/api/v1/projects/:project_id/target-period-evidence-decisions/withdraw',{
    schema:{body:schemas.TargetPeriodEvidenceDecisionWithdrawalRequest,response:{200:schemas.TargetPeriodEvidenceDecisionWithdrawalResponse}}},async request=>{
    const user=await owner(request),projectId=param(request,'project_id');
    try{return await withdrawTargetPeriodEvidenceDecision(db(),{userId:user},projectId,body(request));}
    catch(error){
      const code=error instanceof Error?error.message:'TARGET_PERIOD_DECISION_FAILED';
      if(code==='TARGET_PERIOD_REVIEWER_FORBIDDEN')throw new Problem(403,'DATA_NOT_ENTITLED','Financial period reviewer authority is required');
      if(code==='TARGET_PERIOD_DECISION_NOT_FOUND')throw missing();
      if(code.includes('REPLAY_CONFLICT'))throw conflict('IDEMPOTENCY_CONFLICT','The request key is bound to another withdrawal');
      if(code.includes('INVALID'))throw new Problem(422,'VALIDATION_FAILED','Financial period decision withdrawal is invalid');
      throw new Problem(503,'DATA_UNAVAILABLE','Financial period decision withdrawal could not be persisted');
    }
  });
  function visibleRunDto(row: any) { assertTestChannelReadable(row.channel); return runDto(row); }
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
    const testGrantId=kind==='execute'&&safeId(submitted.test_grant_id)?submitted.test_grant_id:undefined;
    const channel=testGrantId?'non_production_test' as const:'production' as const;
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
      if((submitted.test_grant_id!==undefined||workingDraftConfigured()) &&
          isBrowserUpdateKey(executionRequestId,projectId,submitted.input_revision,submitted.input_hash)){
        await recordOperation(client,{owner:user,projectId,requestId,traceId,kind,status:'rejected',
          errorCode:'VALIDATION_FAILED',inputRevision,inputHash,channel:'non_production_test'});
        return {status:422,code:'VALIDATION_FAILED'};
      }
      const logged=await recordLogicalJob(client,{owner:user,projectId,requestId,traceId,kind,jobType:'submission',status:'rejected',errorCode:'VALIDATION_FAILED',inputRevision,inputHash,stage:'schema_validation',executionRequestId,requestHash,httpStatus:422,schemaRejected:true,channel,testGrantId});
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
  installBrowserErrorRoutes(app,{db,owner,sessionId:async request=>{
    const principal=await (settings.principal ? settings.principal(request) : sessionPrincipal(request,auth));
    if(!principal?.sessionId)throw new Problem(401,'UNAUTHENTICATED','Session required');
    return principal.sessionId;
  }});
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
  installFactEvidenceReviewRoutes(app,{db,principal:async request=>({userId:await owner(request)})});
  installFactEvidenceReadRoutes(app,{db,principal:async request=>({userId:await owner(request)})});
  installCreditFacilitySupplementRoutes(app,{db,owner});
  installIssuerAnnualProfileReviewRoutes(app,{db,owner});
  installProductionReviewLedgerRoutes(app,{db,actor:owner});
  installProductionRulePackReleaseRoutes(app,{db,actor:owner});
  app.get('/api/v1/projects',{schema:{querystring:schemas.ProjectListQuery,response:{200:schemas.ProjectListResponse}}},async request =>
    listProjects(db(),await owner(request),request.query as import('@sinclair/typebox').Static<typeof schemas.ProjectListQuery>));
  app.get('/api/v1/projects/:project_id/artifacts',{schema:{querystring:schemas.ArtifactHistoryQuery,response:{200:schemas.ArtifactHistoryResponse}}},async (request,reply) => {
    reply.header('cache-control','private, no-store');
    return listArtifactHistory(db(),await owner(request),param(request,'project_id'),
      request.query as import('@sinclair/typebox').Static<typeof schemas.ArtifactHistoryQuery>,
      testChannelEnabled(),verifiedArtifactBytes);
  });
  app.post('/api/v1/projects/:project_id/archive',{schema:{body:schemas.ProjectArchiveRequest,response:{200:schemas.ProjectResponse}}},async request =>
    archiveProject(db(),await owner(request),param(request,'project_id'),body<{archived:boolean}>(request).archived,request.id));
  app.post('/api/v1/projects',{schema:{body:schemas.ProjectCreateRequest}},async (request,reply) => {
    const user=await owner(request), b=body<{name:string;kind:string;issuer_name:string|null;market:Market|null;offering:Offering|null;update_details?:UpdateDetails}>(request);
    checkedPair(b.market,b.offering);
    const details={...emptyUpdateDetails(),...b.update_details};
    const errors=updateDetailsErrors(details);if(errors.length)throw new Problem(422,'VALIDATION_FAILED',errors[0].message);
    const id=uid(), value=await transaction(db(),async client=>{
      await admitProjectCreate(client,trial,user,sourceHash(request.ip));
      const row=await client.query('INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,user,b.name,b.kind,b.issuer_name,b.market,b.offering,JSON.stringify(details)]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.created',{project_id:id}]);
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'project_create',status:'submitted'});
      return projectDto(row.rows[0]);
    }).catch(async error=>{await trialRejected(error,user,'project_create',null,request.id);throw error;});
    return reply.code(201).send(value);
  });
  app.get('/api/v1/projects/:project_id',async request=>projectDto(await project(db(),await owner(request),param(request,'project_id'))));
  const issuerObservations='/api/v1/projects/:project_id/materials/:material_id/versions/:material_version/issuer-identity/observations';
  const issuerScope=(request:FastifyRequest, ownerUserId:string)=>{
    const rawVersion=param(request,'material_version');
    if(!/^[1-9][0-9]*$/.test(rawVersion)||!Number.isSafeInteger(Number(rawVersion)))
      throw new Problem(422,'VALIDATION_FAILED','Invalid material version');
    return {ownerUserId,projectId:param(request,'project_id'),materialId:param(request,'material_id'),materialVersion:Number(rawVersion)};
  };
  app.get(issuerObservations,{schema:{response:{200:schemas.IssuerIdentityObservationSummaryResponse}}},async request=>{
    const user=await owner(request);
    try{
      const listed=await listIssuerIdentitySourceRecords(db(),issuerScope(request,user));
      return {project_id:listed.project_id,material_id:listed.material_id,material_version:listed.material_version,
        status:listed.status,items:listed.items.map(item=>({source_record_id:item.source_record_id,
          identity_version:item.identity_version,status:item.status,verified_entity_id:item.verified_entity_id}))};
    }
    catch(error){if(error instanceof Error&&error.message==='ISSUER_IDENTITY_MATERIAL_NOT_FOUND')throw missing();throw error;}
  });
  const reviewerObservations=`/api/v1/reviewer${issuerObservations.slice('/api/v1'.length)}`;
  async function issuerReviewerScope(request:FastifyRequest){
    const reviewerUserId=await owner(request),projectId=param(request,'project_id');
    const found=await db().query('SELECT owner_user_id FROM bb_projects WHERE id=$1 AND deleted_at IS NULL',[projectId]);
    if(found.rows.length!==1)throw missing();
    const ownerUserId=String(found.rows[0].owner_user_id);
    const reviewer=await authorizeIssuerIdentityReviewer(db(),reviewerUserId,{ownerUserId,projectId});
    if(!reviewer)throw missing();
    return {ownerUserId,projectId,reviewer};
  }
  function issuerRouteError(error:unknown):never{
    const code=error instanceof Error?error.message:'';
    if(code.endsWith('_NOT_FOUND')||code.endsWith('_NOT_AUTHORIZED')||code==='GENERATION_ISSUER_BINDING_PROJECT_NOT_FOUND'||
       code==='ISSUER_IDENTITY_SOURCE_EVIDENCE_NOT_FOUND_OR_UNCERTAIN')throw missing();
    if(code.includes('STALE')||code.includes('CONFLICT')||code.includes('MISMATCH')||
       code.includes('NOT_CURRENTLY_APPROVABLE')||code.includes('REVIEW_REQUIRED')||
       code.includes('TRANSITION_INVALID')||code.includes('REVIEW_STATE_INVALID')||code.includes('ALREADY_DECIDED'))
      throw conflict('INPUT_REVISION_CONFLICT','Issuer evidence or binding is no longer current');
    if(code.startsWith('INVALID_')||code.endsWith('_INVALID')||code.includes('UNCERTAIN')||
       code.includes('INCOMPLETE')||code.includes('UNRESOLVED'))
      throw new Problem(422,'VALIDATION_FAILED','Issuer evidence or binding is invalid');
    throw error;
  }
  app.get(reviewerObservations,{schema:{response:{200:schemas.IssuerIdentityObservationListResponse}}},async request=>{
    const reviewerUserId=await owner(request), projectId=param(request,'project_id');
    return transaction(db(),async client=>{
      const allowed=await client.query(`SELECT p.owner_user_id,g.id AS grant_id FROM bb_projects p
        JOIN bb_issuer_identity_reviewer_grants g ON g.scope_owner_user_id=p.owner_user_id AND g.scope_project_id=p.id
        WHERE p.id=$1 AND p.deleted_at IS NULL AND g.user_id=$2 AND g.role='issuer_identity_reviewer'
          AND g.revoked_at IS NULL FOR SHARE OF p,g`,[projectId,reviewerUserId]);
      if(allowed.rows.length!==1)throw missing();
      const scope=issuerScope(request,String(allowed.rows[0].owner_user_id));
      let listed;
      try{listed=await listIssuerIdentitySourceRecords(client,scope);}
      catch(error){if(error instanceof Error&&error.message==='ISSUER_IDENTITY_MATERIAL_NOT_FOUND')throw missing();throw error;}
      await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'project',$3,'issuer.identity_source.reviewer_read',$4::jsonb)`,
      [uid(),scope.ownerUserId,scope.projectId,JSON.stringify({reviewer_user_id:reviewerUserId,
        reviewer_grant_id:allowed.rows[0].grant_id,material_id:scope.materialId,material_version:scope.materialVersion,
        observations:listed.items.map(item=>({source_record_id:item.source_record_id,snapshot_sha256:item.snapshot_sha256,
          content_sha256:item.content_sha256}))})]);
      return listed;
    });
  });
  const parseEvidenceRoute=async(request:FastifyRequest,reply:any)=>{
      reply.header('cache-control','private, no-store');
      const reviewerUserId=await owner(request),projectId=param(request,'project_id'),materialId=param(request,'material_id');
      const rawVersion=param(request,'v');
      if(!/^[1-9][0-9]{0,9}$/.test(rawVersion)||Number(rawVersion)>2147483647)
        throw new Problem(422,'VALIDATION_FAILED','Invalid material version');
      const materialVersion=Number(rawVersion);
      const query=(request.query as {q?:string;cursor?:string}|undefined)??{};
      if((query.q!==undefined&&typeof query.q!=='string')||(query.cursor!==undefined&&typeof query.cursor!=='string'))
        throw new Problem(422,'VALIDATION_FAILED','Invalid evidence query');
      const q=query.q?.trim()??'';
      if(q.length>200||q.includes('\0'))throw new Problem(422,'VALIDATION_FAILED','Invalid evidence query');
      const queryHash=digest(q.toLocaleLowerCase('en-US'));
      type EvidenceCursor={v:1;project_id:string;material_id:string;snapshot_id:string;material_version:number;after:number;query_hash:string};
      let pageAfter=-1,cursorSnapshot:string|null=null;
      if(query.cursor!==undefined){
        if(query.cursor.length>2048)throw new Problem(422,'VALIDATION_FAILED','Invalid evidence cursor');
        try{
          const parsed=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')) as Partial<EvidenceCursor>;
          if(parsed.v!==1||typeof parsed.project_id!=='string'||typeof parsed.material_id!=='string'||
              typeof parsed.snapshot_id!=='string'||!Number.isSafeInteger(parsed.material_version)||
              !Number.isSafeInteger(parsed.after)||Number(parsed.after)<0||typeof parsed.query_hash!=='string'||
              !/^[a-f0-9]{64}$/.test(parsed.query_hash))throw new Error('shape');
          if(parsed.project_id!==projectId||parsed.material_id!==materialId||parsed.material_version!==materialVersion||parsed.query_hash!==queryHash)
            throw new Problem(409,'INPUT_REVISION_CONFLICT','Evidence cursor does not match this query or material version');
          cursorSnapshot=parsed.snapshot_id;pageAfter=Number(parsed.after);
        }catch(error){if(error instanceof Problem)throw error;throw new Problem(422,'VALIDATION_FAILED','Invalid evidence cursor');}
      }
      return transaction(db(),async client=>{
        const identityEvidence=request.routeOptions.url?.endsWith('/issuer-parse-evidence')===true;
        const grantTable=identityEvidence?'bb_issuer_identity_reviewer_grants':'bb_rule_applicability_reviewer_grants';
        const grantRole=identityEvidence?'issuer_identity_reviewer':'rule_applicability_reviewer';
        const allowed=await client.query(`SELECT p.owner_user_id,g.id AS grant_id,m.sha256 AS material_sha256
          FROM bb_projects p
          JOIN ${grantTable} g ON g.scope_owner_user_id=p.owner_user_id AND g.scope_project_id=p.id
          JOIN bb_users u ON u.id=g.user_id AND u.status='active'
          JOIN bb_material_versions m ON m.owner_user_id=p.owner_user_id AND m.project_id=p.id
            AND m.id=$3 AND m.version=$4 AND m.deleted_at IS NULL
          WHERE p.id=$1 AND p.deleted_at IS NULL AND g.user_id=$2 AND g.role=$5
            AND g.revoked_at IS NULL ${identityEvidence?"AND m.role IN ('audit','financial','interimFinancial','notes')":''}
          FOR SHARE OF p,g,u,m`,[projectId,reviewerUserId,materialId,materialVersion,grantRole]);
        if(allowed.rows.length!==1)throw missing();
        const scopeOwner=String(allowed.rows[0].owner_user_id),materialSha=String(allowed.rows[0].material_sha256).trim();
        const selected=await client.query(`SELECT id,content_sha256,parser_version,response_sha256,response_status,response_schema_version,record_count,response_meta
          FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
          ORDER BY created_at DESC,id DESC LIMIT 1`,[scopeOwner,projectId,materialId,materialVersion]);
        const snapshot=selected.rows[0];
        if(!snapshot)throw missing();
        if(String(snapshot.content_sha256).trim()!==materialSha)
          throw new Problem(409,'INPUT_REVISION_CONFLICT','The latest parse snapshot does not match the active material hash');
        if(snapshot.response_status!=='parsed'&&snapshot.response_status!=='needs_confirmation')
          throw new Problem(409,'INPUT_REVISION_CONFLICT','The latest parse snapshot is not readable');
        const responseMeta=snapshot.response_meta;
        if(snapshot.response_schema_version!=='document-parse-response-v1'||!responseMeta||
            responseMeta.schema_version!==snapshot.response_schema_version||responseMeta.status!==snapshot.response_status||
            responseMeta.parser_version!==snapshot.parser_version||responseMeta.material?.material_id!==materialId||
            Number(responseMeta.material?.material_version)!==materialVersion||responseMeta.material?.sha256!==materialSha||
            typeof responseMeta.request_id!=='string'||!responseMeta.request_id.trim()||!Array.isArray(responseMeta.warnings)||
            !responseMeta.document||typeof responseMeta.document!=='object'||Array.isArray(responseMeta.document)||
            !/^[a-f0-9]{64}$/.test(String(snapshot.response_sha256).trim())||
            typeof snapshot.parser_version!=='string'||!snapshot.parser_version.trim())
          throw new Problem(409,'INPUT_REVISION_CONFLICT','The latest parse snapshot metadata is inconsistent');
        const snapshotId=String(snapshot.id);
        if(cursorSnapshot!==null&&cursorSnapshot!==snapshotId)
          throw new Problem(409,'INPUT_REVISION_CONFLICT','Evidence cursor refers to a stale parse snapshot');
        const recordInventory=await client.query(`SELECT count(*)::int AS record_count,
            count(*) FILTER (WHERE content_sha256=$6 AND extractor_version=$7 AND extraction_method='native_text')::int AS eligible_count
          FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND snapshot_id=$5`,
        [scopeOwner,projectId,materialId,materialVersion,snapshotId,materialSha,snapshot.parser_version]);
        const inventory=recordInventory.rows[0];
        if(Number(inventory.record_count)!==Number(snapshot.record_count)||Number(inventory.eligible_count)!==Number(snapshot.record_count))
          throw new Problem(409,'INPUT_REVISION_CONFLICT','The latest parse snapshot evidence inventory is incomplete or inconsistent');
        const records=await client.query(`SELECT record_id,record_sha256,content_sha256,locator_type,locator,literal_quote,uncertainty,ordinal
          FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
            AND snapshot_id=$5 AND content_sha256=$6 AND extractor_version=$7 AND extraction_method='native_text'
            AND ordinal>$8 AND ($9='' OR literal_quote ILIKE $9 ESCAPE '\\')
          ORDER BY ordinal LIMIT $10`,[scopeOwner,projectId,materialId,materialVersion,snapshotId,materialSha,snapshot.parser_version,pageAfter,
          q?`%${q.replace(/[\\%_]/g,'\\$&')}%`:'',REVIEWER_PARSE_EVIDENCE_PAGE_SIZE+1]);
        const hasMore=records.rows.length>REVIEWER_PARSE_EVIDENCE_PAGE_SIZE;
        const page=records.rows.slice(0,REVIEWER_PARSE_EVIDENCE_PAGE_SIZE);
        const next=hasMore?Buffer.from(JSON.stringify({v:1,project_id:projectId,material_id:materialId,snapshot_id:snapshotId,material_version:materialVersion,
          after:Number(page.at(-1)!.ordinal),query_hash:queryHash} satisfies EvidenceCursor)).toString('base64url'):null;
        const warnings=responseMeta.warnings;
        const warningCodes=warnings.map((warning:any)=>typeof warning?.code==='string'?warning.code:'UNKNOWN_WARNING');
        await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
          VALUES($1,$2,'project',$3,$5,$4::jsonb)`,
        [uid(),scopeOwner,projectId,JSON.stringify({reviewer_user_id:reviewerUserId,reviewer_grant_id:allowed.rows[0].grant_id,
          material_id:materialId,material_version:materialVersion,snapshot_id:snapshotId,parser_version:snapshot.parser_version,
          response_sha256:String(snapshot.response_sha256).trim(),query_sha256:queryHash,
          record_refs:page.map(row=>({record_id:row.record_id,record_sha256:String(row.record_sha256).trim()})),page_size:page.length}),
          identityEvidence?'issuer.identity_source.parse_evidence_read':'rule_applicability.reviewer_parse_evidence_read']);
        return {project_id:projectId,material_id:materialId,material_version:materialVersion,material_sha256:materialSha,
          snapshot_id:snapshotId,parser_version:snapshot.parser_version,response_sha256:String(snapshot.response_sha256).trim(),
          response_status:snapshot.response_status,warning_codes:warningCodes,items:page.map(row=>({record_id:row.record_id,
            record_sha256:String(row.record_sha256).trim(),content_sha256:String(row.content_sha256).trim(),locator_type:row.locator_type,
            locator:row.locator,literal_quote:row.literal_quote,uncertainty:row.uncertainty})),next_cursor:next};
      });
    };
  app.get('/api/v1/reviewer/projects/:project_id/materials/:material_id/versions/:v/parse-evidence',
    {schema:{response:{200:schemas.ReviewerParseEvidenceResponse}}},parseEvidenceRoute);
  app.get('/api/v1/reviewer/projects/:project_id/materials/:material_id/versions/:v/issuer-parse-evidence',
    {schema:{response:{200:schemas.ReviewerParseEvidenceResponse}}},parseEvidenceRoute);
  app.post(reviewerObservations,{schema:{body:schemas.IssuerIdentityObservationProposalRequest,
    response:{201:schemas.IssuerIdentityObservationProposalResponse}}},async(request,reply)=>{
    const scope=await issuerReviewerScope(request);
    const materialScope=issuerScope(request,scope.ownerUserId);
    const input=body<{request_id:string;evidence_record_id:string;issuer_display_name:string;candidate_key:string}>(request);
    try{
      const record=await appendIssuerIdentitySourceRecord({pool:db()},{...materialScope,requestId:input.request_id,
        sourceRecordId:input.evidence_record_id,issuerDisplayName:input.issuer_display_name,entityId:input.candidate_key,
        reviewer:scope.reviewer});
      reply.code(201);
      return {source_record_id:record.id,identity_version:record.identityVersion,content_sha256:record.contentSha256,
        snapshot_id:record.snapshotId,status:record.state,replayed:record.replayed};
    }catch(error){issuerRouteError(error);}
  });
  app.post('/api/v1/reviewer/projects/:project_id/generation-issuer-bindings',
    {schema:{body:schemas.GenerationIssuerBindingCreateRequest,response:{201:schemas.GenerationIssuerBindingCreateResponse}}},async(request,reply)=>{
      const scope=await issuerReviewerScope(request);
      const input=body<{request_id:string;input_revision:number;input_hash:string;
        material_decisions:GenerationIssuerBindingDecisionInput[];disputes?:GenerationIssuerBindingDisputeInput[]}>(request);
      try{
        const result=await appendGenerationIssuerBinding({pool:db()},{...scope,requestId:input.request_id,
          inputRevision:input.input_revision,inputHash:input.input_hash,materialDecisions:input.material_decisions,
          disputes:input.disputes});
        reply.code(201);
        return {binding_ref:{binding_id:result.bindingId,version:result.version,content_sha256:result.contentSha256},
          status:result.status,created:result.created};
      }catch(error){issuerRouteError(error);}
    });
  app.post('/api/v1/reviewer/projects/:project_id/generation-issuer-bindings/:binding_id/review',
    {schema:{body:schemas.GenerationIssuerBindingReviewRequest,response:{201:schemas.GenerationIssuerBindingReviewResponse}}},async(request,reply)=>{
      const scope=await issuerReviewerScope(request);
      const input=body<{request_id:string;action:'request_more_evidence'|'approve'|'withdraw';
        expected_binding:GenerationIssuerBindingRef;reason:string}>(request);
      if(input.expected_binding.binding_id!==param(request,'binding_id'))throw missing();
      try{
        const result=await reviewGenerationIssuerBinding({pool:db()},{...scope,bindingId:input.expected_binding.binding_id,
          version:input.expected_binding.version,contentSha256:input.expected_binding.content_sha256,
          requestId:input.request_id,action:input.action,reason:input.reason});
        reply.code(201);
        return {review_id:result.reviewId,status:result.status,replayed:result.replayed};
      }catch(error){issuerRouteError(error);}
    });
  app.get('/api/v1/projects/:project_id/generation-issuer-bindings/:binding_id/versions/:version/approved-ref',
    {schema:{response:{200:schemas.GenerationIssuerBindingRefResponse}}},async request=>{
      const ownerUserId=await owner(request),projectId=param(request,'project_id'),bindingId=param(request,'binding_id');
      await project(db(),ownerUserId,projectId);
      const version=Number(param(request,'version'));
      if(!Number.isSafeInteger(version)||version<1)throw missing();
      const found=await db().query(`SELECT content_sha256 FROM bb_generation_issuer_bindings
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,[ownerUserId,projectId,bindingId,version]);
      if(found.rows.length!==1)throw missing();
      const ref={binding_id:bindingId,version,content_sha256:String(found.rows[0].content_sha256).trim()};
      const approved=await loadApprovedGenerationIssuerBindingForLock(db(),{ownerUserId,projectId},ref);
      if(!approved)throw missing();
      return {binding_ref:ref,input_revision:approved.input_revision,input_hash:approved.input_hash,status:'approved' as const};
    });
  app.post(`${issuerObservations}/:source_record_id/review`,{schema:{body:schemas.IssuerIdentityReviewRequest,response:{201:schemas.IssuerIdentityReviewResponse}}},async(request,reply)=>{
    const reviewerUserId=await owner(request);
    const projectId=param(request,'project_id');
    const owned=await db().query('SELECT owner_user_id FROM bb_projects WHERE id=$1 AND deleted_at IS NULL',[projectId]);
    if(owned.rows.length!==1)throw missing();
    const scope=issuerScope(request,String(owned.rows[0].owner_user_id));
    const reviewer=await authorizeIssuerIdentityReviewer(db(),reviewerUserId,{ownerUserId:scope.ownerUserId,projectId:scope.projectId});
    if(!reviewer)throw missing();
    const input=body<{decision:'verified'|'rejected'|'conflict';reason_code:string;expected_content_sha256:string;expected_snapshot_sha256:string;verified_entity_id?:string;entity_basis_kind?:'uscc'|'registry_record'|'manual_attestation';entity_basis_ref?:string}>(request);
    try{
      const result=await reviewIssuerIdentitySourceRecord({pool:db()},{...scope,sourceRecordRowId:param(request,'source_record_id'),reviewer,decision:input.decision,reasonCode:input.reason_code,
        expectedContentSha256:input.expected_content_sha256,expectedSnapshotSha256:input.expected_snapshot_sha256,
        verifiedEntityId:input.verified_entity_id,entityBasisKind:input.entity_basis_kind,entityBasisRef:input.entity_basis_ref});
      reply.code(201);
      return {review_id:result.reviewId,source_record_id:result.sourceRecordId,decision:result.decision,created_at:result.createdAt,replayed:result.replayed};
    }catch(error){
      if(error instanceof Error&&['ISSUER_IDENTITY_SOURCE_RECORD_NOT_FOUND','ISSUER_IDENTITY_REVIEWER_NOT_AUTHORIZED'].includes(error.message))throw missing();
      if(error instanceof Error&&error.message==='ISSUER_IDENTITY_REVIEW_ALREADY_DECIDED')throw conflict('INPUT_REVISION_CONFLICT','Observation already has a different review');
      if(error instanceof Error&&error.message==='ISSUER_IDENTITY_SNAPSHOT_STALE')throw conflict('ISSUER_IDENTITY_SNAPSHOT_CONFLICT','Issuer identity observation or parse snapshot changed');
      if(error instanceof Error&&error.message==='ISSUER_IDENTITY_VERIFICATION_INVALID')throw new Problem(400,'ISSUER_IDENTITY_VERIFICATION_INVALID','Issuer identity verification basis is invalid');
      throw error;
    }
  });
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
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'project_edit',status:'submitted'});
      return projectDto(result.rows[0]);
    });
  });
  app.post('/api/v1/projects/:project_id/convert-to-generation',{
    schema:{body:schemas.ProjectKindConversionRequest,response:{200:schemas.ProjectKindConversionResponse}}
  },async request=>{
    const user=await owner(request),id=param(request,'project_id');
    const b=body<{conversion_request_id:string;expected_draft_revision:number;expected_input_revision:number|null;expected_input_hash:string|null;no_historical_prospectus:true}>(request);
    if((b.expected_input_revision===null)!==(b.expected_input_hash===null))
      throw new Problem(422,'VALIDATION_FAILED','Expected input revision and hash must both be present or absent');
    const requestHash=digest(canonical({project_id:id,...b}));
    return transaction(db(),async client=>{
      const p=await project(client,user,id,true);
      // A business request ID is unique per owner, including across projects. The
      // advisory lock makes a simultaneous reuse deterministic before inserting.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`project-kind:${user}:${b.conversion_request_id}`]);
      const prior=(await client.query('SELECT * FROM bb_project_kind_conversions WHERE owner_user_id=$1 AND request_id=$2',[user,b.conversion_request_id])).rows[0];
      if(prior){
        if(prior.project_id!==id||prior.request_hash.trim()!==requestHash)
          throw conflict('IDEMPOTENCY_CONFLICT','Conversion request ID was reused with different input');
        return {conversion_request_id:b.conversion_request_id,project_id:id,from_kind:'update',to_kind:'generation',old_draft_revision:prior.old_draft_revision,draft_revision:prior.new_draft_revision,previous_input_revision:prior.latest_input_revision,previous_input_hash:prior.latest_input_hash?.trim()??null,converted_at:date(prior.created_at)};
      }
      if(p.kind!=='update'||p.update_details?.has_historical!==false)
        throw conflict('INPUT_REVISION_CONFLICT','Project is not a no-history update draft');
      if(p.draft_revision!==b.expected_draft_revision||p.latest_input_revision!==b.expected_input_revision||
         (p.input_hash?.trim()??null)!==b.expected_input_hash)
        throw conflict('INPUT_REVISION_CONFLICT','Project draft or latest input lock changed');
      const historical=await client.query("SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND role='historical' AND deleted_at IS NULL LIMIT 1",[user,id]);
      const pendingHistorical=await client.query(`SELECT 1 FROM bb_uploads u
        WHERE u.owner_user_id=$1 AND u.project_id=$2 AND u.role='historical'
          AND (u.state IN ('uploading','received') OR (u.state='completed' AND NOT EXISTS (
            SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=u.owner_user_id
              AND m.project_id=u.project_id AND m.upload_id=u.id AND m.role='historical'
          ))) LIMIT 1`,[user,id]);
      if(historical.rowCount||pendingHistorical.rowCount)
        throw conflict('INPUT_REVISION_CONFLICT','Historical prospectus material, unfinished upload, or completed upload without material blocks conversion');
      const runs=await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 LIMIT 1',[user,id]);
      const pending=await client.query(`SELECT 1 FROM bb_jobs j LEFT JOIN bb_runs r ON r.owner_user_id=j.owner_user_id AND r.id=j.run_id
        WHERE j.owner_user_id=$1 AND COALESCE(j.project_id,r.project_id)=$2
          AND j.job_type IN ('update','review','generation','qa') AND j.state IN ('queued','running','paused') LIMIT 1`,[user,id]);
      if(runs.rowCount||pending.rowCount)
        throw conflict('INPUT_REVISION_CONFLICT','Project has a run or pending execution work');
      const changed=(await client.query("UPDATE bb_projects SET kind='generation',draft_revision=draft_revision+1,updated_at=now() WHERE owner_user_id=$1 AND id=$2 RETURNING draft_revision",[user,id])).rows[0];
      const receipt=(await client.query(`INSERT INTO bb_project_kind_conversions
        (id,owner_user_id,project_id,request_id,request_hash,from_kind,to_kind,old_draft_revision,new_draft_revision,latest_input_revision,latest_input_hash)
        VALUES($1,$2,$3,$4,$5,'update','generation',$6,$7,$8,$9) RETURNING created_at`,
        [uid(),user,id,b.conversion_request_id,requestHash,p.draft_revision,changed.draft_revision,p.latest_input_revision,p.input_hash??null])).rows[0];
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',
        [uid(),user,'project',id,'project.kind_converted',{project_id:id,conversion_request_id:b.conversion_request_id,from_kind:'update',to_kind:'generation',draft_revision:changed.draft_revision,latest_input_revision:p.latest_input_revision,latest_input_hash:p.input_hash?.trim()??null}]);
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'project_edit',status:'submitted'});
      return {conversion_request_id:b.conversion_request_id,project_id:id,from_kind:'update',to_kind:'generation',old_draft_revision:p.draft_revision,draft_revision:changed.draft_revision,previous_input_revision:p.latest_input_revision,previous_input_hash:p.input_hash?.trim()??null,converted_at:date(receipt.created_at)};
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
      const active=await client.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') LIMIT 1",[user,id]);
      if(active.rows[0])throw conflict('PROJECT_DELETE_BLOCKED','Cancel or finish active runs before deleting the project');
      // Material soft deletion writes 0006 storage tombstones; 0026 purges derived content after the same window.
      const materials=await client.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL',[user,id]);
      const artifacts=await client.query("UPDATE bb_artifact_versions a SET delivery_status='revoked' FROM bb_runs r WHERE r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.owner_user_id=$1 AND r.project_id=$2 AND a.delivery_status<>'revoked' RETURNING a.id,a.version",[user,id]);
      for(const a of artifacts.rows)await client.query('DELETE FROM bb_artifact_download_grants WHERE owner_user_id=$1 AND artifact_id=$2 AND artifact_version=$3',[user,a.id,a.version]);
      await client.query('UPDATE bb_projects SET deleted_at=now(),updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id]);
      await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'project.deleted',$4)",[uid(),user,id,{material_versions_deleted:materials.rowCount??0,artifacts_revoked:artifacts.rowCount??0}]);
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'project_delete',status:'submitted'});
    });
    return reply.code(204).send();
  });
  app.post('/api/v1/projects/:project_id/input-revisions',{schema:{body:schemas.InputRevisionCreateRequest}},async (request,reply)=>{
    const user=await owner(request), id=param(request,'project_id');
    const b=body<{draft_revision:number;material_versions:{material_id:string;material_version:number}[];requirement_message_ids:string[];target_confirmation?:TargetConfirmationRequest;user_reference?:UserReferenceChoice;rule_applicability_context_ref?:RuleApplicabilityContextRef;test_rule_applicability_context_ref?:RuleApplicabilityContextRef;credit_facility_supplements?:{supplement_id:string;version:number;request_hash:string}[];generation_issuer_binding_ref?:GenerationIssuerBindingRef;project_message_set_ref?:ProjectMessageSetRef}>(request);
    if(b.test_rule_applicability_context_ref && !testChannelEnabled())
      throw new Problem(403,'TEST_CHANNEL_DISABLED','Test channel is disabled');
    const result=await transaction(db(),async client=>{
      const p=await project(client,user,id,true);
      if(p.draft_revision!==b.draft_revision) throw conflict('INPUT_REVISION_CONFLICT','Draft revision changed');
      let targetConfirmation;
      if (b.target_confirmation) {
        try {
          targetConfirmation=confirmTargetIntent(b.target_confirmation,{market:p.market,offering:p.offering,
            target_reporting_periods:projectDto(p).update_details?.target_reporting_periods},user,new Date().toISOString());
        } catch (error) {
          if (error instanceof Error && ['TARGET_DRAFT_MISMATCH','TARGET_DATE_INVALID','TARGET_PERIOD_CONFLICT'].includes(error.message))
            throw new Problem(422,'VALIDATION_FAILED','Target confirmation must match the current draft and valid date');
          throw error;
        }
      }
      const refs=[...b.material_versions].sort((a,z)=>a.material_id.localeCompare(z.material_id)||a.material_version-z.material_version);
      if(new Set(refs.map(r=>r.material_id)).size!==refs.length) throw new Problem(422,'VALIDATION_FAILED','Duplicate material IDs');
      const resolved=[];
      for(const ref of refs){const q=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL FOR SHARE',[user,id,ref.material_id,ref.material_version]);if(!q.rows[0])throw missing();resolved.push({material_id:ref.material_id,material_version:ref.material_version,role:q.rows[0].role,sha256:q.rows[0].sha256.trim()});}
      if (['update','generation'].includes(p.kind) && p.update_details?.authoring_mode === 'unified_v1')
        assertAuthoringSourceInformation(resolved, p.update_details.source_prospectuses);
      let issuerIdentity: ReturnType<typeof pendingIssuerIdentityBinding> | ReturnType<typeof verifiedIssuerIdentityBinding> | undefined;
      let testIssuerCandidate: Awaited<ReturnType<typeof loadTestIssuerCandidate>> = null;
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
            testIssuerCandidate=await loadTestIssuerCandidate(client,{ownerUserId:user,projectId:id,
              materialId:selected.material_id,materialVersion:selected.material_version});
          }else{
            if(verified.materialId!==selected.material_id||verified.materialVersion!==selected.material_version)throw new Error('ISSUER_IDENTITY_SCOPE_MISMATCH');
            issuerIdentity=verifiedIssuerIdentityBinding(verified);
          }
        }
      }
      // #17 input-lock consumption: an explicitly supplied ref is re-verified inside this
      // transaction against the exact stored decision and the newly locked materials. A missing
      // ref keeps the generation identity gate closed; an invalid ref never falls back to the
      // browser issuer_name and never selects a latest binding.
      if(b.generation_issuer_binding_ref && p.kind!=='generation')
        throw new Problem(422,'VALIDATION_FAILED','Generation issuer binding ref requires a generation project');
      let generationIssuerBinding: { ref: GenerationIssuerBindingRef; issuerEntityId: string } | undefined;
      if(b.generation_issuer_binding_ref){
        const binding=await loadApprovedGenerationIssuerBindingForLock(client,{ownerUserId:user,projectId:id},b.generation_issuer_binding_ref);
        const materialKey=(item:{material_id:string;material_version:number;role:string;sha256:string})=>`${item.material_id}\u0000${item.material_version}\u0000${item.role}\u0000${item.sha256}`;
        const issuerMaterials=resolved.filter(item=>GENERATION_ISSUER_MATERIAL_ROLES.includes(item.role)).map(materialKey).sort();
        const pinnedMaterials=binding?.selected_materials.map(pin=>materialKey({material_id:pin.material_id,material_version:pin.material_version,role:pin.role,sha256:pin.material_sha256})).sort()??[];
        if(!binding||!binding.issuer_entity_id||issuerMaterials.length!==pinnedMaterials.length||
           !issuerMaterials.every((value,index)=>value===pinnedMaterials[index]))
          throw conflict('INPUT_REVISION_CONFLICT','Generation issuer binding is missing, withdrawn, stale or does not match the selected issuer materials');
        generationIssuerBinding={ref:{binding_id:binding.binding_id,version:binding.version,content_sha256:binding.content_sha256},issuerEntityId:binding.issuer_entity_id};
      }
      // #17 input-lock consumption: the active message-set identity is re-derived from immutable
      // owner/project rows. A supplied ref must equal that exact set; a non-empty set must be
      // pinned explicitly and is never replaced by an empty placeholder.
      let currentMessageSet: Awaited<ReturnType<typeof loadCurrentProjectMessageSetPin>>;
      try { currentMessageSet=await loadCurrentProjectMessageSetPin(client,{ownerUserId:user,projectId:id}); }
      catch(error) {
        if(isProjectMessageSetLockError(error)) throw new Problem(503,'DATA_UNAVAILABLE','Stored project message set could not be verified');
        throw error;
      }
      let projectMessageSetRef: ProjectMessageSetRef | undefined;
      if(b.project_message_set_ref){
        let matches=false;
        try { assertProjectMessageSetRefMatches(currentMessageSet,b.project_message_set_ref);matches=true; } catch { matches=false; }
        if(!matches) throw conflict('INPUT_REVISION_CONFLICT','Message set ref does not match the current active project messages');
        projectMessageSetRef={version:b.project_message_set_ref.version,content_sha256:b.project_message_set_ref.content_sha256,message_ids:[...b.project_message_set_ref.message_ids]};
      } else if(currentMessageSet.members.length>0){
        throw conflict('INPUT_REVISION_CONFLICT','Active project messages must be pinned with an exact project_message_set_ref');
      }
      const requirementMessageIds=projectMessageSetRef?projectMessageSetRef.message_ids:[];
      if(b.requirement_message_ids.length &&
        (b.requirement_message_ids.length!==requirementMessageIds.length ||
         [...b.requirement_message_ids].sort().some((messageId,index)=>messageId!==requirementMessageIds[index])))
        throw conflict('INPUT_REVISION_CONFLICT','Requirement message IDs do not match the locked project message set');
      const revision=(p.latest_input_revision??0)+1;
      if(b.user_reference && (p.kind!=='generation'||!p.market||!p.offering))
        throw new Problem(422,'VALIDATION_FAILED','User reference requires a generation target');
      const referenceScope={owner:user,projectId:id,revision,market:String(p.market),offering:String(p.offering)};
      const userReference=b.user_reference
        ?await resolveUserReferencePin(client,referenceScope,b.user_reference,resolved):null;
      let creditFacilitySupplementPins: Awaited<ReturnType<typeof lockCreditFacilitySupplementPins>> | undefined;
      if(b.credit_facility_supplements?.length){
        try {
          creditFacilitySupplementPins=await lockCreditFacilitySupplementPins(client,{ownerUserId:user,projectId:id},b.credit_facility_supplements);
        } catch(error) {
          const code=error instanceof Error?error.message:'';
          if(code==='CREDIT_SUPPLEMENT_PIN_NOT_FOUND')throw missing();
          if(code==='CREDIT_SUPPLEMENT_PIN_HASH_MISMATCH')throw conflict('INPUT_REVISION_CONFLICT','Credit supplement version hash changed');
          if(code==='INVALID_CREDIT_FACILITY_SUPPLEMENT_PIN'||code==='DUPLICATE_CREDIT_FACILITY_SUPPLEMENT_PIN')
            throw new Problem(422,'VALIDATION_FAILED','Credit supplement references are invalid or duplicated');
          throw new Problem(503,'DATA_UNAVAILABLE','Stored credit supplement could not be verified');
        }
      }
      // Update generation must only see the reviewed historical issuer name, never the browser draft label.
      const manifest={draft_revision:p.draft_revision,name:p.name,kind:p.kind,issuer_name:p.kind==='update'?(issuerIdentity?.status==='verified'?issuerIdentity.issuer_display_name:null):p.issuer_name,market:p.market,offering:p.offering,update_details:projectDto(p).update_details,materials:resolved,requirement_message_ids:requirementMessageIds,rule_pack_version:null,template_version:null,reference_release:null};
      if(projectMessageSetRef)Object.assign(manifest,{project_message_set_ref:projectMessageSetRef});
      if(generationIssuerBinding)Object.assign(manifest,{generation_issuer_binding_ref:generationIssuerBinding.ref,generation_issuer_entity_id:generationIssuerBinding.issuerEntityId});
      Object.assign(manifest,{target_confirmation:targetConfirmation??{status:'unconfirmed',market:null,offering:null,document_purpose:null,as_of:null,target_reporting_periods:[],confirmed_by:null,confirmed_at:null}});
      if(p.kind==='update'){
        Object.assign(manifest,{issuer_identity:issuerIdentity,issuer_entity_id:issuerIdentity?.status==='verified'?issuerIdentity.entity_id:null});
        if(testIssuerCandidate)Object.assign(manifest,{test_issuer_candidate:testIssuerCandidate});
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
      if(b.test_rule_applicability_context_ref){
        const testPin=await lockTestRuleApplicabilityRef(client,p,{draftRevision:p.draft_revision,materials:resolved},
          issuerIdentity?.status==='verified'?issuerIdentity:undefined,b.test_rule_applicability_context_ref);
        Object.assign(manifest,{test_rule_applicability_ref:testPin.ref,
          test_rule_applicability_block_reason:testPin.reason});
      }
      if(userReference)Object.assign(manifest,{user_reference_pin:userReference.pin});
      if(creditFacilitySupplementPins?.length)Object.assign(manifest,{credit_facility_supplements:creditFacilitySupplementPins});
      if (p.update_details?.authoring_mode === 'unified_v1') {
        const authoring: import('@bondbuddy/contracts').UnifiedAuthoringInput = await lockUnifiedAuthoring(p, resolved, currentMessageSet);
        const previous = (await client.query(`SELECT a.id,a.version,a.sha256,r.id AS run_id,r.input_revision,i.manifest
          FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
          JOIN bb_artifact_versions a ON a.id=j.checkpoint#>>'{stages,word_delivery_pair,clean_artifact_id}' AND a.owner_user_id=r.owner_user_id AND a.run_id=r.id
          JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
          WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.state='succeeded' AND r.channel='production'
            AND a.quality_status='passed' AND a.delivery_status='available' ORDER BY r.created_at DESC LIMIT 1`,[user,id])).rows[0];
        const sourceKey = (items: {material_id:string;material_version:number;role:string;sha256:string}[]) => JSON.stringify(items.filter(m => ['historical','reference'].includes(m.role)).map(m => [m.material_id,m.material_version,m.sha256]).sort());
        if (previous && isUnifiedInput(previous.manifest) && previous.manifest.issuer_name === p.issuer_name &&
            sourceKey(previous.manifest.materials as typeof resolved) === sourceKey(resolved)) {
          authoring.previous_output = { artifact_id:previous.id,version:previous.version,sha256:String(previous.sha256).trim(),run_id:previous.run_id,input_revision:previous.input_revision };
        }
        Object.assign(manifest, { issuer_name: p.issuer_name, authoring });
      }
      const hash=inputManifestHash(manifest);
      const q=await client.query('INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[id,revision,user,p.draft_revision,hash,manifest,JSON.stringify(refs),JSON.stringify(requirementMessageIds),ruleBinding.status==='selected'?ruleBinding.pin.version:null,ruleBinding.status==='selected'?ruleBinding.pin.templateVersion:null]);
      if(targetConfirmation)await client.query(`INSERT INTO bb_input_revision_target_confirmations
        (owner_user_id,project_id,input_revision,market,offering,document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[user,id,revision,targetConfirmation.market,targetConfirmation.offering,
          targetConfirmation.document_purpose,targetConfirmation.as_of,JSON.stringify(targetConfirmation.target_reporting_periods),user,targetConfirmation.confirmed_at]);
      if(userReference)await insertUserReferencePin(client,referenceScope,userReference.pin,userReference.outline);
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
  const ruleContextDraftPath='/api/v1/projects/:project_id/input-revisions/:input_revision/rule-applicability-context-drafts';
  app.post(ruleContextDraftPath,{schema:{body:schemas.RuleApplicabilityContextDraftCreateRequest,response:{201:schemas.RuleApplicabilityContextDraftResponse}}},async(request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),revisionText=param(request,'input_revision');
    reply.header('cache-control','private, no-store');
    if(!/^[1-9][0-9]{0,9}$/.test(revisionText)||Number(revisionText)>2147483647)throw new Problem(422,'VALIDATION_FAILED','Input revision is out of range');
    const revision=Number(revisionText),requestId=body<{request_id:string}>(request).request_id;
    await project(db(),user,id);
    const source=(await db().query(`SELECT i.input_hash,i.draft_revision,i.manifest,i.material_versions,p.draft_revision AS current_draft_revision,p.kind,p.deleted_at
      FROM bb_input_revisions i JOIN bb_projects p ON p.owner_user_id=i.owner_user_id AND p.id=i.project_id
      WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`,[user,id,revision])).rows[0];
    if(!source||source.deleted_at!==null)throw missing();
    const stale=()=>conflict('INPUT_REVISION_CONFLICT','Locked input revision, materials, or verified issuer identity changed');
    if(Number(source.draft_revision)!==Number(source.current_draft_revision))throw stale();
    const manifest=source.manifest;
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||inputManifestHash(manifest)!==String(source.input_hash).trim())throw stale();
    const snapshot=manifest as Record<string,unknown>;
    if(snapshot.draft_revision!==Number(source.draft_revision)||!Array.isArray(snapshot.materials))throw stale();
    const materials=snapshot.materials.filter((material):material is Record<string,unknown>=>!!material&&typeof material==='object'&&!Array.isArray(material));
    const historical=materials.filter(material=>material.role==='historical');
    if(historical.length!==1)throw stale();
    const selected=historical[0]!;
    const identityBinding=snapshot.issuer_identity;
    if(source.kind!=='update'||!isVerifiedIssuerIdentityBinding(identityBinding)||
       identityBinding.material_id!==selected.material_id||identityBinding.material_version!==selected.material_version)throw stale();
    const materialLive=(await db().query(`SELECT role,sha256,deleted_at FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,[user,id,selected.material_id,selected.material_version])).rows[0];
    if(!materialLive||materialLive.deleted_at!==null||materialLive.role!=='historical'||
       String(materialLive.sha256).trim().toLowerCase()!==String(selected.sha256).trim().toLowerCase())throw stale();
    const currentIdentity=await loadVerifiedIssuerIdentitySourceRecord(db(),{ownerUserId:user,projectId:id,
      materialId:String(selected.material_id),materialVersion:Number(selected.material_version)});
    if(!currentIdentity||!issuerIdentityBindingMatches(identityBinding,currentIdentity))throw stale();
    const market=snapshot.market,offering=snapshot.offering;
    const validMarket=market==='sse'||market==='szse'||market==='nafmii';
    const validOffering=market==='sse'?MARKET_OFFERINGS.sse.includes(offering as never):
      market==='szse'?MARKET_OFFERINGS.szse.includes(offering as never):
      market==='nafmii'?MARKET_OFFERINGS.nafmii.includes(offering as never):false;
    if((market!==null&&!validMarket)||(offering!==null&&(!validOffering||!validMarket)))throw stale();
    const persistedTarget=await loadTargetConfirmation(db(),user,id,revision);
    const lockedTarget=snapshot.target_confirmation;
    if(persistedTarget===null){
      if(!lockedTarget||typeof lockedTarget!=='object'||Array.isArray(lockedTarget)||
         (lockedTarget as Record<string,unknown>).status!=='unconfirmed')throw stale();
    }else if(!lockedTarget||typeof lockedTarget!=='object'||Array.isArray(lockedTarget)||
             stableJson(lockedTarget)!==stableJson(persistedTarget)||
             persistedTarget.market!==market||persistedTarget.offering!==offering||persistedTarget.confirmed_by!==user){
      throw stale();
    }
    // User confirmation is immutable task intent, not a parsed or professionally reviewed source fact.
    // Keep these candidates user_asserted until the independent #19 review path approves them.
    const targetAsOf=persistedTarget?.as_of??null;
    const targetPurpose=persistedTarget?.document_purpose??null;
    const unknown=(fieldKey:string)=>({fieldKey,value:null,sourceKind:'unknown' as const,sourceStatus:'unknown' as const});
    const asserted=(fieldKey:string,value:unknown)=>value===null?unknown(fieldKey):({fieldKey,value,sourceKind:'user_asserted' as const,sourceStatus:'user_asserted' as const});
    try{
      const result=await createRuleApplicabilityContextDraft(db(),{
        ownerUserId:user,projectId:id,sourceInputRevision:revision,sourceInputHash:String(source.input_hash).trim(),
        selectedMaterial:{materialId:String(selected.material_id),materialVersion:Number(selected.material_version),
          sha256:String(selected.sha256).trim().toLowerCase(),parseSnapshotId:identityBinding.source_snapshot_id},
        issuerIdentityBinding:{recordId:identityBinding.record_id,version:identityBinding.version,contentHash:identityBinding.content_hash,
          entityId:identityBinding.entity_id,materialId:identityBinding.material_id,materialVersion:identityBinding.material_version},
        asOf:targetAsOf,documentPurpose:targetPurpose,requestId,
        fieldCandidates:[asserted('market',market),asserted('offering',offering),asserted('asOf',targetAsOf),
          asserted('documentPurpose',targetPurpose),unknown('industry'),unknown('specialFeatures')],
      });
      return reply.code(201).send({status:'needs_review',production_eligible:false,context_ref:{context_id:result.contextId,version:result.version,
        content_hash:result.contentHash,source_input_revision:revision,source_input_hash:String(source.input_hash).trim()}});
    }catch(error){
      if(error instanceof Error){
        if(error.message==='RULE_CONTEXT_IDEMPOTENCY_CONFLICT')throw conflict('IDEMPOTENCY_CONFLICT','Request ID is already bound to another applicability draft');
        if(error.message.startsWith('RULE_CONTEXT_SOURCE_')||error.message.startsWith('RULE_CONTEXT_SELECTED_')||
           error.message.startsWith('RULE_CONTEXT_ISSUER_IDENTITY_'))throw stale();
      }
      throw error;
    }
  });
  app.get('/api/v1/projects/:project_id/rule-applicability-context-drafts/:context_id/versions/:version',
    {schema:{response:{200:schemas.RuleApplicabilityContextDraftResponse}}},async(request,reply)=>{
      const user=await owner(request),id=param(request,'project_id'),versionText=param(request,'version');
      reply.header('cache-control','private, no-store');
      await project(db(),user,id);
      if(!/^[1-9][0-9]{0,9}$/.test(versionText)||Number(versionText)>2147483647)throw missing();
      const draft=await readRuleApplicabilityContextDraftRef(db(),{ownerUserId:user,projectId:id,contextId:param(request,'context_id'),version:Number(versionText)});
      if(!draft)throw missing();
      return {status:'needs_review' as const,production_eligible:false as const,context_ref:{context_id:draft.contextId,version:draft.version,
        content_hash:draft.contentHash,source_input_revision:draft.sourceInputRevision,source_input_hash:draft.sourceInputHash}};
    });
  app.post('/api/v1/projects/:project_id/rule-applicability-context-drafts/:context_id/versions/:version/reviews',
    {schema:{body:schemas.RuleApplicabilityOverallReviewCreateRequest,response:{201:schemas.RuleApplicabilityOverallReviewResponse}}},async(request,reply)=>{
      const reviewerUserId=await owner(request),projectId=param(request,'project_id'),contextId=param(request,'context_id'),versionText=param(request,'version');
      reply.header('cache-control','private, no-store');
      if(!/^[1-9][0-9]{0,9}$/.test(versionText)||Number(versionText)>2147483647)throw missing();
      const version=Number(versionText),draft=(await db().query(`SELECT d.owner_user_id,d.project_id,d.id,d.version,d.content_hash,d.source_input_revision,d.source_input_hash
        FROM bb_rule_applicability_context_drafts d JOIN bb_rule_applicability_reviewer_grants g
          ON g.scope_owner_user_id=d.owner_user_id AND g.scope_project_id=d.project_id AND g.user_id=$4
          AND g.role='rule_applicability_reviewer' AND g.revoked_at IS NULL
        JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
        JOIN bb_users u ON u.id=g.user_id AND u.status='active'
        WHERE d.project_id=$1 AND d.id=$2 AND d.version=$3`,[projectId,contextId,version,reviewerUserId])).rows[0];
      if(!draft)throw missing();
      const b=body<{request_id:string;action:'approve'|'request_more_evidence'|'withdraw';reason:string;
        approved_values?:AppendRuleApplicabilityOverallReviewInput['approvedValues'];
        value_evidence?:AppendRuleApplicabilityOverallReviewInput['valueEvidence'];
        feature_evidence?:AppendRuleApplicabilityOverallReviewInput['featureEvidence'];taxonomy_version?:string}>(request);
      try{
        const record=await appendRuleApplicabilityOverallReview(db(),{requestId:b.request_id,action:b.action,reason:b.reason,
          approvedValues:b.approved_values,valueEvidence:b.value_evidence,featureEvidence:b.feature_evidence,taxonomyVersion:b.taxonomy_version,
          principal:{userId:reviewerUserId},
          scope:{ownerUserId:String(draft.owner_user_id),projectId},target:{contextId,contextVersion:version,
            contextContentHash:String(draft.content_hash).trim(),sourceInputRevision:Number(draft.source_input_revision),
            sourceInputHash:String(draft.source_input_hash).trim()}});
        return reply.code(201).send({review_id:record.id,action:record.action,replayed:record.replayed,production_eligible:false});
      }catch(error){
        if(error instanceof Error){
          if(error.message==='OVERALL_REVIEW_REVIEWER_NOT_AUTHORIZED')throw new Problem(403,'FORBIDDEN','Exact project reviewer grant required');
          if(error.message==='OVERALL_REVIEW_IDEMPOTENCY_CONFLICT')throw conflict('IDEMPOTENCY_CONFLICT','Request ID is already bound to another review');
          if(error.message.startsWith('OVERALL_REVIEW_'))throw new Problem(422,'VALIDATION_FAILED','Applicability review input or source evidence is invalid');
        }
        throw error;
      }
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
      await project(client,user,id,true);
      if(b.role==='historical'){
        const converted=await client.query('SELECT 1 FROM bb_project_kind_conversions WHERE owner_user_id=$1 AND project_id=$2',[user,id]);
        if(converted.rowCount)throw conflict('INPUT_REVISION_CONFLICT','Converted no-history project cannot accept historical prospectus material');
      }
      await admitUploadCreate(client,trial,user,sourceHash(request.ip),b.byte_size);
      await client.query('INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[uploadId,user,id,b.filename,b.media_type,b.byte_size,b.sha256,b.role,key,expires]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'upload',uploadId,'upload.created',{project_id:id}]);
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'material_upload_start',status:'submitted'});
    }).catch(async error=>{await trialRejected(error,user,'upload_create',id,request.id);throw error;});
    return reply.code(201).send({upload_id:uploadId,state:'uploading',upload_url:`/api/v1/projects/${id}/materials/uploads/${uploadId}/bytes`,expires_at:expires.toISOString(),max_bytes:MAX_BYTES});
  });
  app.post('/api/v1/projects/:project_id/materials/role-copies',{schema:{body:schemas.MaterialRoleCopyRequest}},async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id');
    const b=body<{request_key:string;source_material_id:string;source_material_version:number;source_sha256:string;source_media_type:string;target_role:'historical'}>(request);
    const requestHash=digest(stableJson(b)),traceId=uid();
    const freshUpload=async(client:PoolClient,source:any)=>{
      const uploadId=uid(),key=`users/${user}/projects/${id}/uploads/${uploadId}`;
      await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'historical',$8,now()+interval '15 minutes')`,
        [uploadId,user,id,source.filename,source.media_type,source.byte_size,b.source_sha256,key]);
      return uploadId;
    };
    // Commit a discoverable upload reservation before writing any Blob bytes. A crash after
    // this point leaves an ordinary orphan upload for the existing storage lifecycle.
    await transaction(db(),async client=>{
      const p=await project(client,user,id,true);
      const prior=await client.query(`SELECT * FROM bb_material_role_copy_receipts
        WHERE owner_user_id=$1 AND project_id=$2 AND request_key=$3 FOR UPDATE`,[user,id,b.request_key]);
      if(prior.rows[0]){
        if(prior.rows[0].request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','Request key is bound to another source');
        return;
      }
      if(p.kind!=='update')throw conflict('INPUT_REVISION_CONFLICT','Historical material requires an update project');
      const converted=await client.query('SELECT 1 FROM bb_project_kind_conversions WHERE owner_user_id=$1 AND project_id=$2',[user,id]);
      if(converted.rowCount)throw conflict('INPUT_REVISION_CONFLICT','Converted project cannot accept historical material');
      const source=(await client.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2
        AND id=$3 AND version=$4 AND deleted_at IS NULL FOR UPDATE`,[user,id,b.source_material_id,b.source_material_version])).rows[0];
      if(!source)throw missing();
      if(source.role!=='reference'||!['application/pdf',DOCX_MEDIA_TYPE].includes(source.media_type)||
        source.sha256.trim()!==b.source_sha256||source.media_type!==b.source_media_type||
        !Number.isSafeInteger(Number(source.byte_size))||Number(source.byte_size)>MAX_BYTES)
        throw conflict('MATERIAL_CONTENT_MISMATCH','Source identity, format or bytes differ');
      const capacity=(await client.query(`SELECT count(*)::int files,COALESCE(sum(byte_size),0)::bigint bytes
        FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL`,[user,id])).rows[0];
      if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+Number(source.byte_size)>M1_UPLOAD_LIMITS.projectBytes)
        throw new Problem(422,'VALIDATION_FAILED','Project material limit: 60 files / 500 MiB');
      const uploadId=await freshUpload(client,source);
      await client.query(`INSERT INTO bb_material_role_copy_receipts
        (id,owner_user_id,project_id,request_key,request_hash,source_material_id,source_material_version,source_sha256,target_role,upload_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'historical',$9)`,
        [uid(),user,id,b.request_key,requestHash,b.source_material_id,b.source_material_version,b.source_sha256,uploadId]);
    });
    const result=await transaction(db(),async client=>{
      await project(client,user,id,true);
      const receipt=(await client.query(`SELECT * FROM bb_material_role_copy_receipts
        WHERE owner_user_id=$1 AND project_id=$2 AND request_key=$3 FOR UPDATE`,[user,id,b.request_key])).rows[0];
      if(!receipt)throw missing();
      if(receipt.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','Request key is bound to another source');
      if(receipt.material_id){
        const saved=(await client.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2
          AND id=$3 AND deleted_at IS NULL`,[user,id,receipt.material_id])).rows[0];
        if(!saved)throw missing();
        const verified=await readBlobToFile(blob(),saved.object_key,null,Number(saved.byte_size));
        if(!verified||verified.byteSize!==Number(saved.byte_size)||verified.sha256!==saved.sha256.trim())
          throw new Problem(503,'DATA_UNAVAILABLE','Copied material bytes are unavailable');
        return {receipt_id:receipt.id,source_material_id:receipt.source_material_id,source_material_version:receipt.source_material_version,material:materialDto(saved)};
      }
      const source=(await client.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2
        AND id=$3 AND version=$4 AND deleted_at IS NULL FOR UPDATE`,[user,id,b.source_material_id,b.source_material_version])).rows[0];
      if(!source||source.role!=='reference'||source.sha256.trim()!==b.source_sha256||source.media_type!==b.source_media_type)throw missing();
      let upload=(await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[user,receipt.upload_id])).rows[0];
      if(upload.state==='deleting'||upload.state==='purged'){
        const replacement=await freshUpload(client,source);
        await client.query('UPDATE bb_material_role_copy_receipts SET upload_id=$2 WHERE id=$1',[receipt.id,replacement]);
        upload=(await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[user,replacement])).rows[0];
      }
      if(upload.state!=='uploading'&&upload.state!=='received')throw conflict('IDEMPOTENCY_CONFLICT','Copy reservation is no longer writable');
      const capacity=(await client.query(`SELECT count(*)::int files,COALESCE(sum(byte_size),0)::bigint bytes
        FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL`,[user,id])).rows[0];
      if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+Number(source.byte_size)>M1_UPLOAD_LIMITS.projectBytes)
        throw new Problem(422,'VALIDATION_FAILED','Project material limit: 60 files / 500 MiB');
      const release=reserveSpool(Number(source.byte_size)),copy=join(spoolDirectory(),`${uid()}.blob`);
      let signatureAssessment:unknown=null;
      try{
        await mkdir(spoolDirectory(),{recursive:true,mode:0o700});
        const bytes=await readBlobToFile(blob(),source.object_key,copy,MAX_BYTES);
        if(!bytes||bytes.byteSize!==Number(source.byte_size)||bytes.sha256!==b.source_sha256)
          throw new Problem(503,'DATA_UNAVAILABLE','Source bytes failed integrity check');
        const inspection=await verifiedMediaFileDetailed(copy,bytes.byteSize,source.media_type);
        if(inspection.mediaType!==source.media_type)throw conflict('MATERIAL_CONTENT_MISMATCH','Source media type changed');
        signatureAssessment=inspection.signatureAssessment;
        await putBlobFile(blob(),upload.object_key,copy,source.media_type);
        const target=await readBlobToFile(blob(),upload.object_key,null,Number(source.byte_size));
        if(!target||target.byteSize!==Number(source.byte_size)||target.sha256!==b.source_sha256)
          throw new Problem(503,'DATA_UNAVAILABLE','Copied bytes failed integrity check');
      }finally{await discardSpool(copy);release();}
      const materialId=uid();
      await client.query("UPDATE bb_uploads SET state='received',received_sha256=$2,received_bytes=$3 WHERE id=$1",
        [upload.id,b.source_sha256,source.byte_size]);
      const saved=(await client.query(`INSERT INTO bb_material_versions
        (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state,signature_assessment)
        VALUES($1,1,$2,$3,$4,'historical',$5,$6,$7,$8,$9,'persisted',$10::jsonb) RETURNING *`,
        [materialId,user,id,upload.id,source.filename,source.media_type,source.byte_size,b.source_sha256,upload.object_key,
          signatureAssessment===null?null:JSON.stringify(signatureAssessment)])).rows[0];
      await client.query("UPDATE bb_uploads SET state='completed' WHERE id=$1",[upload.id]);
      await client.query('UPDATE bb_material_role_copy_receipts SET material_id=$2,completed_at=now() WHERE id=$1',[receipt.id,materialId]);
      await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'material',$3,'material.role_copied',$4)`,
        [uid(),user,materialId,{project_id:id,source_material_id:source.id,source_material_version:source.version,material_id:materialId,material_version:1,receipt_id:receipt.id}]);
      await appendProjectMaterialEvent(client,user,id,materialId,Number(source.byte_size));
      await enqueueMaterialParse(client,{owner:user,projectId:id,materialId,materialVersion:1,sha256:b.source_sha256,traceId});
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'material_role_copy',status:'submitted'});
      return {receipt_id:receipt.id,source_material_id:source.id,source_material_version:source.version,material:materialDto(saved)};
    });
    return reply.code(201).send(result);
  });
  app.put('/api/v1/projects/:project_id/materials/uploads/:upload_id/bytes',async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),uploadId=param(request,'upload_id');await project(db(),user,id);
    const stream=request.body as Readable|undefined;if(!stream||typeof stream.pipe!=='function')throw new Problem(422,'VALIDATION_FAILED','Binary upload required');
    // Reject unknown, finished or expired uploads before accepting any bytes; the locked re-check below stays authoritative.
    const pre=(await db().query('SELECT state,byte_size,expires_at FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,uploadId])).rows[0];
    if((await db().query('SELECT 1 FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId])).rowCount)throw missing();
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
        if((await client.query('SELECT 1 FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId])).rowCount)throw missing();
        if((await client.query('SELECT 1 FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND upload_id=$2',[user,uploadId])).rowCount)throw conflict('IDEMPOTENCY_CONFLICT','Upload already resolved; retry completion');
        if(u.state==='completed')throw conflict('IDEMPOTENCY_CONFLICT','Upload already completed');
        if(u.state!=='uploading'&&u.state!=='received')throw missing();
        if(new Date(u.expires_at).getTime()<Date.now())throw new Problem(422,'VALIDATION_FAILED','Upload expired');
        if(bytes.byteSize!==Number(u.byte_size)||bytes.sha256!==u.sha256.trim())throw mismatch();
        const excepted=uploadInspectionExceptionMatches(uploadInspectionException,{
          ownerUserId:user,projectId:id,role:u.role,byteSize:bytes.byteSize,sha256:bytes.sha256,mediaType:u.declared_media_type
        });
        if(!excepted)await verifiedMediaFile(bytes.path,bytes.byteSize,u.declared_media_type);
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
        await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'material_upload_bytes',status:'submitted'});
        if(excepted)await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'material_upload_exception_bytes',status:'submitted'});
      });
    }catch(error){
      if(error instanceof Problem&&error.uploadReason){
        const evidence={event:'material_upload_inspection_rejected',error_id:request.id,code:error.code,reason:error.uploadReason,...(error.uploadDetail?{detail:error.uploadDetail}:{}),project_id:id,upload_id:uploadId};
        process.stderr.write(`${JSON.stringify(evidence)}\n`);
        await rejectOperation(db(),{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'material_upload',status:'rejected',errorCode:error.code,errorId:request.id,errorReason:error.uploadReason,errorDetail:error.uploadDetail});
      }
      throw error;
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
      if((await client.query('SELECT 1 FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId])).rowCount)throw missing();
      if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
      const receipt=await client.query('SELECT material_id,material_version FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId]);
      let excepted=false;
      // The parse job, its outbox/log rows and the #79 operation commit with the verified completion.
      const accepted=async (m:any)=>{
        await enqueueMaterialParse(client,{owner:user,projectId:id,materialId:m.id,materialVersion:m.version,sha256:m.sha256.trim(),traceId});
        await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'material_complete',status:'submitted'});
        if(excepted)await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'material_upload_exception_complete',status:'submitted'});
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
      let signatureAssessment: { status: 'signature_unverified'; profile_version: string; signature_count: 1 } | null = null;
      try{
        await mkdir(spoolDirectory(),{recursive:true,mode:0o700});
        const stored=await readBlobToFile(blob(),u.object_key,copy,MAX_BYTES).catch(error=>{if(error instanceof Problem&&error.status===413)return false as const;throw error;});
        if(stored===null)throw new Problem(503,'DATA_UNAVAILABLE','Stored upload bytes are temporarily unavailable');
        if(!stored||stored.byteSize!==b.byte_size||stored.sha256!==b.sha256)throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Stored bytes or hash mismatch');
        excepted=uploadInspectionExceptionMatches(uploadInspectionException,{
          ownerUserId:user,projectId:id,role:u.role,byteSize:stored.byteSize,sha256:stored.sha256,mediaType:u.declared_media_type
        });
        if(excepted) media=XLSX_MEDIA_TYPE;
        else {
          const inspection=await verifiedMediaFileDetailed(copy,stored.byteSize,u.declared_media_type);
          media=inspection.mediaType;
          signatureAssessment=inspection.signatureAssessment;
        }
      }finally{await discardSpool(copy);release();}
      const duplicate=await client.query(`SELECT * FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND role=$3 AND sha256=$4 AND byte_size=$5 AND media_type=$6 AND deleted_at IS NULL
        ORDER BY persisted_at,id,version LIMIT 1`,[user,id,u.role,b.sha256,b.byte_size,media]);
      if(duplicate.rows[0]){
        const priorAssessment=duplicate.rows[0].signature_assessment;
        if (signatureAssessment
          ? priorAssessment?.status!==signatureAssessment.status || priorAssessment?.profile_version!==signatureAssessment.profile_version || priorAssessment?.signature_count!==signatureAssessment.signature_count
          : priorAssessment!==null) throw new Problem(503,'DATA_UNAVAILABLE','Stored material inspection metadata is inconsistent');
        const m=duplicate.rows[0], result=await checkedMaterial(m);
        await client.query('INSERT INTO bb_upload_reuse_receipts(upload_id,owner_user_id,project_id,material_id,material_version) VALUES($1,$2,$3,$4,$5)',[uploadId,user,id,m.id,m.version]);
        await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'upload',$3,'upload.reused',$4)",[uid(),user,uploadId,{project_id:id,material_id:m.id,material_version:m.version}]);
        return result;
      }
      const capacity=(await client.query('SELECT count(*)::int AS files,COALESCE(sum(byte_size),0)::bigint AS bytes FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL',[user,id])).rows[0];
      if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+b.byte_size>M1_UPLOAD_LIMITS.projectBytes)
        throw new Problem(422,'VALIDATION_FAILED','Project material limit: 60 files / 500 MiB');
      const materialId=uid();
      const inserted=await client.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state,signature_assessment) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted',$11::jsonb) RETURNING *",[materialId,user,id,uploadId,u.role,u.filename,media,b.byte_size,b.sha256,u.object_key,signatureAssessment===null?null:JSON.stringify(signatureAssessment)]);
      await client.query("UPDATE bb_uploads SET state='completed' WHERE owner_user_id=$1 AND id=$2",[user,uploadId]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'material',materialId,'material.persisted',{material_id:materialId,material_version:1,project_id:id}]);
      await appendProjectMaterialEvent(client, user, id, materialId, Number(inserted.rows[0].byte_size));
      return accepted(inserted.rows[0]);
    }); } catch(error) {
      if(error instanceof Problem){
        if(error.uploadReason)process.stderr.write(`${JSON.stringify({event:'material_upload_inspection_rejected',error_id:request.id,code:error.code,reason:error.uploadReason,...(error.uploadDetail?{detail:error.uploadDetail}:{}),project_id:id,upload_id:uploadId})}\n`);
        const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,id]);
        await rejectOperation(db(),{owner:user,projectId:owned.rowCount?id:null,requestId:request.id,traceId,kind:'material_complete',status:'rejected',errorCode:error.code,errorId:error.uploadReason?request.id:undefined,errorReason:error.uploadReason,errorDetail:error.uploadDetail});
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
    await transaction(db(),client=>recordOperation(client,{owner:m.owner_user_id,projectId:m.project_id,requestId:request.id,traceId:request.id,kind:'material_download',status:'submitted'}));
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
      await recordOperation(client,{owner:user,projectId:id,requestId:request.id,traceId:request.id,kind:'material_delete',status:'submitted'});
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
  app.get('/api/v1/credits/balance',{schema:{response:{200:schemas.CreditBalanceResponse}}},async request=>{
    const user=await owner(request);return {enabled:paidAuthoring,...await creditBalance(db(),user)};
  });
  app.get('/api/v1/runs/:run_id/credit-charge',{schema:{response:{200:schemas.RunCreditChargeResponse}}},async request=>{
    const user=await owner(request),r=await run(db(),user,param(request,'run_id'));
    if(!r.reservation_id)return {quote:null,state:null};
    const row=(await db().query('SELECT q.*,r.state AS charge_state FROM bb_credit_reservations r JOIN bb_credit_quotes q ON q.id=r.quote_id AND q.owner_user_id=r.owner_user_id WHERE r.owner_user_id=$1 AND r.id=$2',[user,r.reservation_id])).rows[0];
    if(!row)throw missing();
    return {quote:quoteDto(row),state:row.charge_state};
  });
  app.post('/api/v1/projects/:project_id/credit-quote',{schema:{body:schemas.FixedQuoteRequest,response:{200:schemas.FixedQuoteResponse}}},async request=>{
    const user=await owner(request),id=param(request,'project_id');
    await project(db(),user,id);
    const b=body<{input_revision:number;input_hash:string}>(request);
    if(!isPgInputRevision(b.input_revision))throw new Problem(422,'VALIDATION_FAILED','Invalid input revision');
    if(!paidAuthoring)return {enabled:false,quote:null,balance:await creditBalance(db(),user),shortage:0,reason:null};
    return quoteCredits(db(),user,id,b.input_revision,b.input_hash);
  });
  app.post('/api/v1/runs/execute',{schema:{body:schemas.ExecuteRequest}},async (request,reply)=>{
    const user=await owner(request);
    const b=body<{execution_request_id:string;project_id:string;input_revision:number;input_hash:string;task_kind:string;input_manifest_ref:string;storage_origin:string;workspace_id:string;quote_id?:string;test_grant_id?:string;user_prompt?:string}>(request);
    const traceId=uid();
    const requestHash=digest(canonical({project_id:b.project_id,input_revision:b.input_revision,input_hash:b.input_hash,task_kind:b.task_kind,input_manifest_ref:b.input_manifest_ref,storage_origin:b.storage_origin,workspace_id:b.workspace_id,...(b.quote_id?{quote_id:b.quote_id}:{}),...(b.user_prompt?{user_prompt_sha256:digest(b.user_prompt)}:{}),...(b.test_grant_id?{channel:'non_production_test',test_grant_id:b.test_grant_id}:{})}));
    const rawExecutionKey=executionKeyStorage(b.execution_request_id);
    const wideRevision=!isPgInputRevision(b.input_revision);
    const browserKey=isBrowserUpdateKey(b.execution_request_id,b.project_id,b.input_revision,b.input_hash);
    const browserTestKey=!!b.test_grant_id&&browserKey;
    const unified = !wideRevision && isUnifiedInput((await db().query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4',[user,b.project_id,b.input_revision,b.input_hash])).rows[0]?.manifest);
    const autoBrowserTestKey=!unified&&!b.test_grant_id&&workingDraftConfigured()&&browserKey;
    const storedExecutionKey=autoBrowserTestKey?autoTestExecutionKeyStorage(b.execution_request_id):rawExecutionKey;
    const logicalExecutionKey=autoBrowserTestKey?storedExecutionKey:b.execution_request_id;
    const logicalKeyHash=executionKeyHash(logicalExecutionKey);
    const expectedChannel:'non_production_test'|'production'=b.test_grant_id||(!unified&&workingDraftConfigured())?'non_production_test':'production';
    const existingRun=async(client:PoolClient)=>{
      // Old automatic test runs used the raw browser key. Honor an exact replay
      // before looking for a new channel-scoped run, without crossing channels.
      if(autoBrowserTestKey){
        const legacy=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,rawExecutionKey]);
        if(legacy.rows[0])return legacy.rows[0];
      }
      const found=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,storedExecutionKey]);
      return found.rows[0];
    };
    const sameRun=(old:any)=>old.request_hash.trim()===requestHash&&old.channel===expectedChannel;
    const rejectBrowserTestKey=async(client:PoolClient)=>{
      const owned=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,b.project_id]);
      await recordOperation(client,{owner:user,projectId:owned.rowCount?b.project_id:null,
        requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:'VALIDATION_FAILED',
        inputRevision:owned.rowCount?b.input_revision:undefined,inputHash:owned.rowCount?b.input_hash:undefined,
        channel:'non_production_test'});
      return {errorCode:'VALIDATION_FAILED',httpStatus:422};
    };
    if(browserTestKey){
      const response=await transaction(db(),async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${executionKeyHash(b.execution_request_id)}`]);
        const old=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,rawExecutionKey]);
        if(old.rows[0]){
          const same=sameRun(old.rows[0]);
          await recordOperation(client,{owner:user,projectId:old.rows[0].project_id,runId:old.rows[0].id,
            requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',
            errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,
            inputHash:same?b.input_hash:undefined});
          return same?{run:visibleRunDto(old.rows[0])}:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409};
        }
        return rejectBrowserTestKey(client);
      });
      if('run' in response)return reply.code(202).send(response.run);
      throw new Problem(response.httpStatus,response.errorCode,'Execution request was rejected');
    }
    const logical=(errorCode:string,httpStatus:number,stage:string)=>({channel:expectedChannel,testGrantId:b.test_grant_id,owner:user,projectId:b.project_id,requestId:request.id,traceId,kind:'execute' as const,jobType:b.task_kind as 'update'|'review'|'generation'|'qa',status:'rejected' as const,errorCode,inputRevision:wideRevision?undefined:b.input_revision,inputHash:wideRevision?undefined:b.input_hash,stage,executionRequestId:logicalExecutionKey,requestHash,httpStatus,revisionRejected:wideRevision&&stage==='revision_out_of_range'});
    const recordExecuteRejection=async(client:PoolClient,errorCode:string,httpStatus:number,stage:string)=>{
      const logged=await recordLogicalJob(client,logical(errorCode,httpStatus,stage));
      return {errorCode:logged.errorCode!,httpStatus:logged.httpStatus!,replay:logged.replay};
    };
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
        const old=await existingRun(client);
        if(old){
          const same=sameRun(old);
          await recordOperation(client,{owner:user,projectId:old.project_id,runId:old.id,requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,inputHash:same?b.input_hash:undefined});
          return same?{run:visibleRunDto(old)}:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409};
        }
        const prior=await client.query("SELECT id,project_id,request_hash,error_code,rejection_http_status,stage,subtype FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2 AND subtype IN ('execute_rejected','execute_schema_rejected')",[user,logicalKeyHash]);
        if(prior.rows[0])return priorRejection(client,prior.rows[0]);
        const owned=await client.query('SELECT kind FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',[user,b.project_id]);
        if(!owned.rowCount){await recordOperation(client,{owner:user,projectId:null,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:'CAPABILITY_NOT_READY'});return {errorCode:'CAPABILITY_NOT_READY',httpStatus:501};}
        if(wideRevision)return recordExecuteRejection(client,'VALIDATION_FAILED',422,'revision_out_of_range');
        const locked=await client.query('SELECT manifest->>\'kind\' AS kind FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4',[user,b.project_id,b.input_revision,b.input_hash]);
        if(locked.rows[0]&&locked.rows[0].kind!==owned.rows[0].kind)return recordExecuteRejection(client,'INPUT_REVISION_CONFLICT',409,'project_kind_changed');
        return recordExecuteRejection(client,'CAPABILITY_NOT_READY',501,'capability_not_ready');
      });
      if('run' in response)return reply.code(202).send(response.run);
      throw new Problem(response.httpStatus,response.errorCode,'Execution request was rejected');
    }
    if(b.user_prompt)await project(db(),user,b.project_id);
    const prepared=b.user_prompt ? await (await prepareUserSubmission(db(),blob(),b.user_prompt)).write(user,b.project_id) : undefined;
    let result;
    try {result=await transaction(db(),async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${executionKeyHash(b.execution_request_id)}`]);
      const old=await existingRun(client);
      if(old){
        const same=sameRun(old);
        await recordOperation(client,{owner:user,projectId:old.project_id,runId:old.id,requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,inputHash:same?b.input_hash:undefined});
        return same?visibleRunDto(old):{rejection:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409}};
      }
      const prior=await client.query("SELECT id,project_id,request_hash,error_code,rejection_http_status,stage,subtype FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2 AND subtype IN ('execute_rejected','execute_schema_rejected')",[user,logicalKeyHash]);
      const rejected=prior.rows[0];
      // A policy change may admit the exact input previously rejected by the
      // retired business gates. Keep that logical rejection immutable; a new run
      // takes precedence on every subsequent replay. Schema/key conflicts remain terminal.
      const retiredBusinessRejection=rejected?.subtype==='execute_rejected' &&
        rejected.stage==='submission_rejected' && rejected.request_hash.trim()===requestHash &&
        !b.test_grant_id && workingDraftConfigured() &&
        ['TEST_GRANT_EXPIRED','TEST_GRANT_INVALID','INPUT_REQUIRED','CAPABILITY_NOT_READY','MATERIAL_UNREADABLE'].includes(rejected.error_code);
      if(rejected&&!retiredBusinessRejection)return {rejection:await priorRejection(client,rejected)};
      const currentProject=await project(client,user,b.project_id,true);
      if(currentProject.kind==='review')throw new Problem(422,'VALIDATION_FAILED','Use the review execution endpoint to confirm the report, scope and input version');
      if(wideRevision)throw new Problem(422,'VALIDATION_FAILED','Input revision exceeds storage range');
      const input=await client.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,b.project_id,b.input_revision]);
      if(!input.rows[0])throw missing();
      if(input.rows[0].input_hash.trim()!==b.input_hash)throw conflict('INPUT_REVISION_CONFLICT','Input hash changed');
      if(paidReview&&currentProject.kind==='review')throw new Problem(409,'QUOTE_REQUIRED','请从复核项目确认本次报价后执行。');
      const lockedKind=input.rows[0].manifest?.kind;
      if(lockedKind!==currentProject.kind)
        throw conflict('INPUT_REVISION_CONFLICT','Input was locked for a different project kind');
      if((lockedKind==='generation'||b.task_kind==='generation')&&lockedKind!==b.task_kind)
        throw conflict('INPUT_REVISION_CONFLICT','Task kind does not match the locked input');
      await assertLockedInputIntegrity(client,{userId:user,projectId:b.project_id,inputRevision:b.input_revision,inputHash:b.input_hash},input.rows[0]);
      // Exact replays return above. New runs using older incomplete snapshots must
      // return to materials; running tasks keep their already locked inputs.
      if (['update','generation'].includes(lockedKind) && isUnifiedInput(input.rows[0].manifest))
        assertAuthoringSourceInformation(input.rows[0].manifest.materials, input.rows[0].manifest.authoring.source_prospectuses);
      if(b.test_grant_id)await assertTestGrant(client,{grantId:b.test_grant_id,userId:user,projectId:b.project_id,inputRevision:b.input_revision,inputHash:b.input_hash});
      const testGrantId=b.test_grant_id ?? await autoWorkingDraftGrant(client,
        {userId:user,projectId:b.project_id,inputRevision:b.input_revision,inputHash:b.input_hash},input.rows[0]);
      if(autoBrowserTestKey&&!testGrantId)throw new Problem(409,'TEST_GRANT_INVALID','Automatic test grant was not issued');
      if(paidAuthoring && !testGrantId && b.task_kind!==lockedKind) throw new Problem(409,'INPUT_REVISION_CONFLICT','Task kind cannot bypass the project billing mode');
      await admitRunSubmit(client,trial,user,sourceHash(request.ip));
      const runId=uid(),trace=uid(),eventId=uid();
      const q=await client.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,event_cursor,channel,test_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11) RETURNING *",[runId,user,b.project_id,b.input_revision,b.input_hash,storedExecutionKey,b.task_kind,requestHash,queueEnabled?'queued':'paused',testGrantId?'non_production_test':'production',testGrantId]);
      if(paidAuthoring && !testGrantId && ['update','generation'].includes(lockedKind)) {
        if(!classifyFixedPrice(input.rows[0].manifest).task)
          throw new Problem(422,'INPUT_REQUIRED','请补齐项目信息和已上传的原稿信息，保存当前输入后重新获取报价。');
        await reserveCredits(client,user,q.rows[0],b.quote_id,input.rows[0],currentProject);
      }
      if(prepared)await prepared.register(client,{kind:'run_execute',runId,inputRevision:b.input_revision,inputHash:b.input_hash,materialVersions:input.rows[0].material_versions});
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
          const priorRun=await existingRun(client);
          if(priorRun){
            const same=sameRun(priorRun);
            await recordOperation(client,{owner:user,projectId:priorRun.project_id,runId:priorRun.id,requestId:request.id,traceId,kind:'execute',status:same?'submitted':'rejected',errorCode:same?undefined:'IDEMPOTENCY_CONFLICT',inputRevision:same?b.input_revision:undefined,inputHash:same?b.input_hash:undefined});
            return same?{run:visibleRunDto(priorRun)}:{errorCode:'IDEMPOTENCY_CONFLICT',httpStatus:409,replay:true};
          }
          const owned=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,b.project_id]);
          if(owned.rowCount && ['CREDITS_INSUFFICIENT','QUOTE_REQUIRED','QUOTE_CHANGED','BILLING_NOT_READY'].includes(error.code)){
            await recordOperation(client,{owner:user,projectId:b.project_id,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:error.code});
            return {errorCode:error.code,httpStatus:error.status,replay:false};
          }
          if(owned.rowCount){
            return recordExecuteRejection(client,error.code,error.status,wideRevision?'revision_out_of_range':'submission_rejected');
          }
          await recordOperation(client,{owner:user,projectId:null,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:error.code});
          return {errorCode:error.code,httpStatus:error.status,replay:false};
        });
        if('run' in disposition)return reply.code(202).send(disposition.run);
        if(!disposition.replay)await reportTrialRejection(db(),error,user);
        throw new Problem(disposition.httpStatus,disposition.errorCode,!disposition.replay&&disposition.errorCode===error.code?error.message:'Execution request was rejected');
      }
      throw error;
    } finally { await prepared?.discard().catch(() => undefined); /* durable intent remains for the orphan sweep */ }
    if('rejection' in result)throw new Problem(result.rejection.httpStatus,result.rejection.errorCode,'Execution request was rejected');
    return reply.code(202).send(result);
  });
  app.get('/api/v1/runs/:run_id',async request=>visibleRunDto(await run(db(),await owner(request),param(request,'run_id'))));
  app.get('/api/v1/runs/:run_id/events',async request=>{
    const user=await owner(request),id=param(request,'run_id');assertTestChannelReadable((await run(db(),user,id)).channel);
    const after=Number((request.query as {after?:string}).after??0);if(!Number.isSafeInteger(after)||after<0)throw new Problem(422,'VALIDATION_FAILED','Invalid cursor');
    const q=await db().query('SELECT * FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 AND seq>$3 ORDER BY seq LIMIT 100',[user,id,after]);
    const items=q.rows.map(e=>({event_id:e.id,schema_version:1,trace_id:e.trace_id,run_id:e.run_id,seq:e.seq,occurred_at:date(e.occurred_at),stage:e.stage,type:e.type,state:e.state,payload:runEventPayloadDto(e.payload)}));
    return {items,next_cursor:items.length?items.at(-1)!.seq:after};
  });
  for(const kind of ['cancel','resume'] as const) app.post(`/api/v1/runs/:run_id/${kind}`,{schema:{body:schemas.RunActionRequest}},async request=>{
    const user=await owner(request),id=param(request,'run_id');assertTestChannelReadable((await run(db(),user,id)).channel);
    if(!queueEnabled)throw unavailable();
    return queueAction(db(),user,id,kind,request.id);
  });
  app.get('/api/v1/artifacts/:artifact_id',async request=>{
    const user=await owner(request),id=param(request,'artifact_id');
    const q=await db().query(`SELECT a.*,r.project_id,e.byte_size AS delivery_evidence_byte_size FROM bb_artifact_versions a
      JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
      LEFT JOIN bb_non_production_test_grants tg ON tg.grant_id=r.test_grant_id AND tg.user_id=a.owner_user_id
      LEFT JOIN bb_word_delivery_evidence e ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.id=$2 AND a.quality_status='passed' AND
        ((r.channel='production' AND r.state='succeeded' AND a.delivery_status='available') OR
         (r.channel='non_production_test' AND $3::boolean AND r.state='test_completed' AND a.delivery_status='test_only'
          AND tg.user_id=$1 AND tg.revoked_at IS NULL AND tg.expires_at>now())) ORDER BY a.version DESC LIMIT 1`,[user,id,testChannelEnabled()]);
    if(!q.rows[0])throw missing();const a=q.rows[0];await verifiedArtifactBytes(a);
    const pairRow=await db().query("SELECT checkpoint->'stages'->'word_delivery_pair' AS pair FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2",[user,a.run_id]);
    const pair=pairRow.rows[0]?.pair as Record<string,unknown>|undefined;
    if (pair?.revision_handling && (!Value.Check(ReviewRevisionHandlingSchema,pair.revision_handling) || pair.review_passed !== false)) throw new Problem(503,'DATA_UNAVAILABLE','Revision handling snapshot is invalid');
    const variant=pair?.revision_artifact_id===a.id?'revision':pair?.clean_artifact_id===a.id?'clean':pair?.baseline_artifact_id===a.id?'baseline':null;
    const wordDelivery=variant ? {variant,revision_artifact_id:pair!.revision_artifact_id,clean_artifact_id:pair!.clean_artifact_id,
      baseline_artifact_id:pair!.baseline_artifact_id,writer_version:pair!.writer_version,
      source_sha256:pair!.source_sha256,baseline_hash:pair!.baseline_hash,
      effective_baseline_sha256:pair!.effective_baseline_sha256,plan_hash:pair!.plan_hash,
      replacements:pair!.replacements,columns:pair!.columns,pending_review_count:pair!.pending,
      pending_review:pair!.pending_review,
      ...(pair!.delivery_policy==='generated_pair_v1' ? {delivery_policy:'generated_pair_v1',content_review:'not_performed'} : {}),
      ...(pair!.revision_handling ? {revision_handling:pair!.revision_handling,review_passed:false} : {}),
      ...(pair!.baseline_kind ? {baseline_kind:pair!.baseline_kind, source_issuer:pair!.source_issuer ?? null, authoring_summary:pair!.authoring_summary ?? []} : {})} : undefined;
    const grant=uid(),expires=new Date(Date.now()+5*60_000);
    await transaction(db(),async client=>{
      await client.query('INSERT INTO bb_artifact_download_grants(token_hash,owner_user_id,artifact_id,artifact_version,expires_at) VALUES($1,$2,$3,$4,$5)',[digest(grant),user,id,a.version,expires]);
      await recordOperation(client,{owner:user,projectId:a.project_id,runId:a.run_id,requestId:request.id,traceId:a.run_id,kind:'artifact_download_grant',status:'submitted'});
    });
    return {artifact_id:a.id,run_id:a.run_id,version:a.version,media_type:a.media_type,sha256:a.sha256.trim(),quality_status:a.quality_status,delivery_status:a.delivery_status,download_url:`/api/v1/artifacts/${id}/download?grant=${grant}`,expires_at:expires.toISOString(),...(wordDelivery?{word_delivery:wordDelivery}:{})};
  });
  app.get('/api/v1/artifacts/:artifact_id/download',async (request,reply)=>{
    const user=await owner(request),id=param(request,'artifact_id');
    const q=await db().query(`SELECT a.*,r.project_id,e.byte_size AS delivery_evidence_byte_size FROM bb_artifact_versions a
      JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
      LEFT JOIN bb_non_production_test_grants tg ON tg.grant_id=r.test_grant_id AND tg.user_id=a.owner_user_id
      LEFT JOIN bb_word_delivery_evidence e ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.id=$2 AND a.quality_status='passed' AND
        ((r.channel='production' AND r.state='succeeded' AND a.delivery_status='available') OR
         (r.channel='non_production_test' AND $3::boolean AND r.state='test_completed' AND a.delivery_status='test_only'
          AND tg.user_id=$1 AND tg.revoked_at IS NULL AND tg.expires_at>now())) ORDER BY a.version DESC LIMIT 1`,[user,id,testChannelEnabled()]);
    if(!q.rows[0])throw missing();const a=q.rows[0],grant=(request.query as {grant?:string}).grant;
    if(!grant)throw missing();const g=await db().query('SELECT 1 FROM bb_artifact_download_grants WHERE token_hash=$1 AND owner_user_id=$2 AND artifact_id=$3 AND artifact_version=$4 AND expires_at>now()',[digest(grant),user,id,a.version]);if(!g.rows[0])throw missing();
    const bytes=await verifiedArtifactBytes(a);
    await transaction(db(),client=>recordOperation(client,{owner:user,projectId:(a.project_id as string),runId:a.run_id,requestId:request.id,traceId:a.run_id,kind:'artifact_download',status:'submitted'}));
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
    const user=await owner(request),id=param(request,'project_id'),b=body<{input_revision:number;input_hash:string;test_grant_id?:string}>(request),traceId=uid();
    try {
      return await transaction(db(),async client=>{
        const currentProject=await project(client,user,id,true);
        if(!isPgInputRevision(b.input_revision))throw new Problem(422,'VALIDATION_FAILED','Input revision exceeds storage range');
        const input=(await client.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,id,b.input_revision])).rows[0];
        if(!input)throw missing();
        if(input.input_hash.trim()!==b.input_hash)throw conflict('INPUT_REVISION_CONFLICT','Input hash changed');
        if(input.manifest?.kind!==currentProject.kind)
          throw conflict('INPUT_REVISION_CONFLICT','Input was locked for a different project kind');
        await assertLockedInputIntegrity(client,{userId:user,projectId:id,inputRevision:b.input_revision,inputHash:b.input_hash},input);
        if(b.test_grant_id)await assertTestGrant(client,{grantId:b.test_grant_id,userId:user,projectId:id,
          inputRevision:b.input_revision,inputHash:b.input_hash});
        const missingInputs:string[]=[],uncertainty:string[]=[];
        const manifest=input.manifest as Record<string,unknown>;
        if (isUnifiedInput(manifest)) {
          const status = queueEnabled || settings.enableRunStaging ? 'ready' as const : 'blocked' as const;
          await recordLogicalJob(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'preflight',jobType:'preflight',status:'submitted',inputRevision:b.input_revision,inputHash:b.input_hash,stage:status});
          return { project_id:id,input_revision:b.input_revision,input_hash:b.input_hash,status,
            missing_inputs:[],uncertainty:[],blocking_inputs:status==='blocked'?['execution_capability_not_ready']:[],advisory_inputs:[],billing_mode:paidAuthoring&&!b.test_grant_id?'fixed_credits' as const:'platform_trial' as const };
        }
        const testGrantId=b.test_grant_id ?? await autoWorkingDraftGrant(client,
          {userId:user,projectId:id,inputRevision:b.input_revision,inputHash:b.input_hash},input);
        const ruleCheck=await revalidateStoredProductionRulePin(client,{ownerUserId:user,projectId:id},input,settings.reviewedContextLoader);
        if(ruleCheck.status!=='valid')missingInputs.push(ruleCheck.status==='tampered'&&ruleCheck.reason==='input_manifest_hash_mismatch'
          ?ruleCheck.reason:`rule_pack:${ruleCheck.reason}`);
        if(manifest.kind==='generation'&&manifest.user_reference_pin){
          const pin=manifest.user_reference_pin as {status?:string};
          if(pin.status!=='accepted')missingInputs.push(`user_reference_needs_review:${pin.status??'invalid'}`);
        }
        if(Object.hasOwn(manifest,'credit_facility_supplements')){
          const rawPins=manifest.credit_facility_supplements;
          if(!Array.isArray(rawPins)||rawPins.length<1||rawPins.length>60){
            uncertainty.push('credit_facility_supplement_pin_invalid');
          }else{
            try{
              const references=rawPins.map(value=>{
                if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_CREDIT_FACILITY_SUPPLEMENT_PIN');
                const pin=value as Record<string,unknown>;
                if(typeof pin.supplement_id!=='string'||!Number.isSafeInteger(pin.version)||typeof pin.request_hash!=='string')throw new Error('INVALID_CREDIT_FACILITY_SUPPLEMENT_PIN');
                return {supplement_id:pin.supplement_id,version:Number(pin.version),request_hash:pin.request_hash};
              });
              const verifiedPins=await lockCreditFacilitySupplementPins(client,{ownerUserId:user,projectId:id},references);
              const originalById=new Map(rawPins.map(value=>[(value as Record<string,unknown>).supplement_id,value as Record<string,unknown>]));
              for(const pin of verifiedPins){
                const original=originalById.get(pin.supplement_id);
                if(!original||original.version!==pin.version||original.request_hash!==pin.request_hash||original.status!==pin.status||original.eligible_for_manuscript!==false){
                  uncertainty.push('credit_facility_supplement_pin_stale');
                  break;
                }
                uncertainty.push(`credit_facility_supplement_${pin.status}:${pin.supplement_id}:${pin.version}`);
              }
            }catch{
              // User-entered assertions remain locally uncertain; a stale or malformed pin never promotes them.
              uncertainty.push('credit_facility_supplement_pin_stale');
            }
          }
        }
        let updateDifficulty: StoredUpdateDifficultySnapshot | undefined;
        if(manifest.kind==='update'){
          if(!manifest.market||!manifest.offering)missingInputs.push('target_market_offering_required');
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
        // The trusted binding comes from the immutable input pin, not an optional server callback.
        if(manifest.kind==='generation'){
          try {await assertGenerationIssuerBinding(client,
            {userId:user,projectId:id,inputRevision:b.input_revision,inputHash:b.input_hash},input);}
          catch(error){
            if(!(error instanceof Problem))throw error;
            missingInputs.push(error.message.startsWith('Selected user reference')
              ? 'user_reference_needs_review:stale'
              : 'issuer_identity_not_bound:generation_issuer_binding_missing_or_unapproved');
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
            },{blobs:blobs??undefined});
            if(updateDifficulty.estimate.status==='needs_confirmation')
              uncertainty.push('update_difficulty_needs_confirmation');
          } catch(error) {
            const classified=classifyUpdateDifficultyFailure(error);
            if(classified.category==='pending_input') missingInputs.push(`update_difficulty_pending:${classified.code.toLowerCase()}`);
            else if(classified.category==='stale_input') missingInputs.push(`update_difficulty_stale:${classified.code.toLowerCase()}`);
            else if(classified.category==='not_found') missingInputs.push('update_difficulty_evidence_missing');
            else if(classified.category==='invalid_request') missingInputs.push(`update_difficulty_invalid:${classified.code.toLowerCase()}`);
            else throw new Problem(503,'DATA_UNAVAILABLE','Update difficulty snapshot could not be verified');
          }
        }
        // Execution stays 501 until #16/#79/Word delivery are live, so preflight cannot report an executable input.
        if(!settings.enableRunStaging&&!queueEnabled)missingInputs.push('execution_capability_not_ready');
        const testCandidate=isTestIssuerCandidate(manifest.test_issuer_candidate)?manifest.test_issuer_candidate:null;
        const candidateCurrent=testCandidate&&await testIssuerCandidateMatches(client,{ownerUserId:user,projectId:id},testCandidate);
        if(testCandidate&&!candidateCurrent)missingInputs.push('issuer_identity_candidate_stale');
        const hasIssuerEvidence=manifest.kind!=='update'||isVerifiedIssuerIdentityBinding(manifest.issuer_identity)||Boolean(candidateCurrent);
        const {status,blockingInputs,advisoryInputs}=classifyPreflightReadiness(missingInputs,uncertainty,
          !!testGrantId&&hasIssuerEvidence);
        await recordLogicalJob(client,{owner:user,projectId:id,requestId:request.id,traceId,kind:'preflight',jobType:'preflight',
          status:'submitted',inputRevision:b.input_revision,inputHash:b.input_hash,stage:status,
          channel:testGrantId?'non_production_test':'production',testGrantId:testGrantId??undefined});
        return {project_id:id,input_revision:b.input_revision,input_hash:b.input_hash,status,missing_inputs:missingInputs,uncertainty,
          blocking_inputs:blockingInputs,advisory_inputs:advisoryInputs,billing_mode:'platform_trial' as const,
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
  app.post('/api/v1/internal/projects/:project_id/submissions',{schema:{body:schemas.UserSubmissionRequest,response:{201:schemas.UserSubmissionResponse}}},async(request,reply)=>{
    const user=await owner(request);
    if(!settings.enableUserSubmissionSeam)throw unavailable();
    const projectId=param(request,'project_id');
    await project(db(),user,projectId);
    const b=body<{message_id:string;submission_request_id:string;body:string;run_id?:string;input_revision?:number;input_hash?:string;material_versions:{material_id:string;material_version:number}[]}>(request);
    if((b.input_revision===undefined)!==(b.input_hash===undefined))throw new Problem(422,'VALIDATION_FAILED','Input revision and hash must be supplied together');
    const prepared=await(await prepareUserSubmission(db(),blob(),b.body)).write(user,projectId);
    try {
      const result=await transaction(db(),async client=>{
        await project(client,user,projectId);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${projectId}:message:${b.submission_request_id}`]);
        const old=(await client.query('SELECT * FROM bb_user_submission_versions WHERE owner_user_id=$1 AND project_id=$2 AND submission_request_id=$3 FOR UPDATE',[user,projectId,b.submission_request_id])).rows[0];
        if(old){
          if(old.message_id!==b.message_id||old.content_sha256.trim()!==digest(scrubSecrets(b.body))||old.run_id!==(b.run_id??null)||old.input_revision!==(b.input_revision??null)||old.input_hash?.trim()!==(b.input_hash??undefined)||canonical(old.material_versions)!==canonical(b.material_versions))throw conflict('IDEMPOTENCY_CONFLICT','Submission request ID is bound to another submission');
          return {submission_id:old.id,snapshot_id:old.snapshot_id,version:old.version,message_version:old.message_version,content_sha256:old.content_sha256.trim(),created_at:date(old.created_at)};
        }
        if(b.run_id){const linked=await run(client,user,b.run_id);if(linked.project_id!==projectId)throw missing();}
        await verifiedMaterialVersions(client,user,projectId,b.material_versions);
        const saved=await prepared.register(client,{kind:'project_message',messageId:b.message_id,submissionRequestId:b.submission_request_id,runId:b.run_id,inputRevision:b.input_revision,inputHash:b.input_hash,materialVersions:b.material_versions});
        return {submission_id:saved.submissionId,snapshot_id:saved.snapshotId,version:saved.version,message_version:saved.messageVersion,content_sha256:saved.contentSha256,created_at:date(saved.createdAt)};
      });
      return reply.code(201).send(result);
    } finally {await prepared.discard().catch(() => undefined); /* durable intent remains for the orphan sweep */}
  });
  app.post('/api/v1/projects/:project_id/messages',{
    schema:{body:schemas.ProjectMessageSaveRequest,response:{201:schemas.ProjectMessageSaveResponse}},
  },async(request,reply)=>{
    const user=await owner(request),projectId=param(request,'project_id');
    const saved=await saveProjectMessage(db(),blob(),user,projectId,body<SaveProjectMessage>(request));
    return reply.code(201).header('cache-control','no-store').send(saved);
  });
  app.get('/api/v1/projects/:project_id/messages',{
    schema:{response:{200:schemas.ProjectMessagePage}},
  },async(request,reply)=>{
    const user=await owner(request),projectId=param(request,'project_id');
    const query=request.query as {cursor?:string;limit?:string};
    const page=await readProjectMessages(db(),blob(),user,projectId,query);
    return reply.header('cache-control','no-store').send(page);
  });
  app.get('/api/v1/projects/:project_id/messages/:message_id/versions/:version',{
    schema:{response:{200:schemas.ProjectMessage}},
  },async(request,reply)=>{
    const user=await owner(request);
    const result=await readProjectMessageVersion(db(),blob(),user,param(request,'project_id'),
      param(request,'message_id'),param(request,'version'));
    return reply.header('cache-control','no-store').send(result);
  });
  app.post('/api/v1/conversations/:conversation_id/messages',async request=>{await owner(request);throw unavailable();});
  return app;
}

/** Production entry point installs the existing fail-closed loader; tests may still use createServer() without one. */
export function createProductionServer(settings: Omit<Settings, 'reviewedContextLoader'> = {}) {
  return createServer({ ...settings, reviewedContextLoader: loadReviewedRuleApplicabilityContext });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app=createProductionServer(),port=Number(process.env.PORT??'3000');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  // Spool files left by a killed process are never resumed; clear them before accepting uploads.
  await clearSpoolDirectory();
  app.listen({host:process.env.HOST??'127.0.0.1',port}).catch(error=>{app.log.error(error);process.exitCode=1;});
}
