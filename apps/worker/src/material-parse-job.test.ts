import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { claimMaterialParse, DEFAULT_DOCUMENT_PARSER_VERSION, recordMaterialParseProcessingCost, requeueAwaitingOcrParseJobs, succeedMaterialParse } from '@bondbuddy/api/material-jobs';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { classifyMaterialParseError, runMaterialParseOnce, type MaterialParseJobDependencies } from './material-parse-job.js';
import { OcrProcessingError } from './ocr.js';
import { isolatedTestDatabase } from './test-database.js';
import { createIssuerIdentityProducer } from './issuer-identity-producer.js';
import { authorizeIssuerIdentityReviewer, reviewIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';

const testDatabaseUrl = await isolatedTestDatabase();

// All data, parser output and identities here are synthetic. No real material or provider is used.
const connection = testDatabaseUrl;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ORIGIN = 'http://bondbuddy.test';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// 1x1 synthetic PNG; images have no native parser and must wait for OCR.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function syntheticParse(request: DocumentParseRequest): DocumentParseResponse {
  const material = request.material;
  const snippets = request.material.media_type === DOCX ? [
    ['venue-cover', '本期债券发行场所：上海证券交易所。', '募集说明书封面'],
    ['venue-overview', '本期债券在上海证券交易所发行。', '本次发行概况'],
    ['offering-cover', '本期债券采取非公开发行方式。', '募集说明书封面'],
    ['offering-overview', '本期公司债券采用私募发行。', '本次发行概况'],
    ['financial-period', '合并财务报表报告期：2022年度、2023年度、2024年度。', '财务会计信息'],
  ] : [['line-1', 'Synthetic audit text', 'synthetic']];
  return {
    schema_version: 'document-parse-response-v1', request_id: request.request_id, parser_version: DEFAULT_DOCUMENT_PARSER_VERSION, status: 'parsed',
    material: { material_id: material.material_id, material_version: material.material_version, media_type: material.media_type, sha256: material.sha256 },
    records: snippets.map(([id, quote, context], index) => ({
      record_id: id!, material_id: material.material_id, material_version: material.material_version, content_hash: material.sha256,
      locator_type: request.material.media_type === DOCX ? 'docx_block' as const : 'text_line' as const,
      locator: request.material.media_type === DOCX ? { path: [{ paragraph: index + 1 }], stable_ref: `docx:p${String(index + 1).padStart(4, '0')}` } : { line: index + 1, stable_ref: `text:l${String(index + 1).padStart(6, '0')}` },
      literal_quote: quote!, context: context!, extraction_method: 'native_text' as const, extractor_version: DEFAULT_DOCUMENT_PARSER_VERSION,
      confidence: 1, uncertainty: [], formatting: {},
    })),
    warnings: [], document: request.material.media_type === DOCX ? { page_count: null, revision_summary: { insertions: 0, deletions: 0 }, auxiliary_targets: [] } : { page_count: null, encoding: 'utf-8' }, error: null,
  };
}

test('synthetic parser version matches the deployed Python parser identity', () => {
  const python = readFileSync(new URL('../../../python/bondbuddy_document_parser/parser.py', import.meta.url), 'utf8');
  assert.match(python, new RegExp(`PARSER_VERSION = "${DEFAULT_DOCUMENT_PARSER_VERSION.replaceAll('.', '\\.')}"`));
});

test('#17 capacity failures are terminal MATERIAL_TOO_LARGE; infrastructure failures stay retryable', () => {
  for (const code of ['MATERIAL_PARSE_SIZE_LIMIT', 'MATERIAL_PARSE_OUTPUT_LIMIT', 'MATERIAL_PARSE_MEMORY_LIMIT']) {
    assert.deepEqual(classifyMaterialParseError(new Error(code)), { code: 'MATERIAL_TOO_LARGE', retryable: false, category: 'material_parse' });
  }
  assert.deepEqual(classifyMaterialParseError(new Error('MATERIAL_BYTES_UNAVAILABLE')), { code: 'DATA_UNAVAILABLE', retryable: true, category: 'material_parse' });
  assert.deepEqual(classifyMaterialParseError(new Error('MATERIAL_PARSE_TIMEOUT')), { code: 'MATERIAL_PARSE_TIMEOUT', retryable: true, category: 'material_parse' });
});

test('PostgreSQL/Azurite durable material parse hook: enqueue, resume, retry, cancel race, owner 404 and #79 rows', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const containerName = `bb-parse-job-${randomUUID()}`;
  const blobs = azureBlobs(blobConnection!, containerName);
  let owner = `parse-owner-${randomUUID()}`;
  const alice = owner, bob = `parse-other-${randomUUID()}`;
  const app = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: owner, csrfVerified: true }) });
  const stagingApp = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: owner, csrfVerified: true }), enableRunStaging: true });
  const send = (method: string, url: string, payload?: unknown, contentType?: string, target = app) => target.inject({ method: method as any, url,
    headers: { origin: ORIGIN, ...(contentType ? { 'content-type': contentType } : {}) }, payload: payload as any });
  let parserCalls = 0;
  let parser: (request: DocumentParseRequest) => Promise<DocumentParseResponse> = async request => { parserCalls++; return syntheticParse(request); };
  const deps = (extra: Partial<MaterialParseJobDependencies> = {}): MaterialParseJobDependencies => ({
    pool, leaseSeconds: 30, ...extra,
    material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) }, parser: request => parser(request) },
  });
  const jobFor = async (materialId: string) => (await pool.query("SELECT * FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [materialId])).rows;
  const outboxTypes = async (jobId: string) => (await pool.query("SELECT event_type FROM bb_outbox WHERE aggregate_type='material_parse_job' AND aggregate_id=$1 AND event_type<>'platform.processing_cost' ORDER BY created_at,id", [jobId])).rows.map(r => r.event_type as string);
  const processingCosts = async (jobId: string) => (await pool.query("SELECT payload FROM bb_outbox WHERE aggregate_type='material_parse_job' AND aggregate_id=$1 AND event_type='platform.processing_cost' ORDER BY created_at,id", [jobId])).rows.map(r => r.payload as Record<string, unknown>);
  const internal = async (jobId: string) => (await pool.query("SELECT kind,event FROM bb_observability_events WHERE job_id=$1 ORDER BY created_at,id", [jobId])).rows;
  const errors = async (jobId: string) => (await pool.query('SELECT code,category,recovery_status,retry_count FROM bb_observability_errors WHERE job_id=$1 ORDER BY created_at,id', [jobId])).rows;
  const operations = async (kind: string, status: string) => (await pool.query('SELECT * FROM bb_operations WHERE owner_user_id=$1 AND operation_kind=$2 AND status=$3', [owner, kind, status])).rows;

  async function startUpload(projectId: string, bytes: Buffer, mediaType: string, role: string, filename: string) {
    const start = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename, media_type: mediaType, byte_size: bytes.length, sha256: sha(bytes), role });
    assert.equal(start.statusCode, 201, start.body);
    const put = await send('PUT', start.json().upload_url, bytes, 'application/octet-stream');
    assert.equal(put.statusCode, 204, put.body);
    return start.json().upload_id as string;
  }
  const complete = (projectId: string, uploadId: string, bytes: Buffer) =>
    send('POST', `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/complete`, { byte_size: bytes.length, sha256: sha(bytes) });

  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',
      [alice, `o${randomUUID().replaceAll('-', '').slice(0, 30)}`]);
    // Claims are global; retire parse jobs left by an earlier interrupted run of this suite on a reused database.
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE job_type='parse' AND state NOT IN ('succeeded','failed','cancelled')");
    const project = await send('POST', '/api/v1/projects', { name: 'Synthetic parse hook', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().project_id as string;

    // 1. Duplicate completion (concurrent replays and a renamed duplicate upload) yields exactly one job.
    const docx = makeWorkerDocxFixture({ externalLink: false });
    const historicalUpload = await startUpload(projectId, docx, DOCX, 'historical', 'history.docx');
    const completions = await Promise.all(Array.from({ length: 5 }, () => complete(projectId, historicalUpload, docx)));
    assert.ok(completions.every(r => r.statusCode === 200), completions.map(r => r.body).join('\n'));
    const historicalId = completions[0].json().material_id as string;
    const duplicateUpload = await startUpload(projectId, docx, DOCX, 'historical', 'history-renamed.docx');
    assert.equal((await complete(projectId, duplicateUpload, docx)).json().material_id, historicalId);
    let [historicalJob] = await jobFor(historicalId);
    assert.equal((await jobFor(historicalId)).length, 1);
    assert.equal(historicalJob.state, 'queued');
    assert.equal(historicalJob.material_sha256.trim(), sha(docx));
    assert.equal(historicalJob.parser_version, DEFAULT_DOCUMENT_PARSER_VERSION);
    assert.deepEqual(await outboxTypes(historicalJob.id), ['material_parse.enqueued']);
    assert.equal((await operations('material_complete', 'submitted')).length, 6);
    // Binding is immutable in the database, not just in application code.
    await assert.rejects(pool.query("UPDATE bb_jobs SET material_sha256=$2 WHERE id=$1", [historicalJob.id, 'f'.repeat(64)]), /immutable/);

    // Pending work is explicit: no synthesized source profile before the durable job runs.
    const pendingProfile = await send('GET', `/api/v1/projects/${projectId}/materials/${historicalId}/source-profile`);
    assert.equal(pendingProfile.statusCode, 409); assert.equal(pendingProfile.json().code, 'CAPABILITY_NOT_READY');
    const lockedInput = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: 1, material_versions: [{ material_id: historicalId, material_version: 1 }], requirement_message_ids: [] });
    assert.equal(lockedInput.statusCode, 201, lockedInput.body);
    const preflightBody = { input_revision: 1, input_hash: lockedInput.json().input_hash };
    const pendingPreflight = await send('POST', `/api/v1/projects/${projectId}/preflight`, preflightBody);
    assert.equal(pendingPreflight.statusCode, 200, pendingPreflight.body);
    assert.equal(pendingPreflight.json().status, 'blocked');
    const issuerBlock = (pendingPreflight.json().missing_inputs as string[]).find(input => input.startsWith('issuer_identity_not_bound:'));
    assert.ok(issuerBlock, 'parsing a historical material does not supply a reviewed issuer identity');
    assert.deepEqual(pendingPreflight.json().missing_inputs, ['rule_pack:issuer_identity_not_bound', issuerBlock,
      `material_parse_pending:${historicalId}:1`, 'update_difficulty_pending:financial_materials_required', 'execution_capability_not_ready']);

    // 2. Crash after the parse_evidence checkpoint, lease expiry, then resume without re-parsing.
    await assert.rejects(runMaterialParseOnce(deps({ afterStage: async stage => { if (stage === 'parse_evidence') throw new Error('SYNTHETIC_CRASH'); } })), /SYNTHETIC_CRASH/);
    assert.equal(parserCalls, 1);
    [historicalJob] = await jobFor(historicalId);
    assert.equal(historicalJob.state, 'running'); assert.equal(historicalJob.stage, 'parse_evidence');
    assert.ok(historicalJob.checkpoint.stages.parse_evidence.snapshot_id);
    assert.equal(await runMaterialParseOnce(deps()), 'idle', 'an unexpired lease is not stolen');
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [historicalJob.id]);
    assert.equal(await runMaterialParseOnce(deps()), 'succeeded');
    assert.equal(parserCalls, 1, 'completed parse stage is read from the checkpoint');
    [historicalJob] = await jobFor(historicalId);
    assert.equal(historicalJob.state, 'succeeded'); assert.equal(historicalJob.attempts, 2);
    const parseCost = await processingCosts(historicalJob.id);
    assert.equal(parseCost.length, 1, 'checkpointed parses are not recorded twice after lease recovery');
    assert.deepEqual([parseCost[0]!.stage, parseCost[0]!.attempt, parseCost[0]!.unit, parseCost[0]!.quantity, parseCost[0]!.outcome], ['parse', 1, 'document', 1, 'succeeded']);
    assert.equal(parseCost[0]!.billable, false); assert.equal(parseCost[0]!.cost_payer, 'platform');
    assert.equal(parseCost[0]!.pricing_status, 'unknown'); assert.equal(parseCost[0]!.unit_price_ref, null);
    assert.deepEqual(historicalJob.checkpoint.processing_costs['parse:1'], parseCost[0]);
    const jobView = await send('GET', `/api/v1/projects/${projectId}/materials/${historicalId}/parse-job`);
    assert.equal(jobView.statusCode, 200, jobView.body);
    assert.deepEqual(jobView.json().completed_stages, ['parse_evidence', 'historical_profile']);
    assert.equal(jobView.json().profile_version, 1);
    assert.deepEqual(jobView.json().pending_capabilities, []);
    const profile = await send('GET', `/api/v1/projects/${projectId}/materials/${historicalId}/source-profile`);
    assert.equal(profile.statusCode, 200, profile.body);
    assert.equal(profile.json().material_id, historicalId); assert.equal(profile.json().profile_version, 1);
    assert.equal(jobView.json().outcome, profile.json().state === 'ready' ? 'parsed' : 'needs_confirmation');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_parse_snapshots WHERE material_id=$1', [historicalId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_issuer_identity_source_records WHERE material_id=$1', [historicalId])).rows[0].n, 0,
      'the default parse path never invents an issuer observation');
    assert.deepEqual(await outboxTypes(historicalJob.id), ['material_parse.enqueued', 'material_parse.claimed', 'material_parse.stage_completed',
      'material_parse.claimed', 'material_parse.stage_completed', 'material_parse.succeeded']);
    const successLog = await internal(historicalJob.id);
    assert.ok(successLog.every(r => r.kind === 'job.state_changed' && r.event.job_kind === 'parse'));
    assert.equal(successLog.at(-1)!.event.status, 'succeeded');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox o JOIN bb_observability_events e ON o.aggregate_id=e.id WHERE o.aggregate_type='observability' AND e.job_id=$1", [historicalJob.id])).rows[0].n, successLog.length);
    const readyPreflight = await send('POST', `/api/v1/projects/${projectId}/preflight`, preflightBody, undefined, stagingApp);
    assert.equal(readyPreflight.statusCode, 200, readyPreflight.body);
    assert.deepEqual(readyPreflight.json().missing_inputs, ['rule_pack:issuer_identity_not_bound', issuerBlock,
      'update_difficulty_pending:financial_materials_required'],
      'parse completion clears material pending, but cannot verify issuer identity');
    assert.equal(readyPreflight.json().status, 'blocked');
    assert.equal((await operations('preflight', 'submitted')).length, 2);

    const producerProject = await send('POST','/api/v1/projects',{name:'Synthetic issuer producer',kind:'update',issuer_name:null,market:null,offering:null});
    assert.equal(producerProject.statusCode,201,producerProject.body);
    const producerProjectId=producerProject.json().project_id as string;
    const producerMaterialId=(await complete(producerProjectId,
      await startUpload(producerProjectId,docx,DOCX,'historical','history.docx'),docx)).json().material_id as string;
    let producerCalls=0;
    assert.equal(await runMaterialParseOnce(deps({issuerIdentityProducer:async context=>{
      producerCalls++;
      assert.equal(context.ownerUserId,alice);assert.equal(context.projectId,producerProjectId);
      assert.equal(context.materialId,producerMaterialId);assert.equal(context.materialVersion,1);
      assert.equal(context.materialSha256,sha(docx));
      assert.ok(context.snapshotId);assert.ok(context.evidence.some(item=>item.recordId==='venue-cover'));
      const candidate={sourceRecordId:'venue-cover',issuerDisplayName:'合成发行人甲',entityId:'synthetic-issuer-a'};
      return [candidate,candidate];
    }})),'succeeded');
    assert.equal(producerCalls,1);
    const records=await pool.query('SELECT id,state FROM bb_issuer_identity_source_records WHERE material_id=$1',[producerMaterialId]);
    assert.equal(records.rows.length,1,'duplicate producer output replays one immutable observation');
    assert.equal(records.rows[0].state,'needs_review');

    // Production selection and persistence through the real parse path; all names and bytes are synthetic.
    const identityProject = await send('POST', '/api/v1/projects', { name: 'Synthetic identity integration', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(identityProject.statusCode, 201, identityProject.body);
    const identityProjectId = identityProject.json().project_id as string;
    const identityMaterialId = (await complete(identityProjectId,
      await startUpload(identityProjectId, docx, DOCX, 'historical', 'identity.docx'), docx)).json().material_id as string;
    parser = async request => {
      const result = syntheticParse(request);
      return { ...result, records: result.records.map((record, index) => index === 0
        ? { ...record, literal_quote: '发行人名称：合成核验有限公司。' } : record) };
    };
    assert.equal(await runMaterialParseOnce(deps({ issuerIdentityProducer: createIssuerIdentityProducer(pool) })), 'succeeded');
    const identityUrl = `/api/v1/projects/${identityProjectId}/materials/${identityMaterialId}/versions/1/issuer-identity/observations`;
    const pending = await send('GET', identityUrl);
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().items.length, 1);
    assert.equal(pending.json().items[0].status, 'needs_review');
    const observationId = pending.json().items[0].source_record_id as string;
    assert.ok(observationId.startsWith('issuer-observation:v1:'));
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const reviewerId = `identity-reviewer-${suffix}`, grantorId = `identity-grantor-${suffix}`;
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)',
      [reviewerId, `reviewer${suffix}`, grantorId, `grantor${suffix}`]);
    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test','synthetic integration',$4,$5)`,
      [randomUUID(), reviewerId, grantorId, alice, identityProjectId]);
    const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId, { ownerUserId: alice, projectId: identityProjectId });
    assert.ok(reviewer);
    await reviewIssuerIdentitySourceRecord({ pool }, { ownerUserId: alice, projectId: identityProjectId,
      materialId: identityMaterialId, materialVersion: 1, sourceRecordRowId: observationId,
      reviewer, decision: 'verified', verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
      entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic parse identity', reasonCode: 'synthetic_identity_verified' });
    const locked = await send('POST', `/api/v1/projects/${identityProjectId}/input-revisions`,
      { draft_revision: 1, material_versions: [{ material_id: identityMaterialId, material_version: 1 }], requirement_message_ids: [] });
    assert.equal(locked.statusCode, 201, locked.body);
    const manifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [alice, identityProjectId, locked.json().input_revision])).rows[0].manifest;
    assert.equal(manifest.issuer_identity.status, 'verified');
    assert.equal(manifest.issuer_identity.record_id, observationId);
    assert.equal((await send('GET', identityUrl)).json().status, 'verified');

    // 3. Bounded retry then terminal failure with a structured error code.
    const text = Buffer.from('Synthetic audit text\n', 'utf8');
    const textId = (await complete(projectId, await startUpload(projectId, text, 'text/plain', 'audit', 'audit.txt'), text)).json().material_id as string;
    parser = async () => { parserCalls++; throw new Error('synthetic parser crash'); };
    assert.deepEqual([await runMaterialParseOnce(deps()), await runMaterialParseOnce(deps()), await runMaterialParseOnce(deps())], ['retry_scheduled', 'retry_scheduled', 'failed']);
    assert.equal(await runMaterialParseOnce(deps()), 'idle', 'failure is final');
    const [textJob] = await jobFor(textId);
    assert.equal(textJob.state, 'failed'); assert.equal(textJob.error_code, 'MATERIAL_UNREADABLE'); assert.equal(textJob.attempts, 3);
    assert.deepEqual((await processingCosts(textJob.id)).map(cost => [cost.stage, cost.attempt, cost.quantity, cost.outcome]),
      [['parse', 1, 1, 'failed'], ['parse', 2, 1, 'failed'], ['parse', 3, 1, 'failed']], 'failed consumed parser attempts remain separately measurable');
    assert.deepEqual((await errors(textJob.id)).map(e => [e.code, e.recovery_status, e.retry_count]),
      [['MATERIAL_UNREADABLE', 'retry_scheduled', 1], ['MATERIAL_UNREADABLE', 'retry_scheduled', 2], ['MATERIAL_UNREADABLE', 'terminal', 3]]);
    assert.deepEqual((await pool.query('SELECT outcome FROM bb_error_recovery_events WHERE job_id=$1 ORDER BY error_id', [textJob.id])).rows.map(r => r.outcome),
      ['retried_failed', 'retried_failed'], 'terminal failure resolves both earlier retry records');
    assert.deepEqual((await outboxTypes(textJob.id)).filter(t => t !== 'material_parse.claimed'), ['material_parse.enqueued', 'material_parse.retry_scheduled', 'material_parse.retry_scheduled', 'material_parse.failed']);
    const failureLog = await internal(textJob.id);
    assert.equal(failureLog.filter(r => r.kind === 'error.recorded').length, 3);
    assert.equal(failureLog.filter(r => r.kind === 'job.state_changed').at(-1)!.event.status, 'failed');
    const cancelFailed = await send('POST', `/api/v1/projects/${projectId}/materials/${textId}/parse-job/cancel`, { reason: 'synthetic' });
    assert.equal(cancelFailed.statusCode, 409); assert.equal(cancelFailed.json().code, 'ALREADY_TERMINAL');
    assert.equal((await operations('material_parse_cancel', 'rejected'))[0].error_code, 'ALREADY_TERMINAL');

    // A subprocess deadline leaves the material pending and records the timeout distinctly.
    const timeoutText = Buffer.from('Synthetic delayed text\n', 'utf8');
    const timeoutId = (await complete(projectId, await startUpload(projectId, timeoutText, 'text/plain', 'audit', 'delayed.txt'), timeoutText)).json().material_id as string;
    parser = async () => { throw new Error('DOCUMENT_PARSER_TIMEOUT'); };
    assert.equal(await runMaterialParseOnce(deps()), 'retry_scheduled');
    let [timeoutJob] = await jobFor(timeoutId);
    assert.equal(timeoutJob.state, 'queued'); assert.equal(timeoutJob.error_code, null); assert.equal(timeoutJob.attempts, 1);
    assert.deepEqual((await errors(timeoutJob.id)).map(e => [e.code, e.recovery_status]), [['MATERIAL_PARSE_TIMEOUT', 'retry_scheduled']]);
    parser = async request => syntheticParse(request);
    assert.equal(await runMaterialParseOnce(deps()), 'succeeded');
    [timeoutJob] = await jobFor(timeoutId);
    assert.equal(timeoutJob.state, 'succeeded'); assert.equal(timeoutJob.attempts, 2);
    assert.deepEqual((await pool.query('SELECT outcome FROM bb_error_recovery_events WHERE job_id=$1', [timeoutJob.id])).rows.map(r => r.outcome),
      ['recovered'], 'later parse success resolves the earlier timeout');

    const cancelledBytes = Buffer.from('Synthetic cancelled parse\n', 'utf8');
    const cancelledId = (await complete(projectId, await startUpload(projectId, cancelledBytes, 'text/plain', 'audit', 'cancelled.txt'), cancelledBytes)).json().material_id as string;
    parser = async () => { throw new Error('DOCUMENT_PARSER_TIMEOUT'); };
    assert.equal(await runMaterialParseOnce(deps()), 'retry_scheduled');
    const [cancelledJob] = await jobFor(cancelledId);
    assert.equal((await send('POST', `/api/v1/projects/${projectId}/materials/${cancelledId}/parse-job/cancel`, { reason: 'synthetic cancel' })).statusCode, 200);
    assert.deepEqual((await pool.query('SELECT outcome FROM bb_error_recovery_events WHERE job_id=$1', [cancelledJob.id])).rows.map(r => r.outcome),
      ['user_cancelled'], 'cancellation remains distinct from recovery and retry failure');

    // A crash on the final attempt is also bounded: the recovered lease fails instead of running again.
    parser = async request => { parserCalls++; return syntheticParse(request); };
    const text2 = Buffer.from('Synthetic audit text two\n', 'utf8');
    const text2Id = (await complete(projectId, await startUpload(projectId, text2, 'text/plain', 'audit', 'audit-2.txt'), text2)).json().material_id as string;
    for (let i = 0; i < 3; i++) {
      // Simulated worker process death right after claiming: the lease is never renewed or released.
      assert.equal((await claimMaterialParse(pool, 30))?.materialId, text2Id);
      await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE material_id=$1", [text2Id]);
    }
    assert.equal(await runMaterialParseOnce(deps()), 'idle');
    const [text2Job] = await jobFor(text2Id);
    assert.equal(text2Job.state, 'failed'); assert.equal(text2Job.error_code, 'DATA_UNAVAILABLE'); assert.equal(text2Job.attempts, 3);

    // 4. Cancel vs worker completion race: exactly one final state and one final event per job.
    const winners = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const bytes = Buffer.from(`Synthetic race text ${i}\n`, 'utf8');
      const materialId = (await complete(projectId, await startUpload(projectId, bytes, 'text/plain', 'other', `race-${i}.txt`), bytes)).json().material_id as string;
      const lease = await claimMaterialParse(pool, 30);
      assert.ok(lease); assert.equal(lease.materialId, materialId);
      const cancelCall = () => send('POST', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job/cancel`, { reason: 'synthetic race' });
      const completeCall = () => succeedMaterialParse(pool, lease, { outcome: 'parsed', parse_status: 'parsed', profile_version: null, pending_capabilities: [] });
      // Even rounds race concurrently; odd rounds let the cancel commit first so both winners are exercised.
      const [cancel, done] = i % 2 === 0 ? await Promise.allSettled([cancelCall(), completeCall()])
        : [await Promise.allSettled([cancelCall()]).then(([r]) => r), await Promise.allSettled([completeCall()]).then(([r]) => r)];
      if (done.status === 'rejected') assert.equal((done.reason as { code?: string }).code, 'ALREADY_TERMINAL');
      winners.add(done.status === 'fulfilled' ? 'succeeded' : 'cancelled');
      const [job] = await jobFor(materialId);
      const cancelled = cancel.status === 'fulfilled' && cancel.value.statusCode === 200;
      const succeeded = done.status === 'fulfilled';
      assert.notEqual(cancelled, succeeded, 'exactly one side wins');
      assert.equal(job.state, cancelled ? 'cancelled' : 'succeeded');
      if (!cancelled) assert.equal(cancel.status === 'fulfilled' && cancel.value.json().code, 'ALREADY_TERMINAL');
      const finals = (await outboxTypes(job.id)).filter(t => ['material_parse.succeeded', 'material_parse.cancelled', 'material_parse.failed'].includes(t));
      assert.deepEqual(finals, [cancelled ? 'material_parse.cancelled' : 'material_parse.succeeded']);
      await assert.rejects(pool.query("UPDATE bb_jobs SET state='queued' WHERE id=$1", [job.id]), /final state/);
    }
    assert.deepEqual([...winners].sort(), ['cancelled', 'succeeded']);

    // 5. OCR-dependent result stays explicitly pending, then records measured platform cost when OCR is enabled.
    const imageId = (await complete(projectId, await startUpload(projectId, PNG_BYTES, 'image/png', 'other', 'scan.png'), PNG_BYTES)).json().material_id as string;
    assert.equal(await runMaterialParseOnce(deps()), 'paused');
    const imageJob = await send('GET', `/api/v1/projects/${projectId}/materials/${imageId}/parse-job`);
    assert.equal(imageJob.json().state, 'paused'); assert.equal(imageJob.json().stage, 'awaiting_ocr');
    assert.equal(imageJob.json().outcome, 'pending_ocr'); assert.deepEqual(imageJob.json().pending_capabilities, ['ocr']);
    assert.equal(await runMaterialParseOnce(deps()), 'idle', 'paused OCR work is not reclaimed until OCR is connected');
    assert.equal(await requeueAwaitingOcrParseJobs(pool), 1);
    const imageOutcome = await runMaterialParseOnce(deps({
      ocr: async () => ({ snapshot_id: 'synthetic-ocr-snapshot', ocr_pages: 2, ocr_engine: 'tesseract', ocr_engine_version: 'synthetic-only', processing_ms: 42 }),
      afterStage: async (stage, lease) => {
        if (stage === 'ocr_evidence') await recordMaterialParseProcessingCost(pool, lease, 'ocr', {
          unit: 'ocr_page', quantity: 2, ocr_pages: 2, ocr_engine: 'tesseract', ocr_engine_version: 'synthetic-only', processing_ms: 42, outcome: 'succeeded',
        });
      },
    }));
    assert.equal(imageOutcome, 'succeeded');
    const [ocrJob] = await jobFor(imageId);
    const ocrCost = await processingCosts(ocrJob.id);
    assert.equal(ocrCost.length, 1, 'duplicate reporting for the same job/stage/attempt is idempotent');
    assert.deepEqual([ocrCost[0]!.stage, ocrCost[0]!.attempt, ocrCost[0]!.unit, ocrCost[0]!.quantity, ocrCost[0]!.processing_ms, ocrCost[0]!.outcome], ['ocr', 1, 'ocr_page', 2, 42, 'succeeded']);
    assert.equal(ocrCost[0]!.ocr_engine, 'tesseract'); assert.equal(ocrCost[0]!.ocr_engine_version, 'synthetic-only');
    assert.deepEqual(ocrJob.checkpoint.processing_costs['ocr:1'], ocrCost[0]);
    assert.equal((await internal(ocrJob.id)).at(-1)!.event.status, 'succeeded');

    const failedImageId = (await complete(projectId, await startUpload(projectId, PNG_BYTES, 'image/png', 'audit', 'scan-fail.png'), PNG_BYTES)).json().material_id as string;
    assert.equal(await runMaterialParseOnce(deps()), 'paused');
    assert.equal(await requeueAwaitingOcrParseJobs(pool), 1);
    assert.equal(await runMaterialParseOnce(deps({ ocr: async () => { throw new OcrProcessingError('OCR_PROCESS_FAILED', {
      ocr_pages: 1, ocr_engine: 'tesseract', ocr_engine_version: 'synthetic-only', processing_ms: 73,
    }); } })), 'retry_scheduled');
    const [failedOcrJob] = await jobFor(failedImageId);
    const failedOcrCost = await processingCosts(failedOcrJob.id);
    assert.deepEqual([failedOcrCost[0]!.stage, failedOcrCost[0]!.attempt, failedOcrCost[0]!.quantity, failedOcrCost[0]!.processing_ms, failedOcrCost[0]!.outcome], ['ocr', 1, 1, 73, 'failed']);
    assert.equal(failedOcrJob.checkpoint.processing_costs['ocr:1'].outcome, 'failed');
    assert.ok((await operations('material_parse_cancel', 'submitted')).length >= 1);

    // 6. Rejection before any run exists is logged: a completion whose declaration changed.
    const rejectBytes = Buffer.from('Synthetic rejected text\n', 'utf8');
    const rejectUpload = await startUpload(projectId, rejectBytes, 'text/plain', 'other', 'reject.txt');
    const rejected = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${rejectUpload}/complete`, { byte_size: rejectBytes.length, sha256: 'a'.repeat(64) });
    assert.equal(rejected.statusCode, 409);
    const rejectedOps = await operations('material_complete', 'rejected');
    assert.equal(rejectedOps.length, 1); assert.equal(rejectedOps[0].error_code, 'IDEMPOTENCY_CONFLICT'); assert.equal(rejectedOps[0].run_id, null);
    // Every rejected operation (terminal cancel, race-losing cancels, changed completion) has its #79 timeline row.
    const allRejected = (await pool.query("SELECT count(*)::int n FROM bb_operations WHERE owner_user_id=$1 AND status='rejected'", [owner])).rows[0].n;
    assert.ok(allRejected >= 2);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_observability_events WHERE owner_user_id=$1 AND kind='operation.rejected'", [owner])).rows[0].n, allRejected);

    // 7. Another account gets the uniform 404 for every new route, and its rejections are logged under its own ID.
    owner = bob;
    for (const [method, url, payload] of [
      ['GET', `/api/v1/projects/${projectId}/materials/${historicalId}/parse-job`],
      ['POST', `/api/v1/projects/${projectId}/materials/${historicalId}/parse-job/cancel`, { reason: 'foreign' }],
      ['GET', `/api/v1/projects/${projectId}/materials/${historicalId}/source-profile`],
      ['POST', `/api/v1/projects/${projectId}/preflight`, preflightBody],
      ['POST', `/api/v1/projects/${projectId}/materials/uploads/${rejectUpload}/complete`, { byte_size: rejectBytes.length, sha256: sha(rejectBytes) }],
    ] as const) {
      const response = await send(method, url, payload);
      assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
      assert.equal(response.json().code, 'NOT_FOUND');
    }
    const foreign = await pool.query("SELECT operation_kind,project_id,error_code FROM bb_operations WHERE owner_user_id=$1 ORDER BY operation_kind", [bob]);
    assert.deepEqual(foreign.rows.map(r => [r.operation_kind, r.project_id, r.error_code]),
      [['material_complete', null, 'NOT_FOUND'], ['material_parse_cancel', null, 'NOT_FOUND'], ['preflight', null, 'NOT_FOUND']]);
    owner = alice;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${textId}/source-profile`)).statusCode, 404, 'non-historical materials have no source profile');
  } finally {
    // The synthetic Azurite container is discarded with the test Azurite instance.
    await app.close(); await stagingApp.close(); await pool.end();
  }
});
