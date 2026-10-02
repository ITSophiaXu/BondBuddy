// SYNTHETIC PostgreSQL 16/Azurite test for the #17 worker runtime. The model is the fake
// `codex exec` fixture (test-fixtures/codex, replayed JSONL; no provider is called), the Word
// bytes are a synthetic OOXML fixture and every identity is generated. Claims are global, so the
// file runs in its own clone of the migrated template (see test-database.ts) and runs its
// scenarios sequentially with at most one claimable run at a time.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer, reviewIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { adminEvents, adminJobTimeline, forwardLogs, grantOperator, parseAdminFilter, type LogRecord } from '@bondbuddy/api/log-ops';
import { claimMaterialParse, documentParserVersion, requeueAwaitingOcrParseJobs } from '@bondbuddy/api/material-jobs';
import { checkpointStage, claim, pauseRun, resumePausedRun, upgradeStageCheckpoint } from '@bondbuddy/api/queue';
import { configureTrialGuard, createOverride, revokeOverride, setKillSwitch, trialConfigFromEnv } from '@bondbuddy/api/trial-guard';
import { DEFAULT_DISABLED_FEATURES, type CodexAdapterConfig, type CodexJournal } from './codex-adapter.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { backfillParseJobs } from './backfill-parse-jobs.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { codexModelStage, createMaterialsReadyStage, defaultRunStages, materialsReadiness, materialsReadyStage, runPipelineOnce, wordDeliveryStage, type RunStage, type StageContext } from './run-pipeline.js';
import { produceParsedFactCandidates, SEMANTIC_FACT_EXTRACTION_RESULT_VERSION, type SemanticFactExtractor } from './fact-candidate-producer.js';
import { WorkerRuntime, workerRuntimeOptionsFromEnv, type ProviderCallReconciler } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL');
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const ORIGIN = 'http://bondbuddy.test';
const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const schema = { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'integer' } }, required: ['answer', 'n'], additionalProperties: false };
const isAnswer = (v: unknown) => typeof v === 'object' && v !== null && typeof (v as { answer?: unknown }).answer === 'string';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashText = (value: string) => sha(Buffer.from(value));
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function syntheticParse(request: DocumentParseRequest): DocumentParseResponse {
  const m = request.material;
  return { schema_version: 'document-parse-response-v1', request_id: request.request_id, parser_version: documentParserVersion(), status: 'parsed',
    material: { material_id: m.material_id, material_version: m.material_version, media_type: m.media_type, sha256: m.sha256 },
    records: [{ record_id: 'line-1', material_id: m.material_id, material_version: m.material_version, content_hash: m.sha256, locator_type: 'text_line', locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: 'Synthetic audit text', context: 'synthetic', extraction_method: 'native_text', extractor_version: documentParserVersion(), confidence: 1, uncertainty: [], formatting: {} }],
    warnings: [], document: { page_count: null, encoding: 'utf-8' }, error: null } as DocumentParseResponse;
}

test('synthetic #17 worker runtime: idempotent submit, checkpoints, reuse, reconcile, cancel race, SSE, timeline, OCR hook and backfill', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = azureBlobs(blobConnection!, `bb-runtime-${randomUUID()}`);
  let owner = `runtime-owner-${randomUUID()}`;
  const alice = owner, mallory = `runtime-other-${randomUUID()}`, operator = `runtime-operator-${randomUUID()}`;
  const reviewer = `runtime-reviewer-${randomUUID()}`, grantor = `runtime-grantor-${randomUUID()}`;
  const app = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: owner, csrfVerified: true }), enableRunRuntime: true, stream: { pollMs: 50, maxDurationMs: 1500 } });
  const closedApp = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: owner, csrfVerified: true }), enableRunRuntime: false });
  const send = (method: string, url: string, payload?: unknown, extra: { contentType?: string; headers?: Record<string, string>; target?: typeof app } = {}) => (extra.target ?? app).inject({ method: method as any, url,
    headers: { origin: ORIGIN, ...(extra.contentType ? { 'content-type': extra.contentType } : {}), ...(extra.headers ?? {}) }, payload: payload as any });
  const root = await mkdtemp(join(tmpdir(), 'bb-runtime-'));
  const config: CodexAdapterConfig = { command: [process.execPath, fake], model_id: 'deepseek-flash', model_provider: 'deepseek', base_url: 'https://api.deepseek.com', wire_api: 'responses', model_config_version: 'codex-deepseek-flash-test', reasoning_effort: null, credential: { kind: 'env', name: 'BB_SYNTHETIC_DEEPSEEK_KEY' }, work_root: join(root, 'work'), timeout_ms: 5000, kill_grace_ms: 100, max_output_bytes: 1 << 20, max_schema_reasks: 1, disabled_features: DEFAULT_DISABLED_FEATURES, path_env: '/usr/bin:/bin' };
  const docx = makeWorkerDocxFixture({ externalLink: false });
  const model = (extra: { wrapJournal?: (j: CodexJournal) => CodexJournal } = {}) => codexModelStage({ name: 'model_generation', logicalCallId: 'update-generation', config, schema, validate: isAnswer, resultSchemaVersion: 'answer-v1',
    buildPrompt: async ctx => `SYNTHETIC update prompt for run ${ctx.run.id}. SCENARIO:structured`, ...extra });
  const word = (gate?: () => Promise<void>) => wordDeliveryStage(async ctx => { assert.deepEqual(ctx.values.get('model_generation'), { answer: 'OK', n: 16 }); await gate?.(); return docx; });
  // This integration suite exercises generic worker mechanics with synthetic inputs only.
  // The real inputLockStage has a separate fail-closed test because no production rule selector exists.
  const syntheticInputLockStage: RunStage = { name: 'input_lock', run: async ({ pool: db, run }) => {
    const q = await db.query(`SELECT input_hash,material_versions,rule_pack_version,template_version,reference_release FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [run.owner_user_id, run.project_id, run.input_revision]);
    const input = q.rows[0];
    if (!input) return { kind: 'fail', code: 'NOT_FOUND' };
    if (String(input.input_hash).trim() !== run.input_hash.trim()) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    return { kind: 'done', checkpoint: { input_revision: run.input_revision, input_hash: run.input_hash.trim(), material_versions: input.material_versions,
      rule_pack_version: input.rule_pack_version ?? null, template_version: input.template_version ?? null, reference_release: input.reference_release ?? null } };
  } };
  const stages = (extra: Partial<Record<'materials' | 'model' | 'word', RunStage>> = {}): RunStage[] => [syntheticInputLockStage, extra.materials ?? materialsReadyStage, extra.model ?? model(), extra.word ?? word()];
  const expire = (jobId: string) => pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId]);
  const runRow = async (runId: string) => (await pool.query('SELECT r.*,j.id AS job_id,j.state AS job_state,j.stage AS job_stage,j.checkpoint,j.error_code AS job_error FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1', [runId])).rows[0];
  const terminalEvents = async (runId: string) => (await pool.query("SELECT state FROM bb_run_events WHERE run_id=$1 AND state IN ('succeeded','failed','cancelled','rejected')", [runId])).rows.map(r => r.state);
  const attempts = async (jobId: string) => (await pool.query('SELECT attempt_no,status FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY attempt_no', [jobId])).rows.map(r => [r.attempt_no, r.status]);
  const active = async () => (await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE job_type<>'parse' AND state IN ('queued','running')")).rows[0].n;

  async function reviewedHistoricalMaterial(projectId: string) {
    const materialId = randomUUID(), uploadId = randomUUID(), snapshotId = randomUUID(), evidenceId = randomUUID();
    const contentHash = hashText(`synthetic historical material ${materialId}`);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
      state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic-history.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
    [uploadId, alice, projectId, contentHash, `users/${alice}/projects/${projectId}/uploads/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic-history.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$5,$6,'parsed')`,
    [materialId, alice, projectId, uploadId, contentHash, `users/${alice}/projects/${projectId}/materials/${materialId}`]);
    const parserVersion = documentParserVersion();
    const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${snapshotId}`, status: 'parsed', parser_version: parserVersion,
      material: { material_id: materialId, material_version: 1, media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: contentHash },
      warnings: [], document: { page_count: null }, error: null };
    await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
      response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
    [snapshotId, alice, projectId, materialId, contentHash, parserVersion, hashText(`request-${snapshotId}`), hashText(`response-${snapshotId}`), JSON.stringify(meta)]);
    await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
      locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'docx_block',$7::jsonb,'合成发行人','synthetic identity evidence','native_text',$8,1,'[]','{}',$9,0)`,
    [alice, projectId, materialId, snapshotId, evidenceId, contentHash, JSON.stringify({ paragraph: 1 }), parserVersion, hashText(evidenceId)]);
    const observation = await appendIssuerIdentitySourceRecord({ pool }, { ownerUserId: alice, projectId, materialId, materialVersion: 1,
      requestId: randomUUID(), sourceRecordId: evidenceId, issuerDisplayName: '合成发行人', entityId: 'synthetic-runtime-issuer' });
    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_runtime_test',$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), reviewer, grantor, alice, projectId]);
    const trustedReviewer = await authorizeIssuerIdentityReviewer(pool, reviewer, { ownerUserId: alice, projectId });
    assert.ok(trustedReviewer);
    await reviewIssuerIdentitySourceRecord({ pool }, { ownerUserId: alice, projectId, materialId, materialVersion: 1,
      sourceRecordRowId: observation.id, reviewer: trustedReviewer, decision: 'verified', verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
      entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic runtime identity', reasonCode: 'synthetic_identity_verified' });
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,job_type,subtype,state,project_id,material_id,material_version,material_sha256,
      parser_version,trace_id,max_attempts,result) VALUES($1,$2,'parse','material_parse','succeeded',$3,$4,1,$5,$6,$7,3,$8::jsonb)`,
    [randomUUID(), alice, projectId, materialId, contentHash, parserVersion, randomUUID(), JSON.stringify({ outcome: 'parsed' })]);
    return { material_id: materialId, material_version: 1 };
  }
  async function project(label: string, materialVersions: { material_id: string; material_version: number }[] = [], projectId?: string, withIdentity = true) {
    let id = projectId;
    if (!id) {
      const p = await send('POST', '/api/v1/projects', { name: `Synthetic runtime ${label}`, kind: 'update', issuer_name: null, market: null, offering: null });
      assert.equal(p.statusCode, 201, p.body); id = p.json().project_id as string;
    }
    const selected = withIdentity ? [...materialVersions, await reviewedHistoricalMaterial(id!)] : materialVersions;
    const current = (await send('GET', `/api/v1/projects/${id}`)).json();
    const input = await send('POST', `/api/v1/projects/${id}/input-revisions`, { draft_revision: current.draft_revision, material_versions: selected, requirement_message_ids: [] });
    assert.equal(input.statusCode, 201, input.body);
    return { projectId: id!, inputRevision: input.json().input_revision as number, inputHash: input.json().input_hash as string };
  }
  const execute = (p: Awaited<ReturnType<typeof project>>, key = `exec-${randomUUID()}`, target?: typeof app) => send('POST', '/api/v1/runs/execute',
    { execution_request_id: key, project_id: p.projectId, input_revision: p.inputRevision, input_hash: p.inputHash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-worker' }, { target });
  async function upload(projectId: string, bytes: Buffer, mediaType: string, role: string, filename: string) {
    const start = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename, media_type: mediaType, byte_size: bytes.length, sha256: sha(bytes), role });
    assert.equal(start.statusCode, 201, start.body);
    assert.equal((await send('PUT', start.json().upload_url, bytes, { contentType: 'application/octet-stream' })).statusCode, 204);
    const done = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${start.json().upload_id}/complete`, { byte_size: bytes.length, sha256: sha(bytes) });
    assert.equal(done.statusCode, 200, done.body);
    return done.json() as { material_id: string; material_version: number };
  }
  const parseDeps = { pool, leaseSeconds: 30, material: { pool, blobs: { getPrivate: (key: string) => blobs.getIfExists(key) }, parser: async (r: DocumentParseRequest) => syntheticParse(r) } };
  function sse(body: string) {
    return body.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':') && !f.startsWith('retry:')).map(frame => {
      const lines = Object.fromEntries(frame.split('\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
      return { id: lines.id ? Number(lines.id) : undefined, event: lines.event, data: JSON.parse(lines.data) };
    });
  }

  try {
    assert.equal(await active(), 0, 'requires a dedicated database');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [alice, `o${randomUUID().replaceAll('-', '').slice(0, 30)}`]);
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [operator, `u${operator.replace(/-/g, '_').toLowerCase()}`.slice(0, 32)]);
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)', [reviewer, `r${randomUUID().replaceAll('-', '').slice(0, 30)}`, grantor, `g${randomUUID().replaceAll('-', '').slice(0, 30)}`]);
    await grantOperator(pool, { userId: operator, role: 'log_reader', grantedBy: 'synthetic-test', reasonCode: 'runtime_test' });

    // 1. Ten concurrent identical submissions -> one run, one job.
    const p1 = await project('happy');
    const key = `dup-${randomUUID()}`;
    const submissions = await Promise.all(Array.from({ length: 10 }, () => execute(p1, key)));
    assert.ok(submissions.every(s => s.statusCode === 202), submissions.map(s => s.body).join('\n'));
    const runId = submissions[0].json().run_id as string;
    assert.ok(submissions.every(s => s.json().run_id === runId));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE run_id=$1', [runId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT subtype FROM bb_jobs WHERE run_id=$1', [runId])).rows[0].subtype, 'update_pipeline_v1');
    const other = await execute({ ...p1, inputHash: p1.inputHash }, key.replace('dup', 'dup2'));
    assert.equal(other.statusCode, 202); assert.notEqual(other.json().run_id, runId, 'a new execution_request_id is a new run');
    // Cancel the second run so exactly one run is claimable; cancel is recorded as a terminal kind.
    const cancelledRunId = other.json().run_id as string;
    assert.equal((await send('POST', `/api/v1/runs/${cancelledRunId}/cancel`, { reason: 'synthetic' })).statusCode, 200);
    assert.equal((await send('POST', `/api/v1/runs/${cancelledRunId}/cancel`, { reason: 'synthetic' })).statusCode, 409, 'one final state');

    // 2. Crash right after the model stage checkpoint -> resume reuses the stored result: no second call.
    const crashAfterModel = await runPipelineOnce({ pool, blobs, stages: stages(), afterStage: async stage => { if (stage === 'model_generation') throw new Error('SYNTHETIC_CRASH'); } }).catch(e => e.message);
    assert.equal(crashAfterModel, 'SYNTHETIC_CRASH');
    let row = await runRow(runId);
    assert.equal(row.job_state, 'running', 'the crashed lease is still held'); assert.ok(row.checkpoint.stages.model_generation);
    assert.deepEqual(await attempts(row.job_id), [[1, 'completed']]);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'idle', 'an unexpired lease is not stolen');
    await expire(row.job_id);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'succeeded');
    row = await runRow(runId);
    assert.equal(row.state, 'succeeded'); assert.ok(row.artifact_id);
    assert.deepEqual(await attempts(row.job_id), [[1, 'completed']], 'restart reused the completed call');
    assert.deepEqual(await terminalEvents(runId), ['succeeded']);
    const reasons = (await pool.query('SELECT payload->>\'reason\' r FROM bb_run_events WHERE run_id=$1 ORDER BY seq', [runId])).rows.map(r => r.r);
    assert.ok(reasons.includes('lease_recovered') && reasons.includes('provider_result_reconciled') && reasons.at(-1) === 'word_delivered', reasons.join(','));
    const artifact = await send('GET', `/api/v1/artifacts/${row.artifact_id}`);
    assert.equal(artifact.statusCode, 200, artifact.body);
    const download = await send('GET', artifact.json().download_url);
    assert.equal(download.statusCode, 200); assert.equal(sha(download.rawPayload), sha(docx));
    assert.equal((await send('POST', `/api/v1/runs/${runId}/cancel`, { reason: 'late' })).statusCode, 409, 'complete then cancel keeps one final state');

    // 3. SSE of persisted run events: resumable by Last-Event-ID, owner-checked, ends at terminal.
    const full = await send('GET', `/api/v1/runs/${runId}/stream`);
    assert.equal(full.statusCode, 200); assert.match(String(full.headers['content-type']), /text\/event-stream/);
    const frames = sse(full.body);
    assert.equal(frames[0].event, 'snapshot'); assert.equal(frames[0].data.state, 'succeeded');
    const seqs = frames.filter(f => f.id !== undefined).map(f => f.id!);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1));
    assert.deepEqual(frames.at(-1), { id: undefined, event: 'stream.end', data: { reason: 'terminal', last_event_id: seqs.at(-1) } });
    const resumed = sse((await send('GET', `/api/v1/runs/${runId}/stream`, undefined, { headers: { 'last-event-id': String(seqs.length - 2) } })).body);
    assert.deepEqual(resumed.filter(f => f.id !== undefined).map(f => f.id), [seqs.length - 1, seqs.length]);
    assert.ok(!resumed.some(f => f.event === 'snapshot'), 'a resumed stream sends no snapshot');
    assert.equal((await send('GET', `/api/v1/runs/${runId}/stream?after=abc`)).statusCode, 422);
    owner = mallory;
    assert.equal((await send('GET', `/api/v1/runs/${runId}/stream`)).statusCode, 404, 'foreign run shares 404');
    owner = alice;

    // 4. Unknown call state: the worker dies after the call intent commits (the call may have been sent).
    const p2 = await project('unknown');
    const unknownRun = (await execute(p2)).json().run_id as string;
    const crashAfterIntent = (j: CodexJournal): CodexJournal => Object.assign(Object.create(Object.getPrototypeOf(j)), j, {
      recordIntent: async (intent: Parameters<CodexJournal['recordIntent']>[0]) => { await j.recordIntent(intent); throw new Error('SYNTHETIC_CRASH'); } });
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ model: model({ wrapJournal: crashAfterIntent }) }) }).catch(e => e.message), 'SYNTHETIC_CRASH');
    row = await runRow(unknownRun);
    assert.deepEqual(await attempts(row.job_id), [[1, 'pending_reconcile']]);
    await expire(row.job_id);
    // The recovering claim sees an unresolved attempt and pauses the run instead of executing it (no resend).
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'idle');
    row = await runRow(unknownRun);
    assert.equal(row.state, 'paused'); assert.equal(row.job_stage, 'provider_reconcile');
    assert.deepEqual(await attempts(row.job_id), [[1, 'pending_reconcile']]);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'idle', 'a paused run is not claimed');
    // The default Codex reconciler cannot prove anything, so the run stays paused.
    const runtimeDefault = new WorkerRuntime({ pool, blobs, runStages: stages() });
    assert.equal(await runtimeDefault.reconcileRun(alice, unknownRun, row.job_id), false);
    assert.equal((await runRow(unknownRun)).state, 'paused');
    assert.equal((await send('POST', `/api/v1/runs/${unknownRun}/resume`, { reason: 'synthetic' })).statusCode, 409, 'the owner cannot skip reconciliation');
    // A reconciler that queried the supplier and proved the call was never sent -> retry as attempt 2.
    const queried: string[] = [];
    const notSent: ProviderCallReconciler = { name: 'synthetic_lookup', query: async attempt => { queried.push(`${attempt.logical_call_id}#${attempt.attempt_no}`); return { outcome: 'confirmed_not_sent' }; } };
    assert.equal(await new WorkerRuntime({ pool, blobs, runStages: stages(), reconciler: notSent }).reconcileRun(alice, unknownRun, row.job_id), true);
    assert.deepEqual(queried, ['update-generation#1'], 'queried before any retry');
    assert.equal((await runRow(unknownRun)).state, 'queued');
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'succeeded');
    assert.deepEqual(await attempts(row.job_id), [[1, 'confirmed_not_sent'], [2, 'completed']]);

    // 5. Cancel vs complete race: cancel lands while the Word stage runs -> exactly one final state.
    const p3 = await project('race');
    const raceRun = (await execute(p3)).json().run_id as string;
    let release!: () => void; let entered!: () => void;
    const inWord = new Promise<void>(resolve => { entered = resolve; });
    const gate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const racing = runPipelineOnce({ pool, blobs, stages: stages({ word: word(gate) }) });
    await inWord;
    const [cancel] = await Promise.all([send('POST', `/api/v1/runs/${raceRun}/cancel`, { reason: 'synthetic' }), Promise.resolve().then(() => release())]);
    const raceOutcome = await racing;
    row = await runRow(raceRun);
    assert.deepEqual(await terminalEvents(raceRun), [row.state], 'one terminal event');
    if (cancel.statusCode === 200) { assert.equal(row.state, 'cancelled'); assert.equal(raceOutcome, 'lost'); assert.equal(row.artifact_id, null); }
    else { assert.equal(cancel.statusCode, 409); assert.equal(row.state, 'succeeded'); }
    // Deterministic cancel-first ordering as well.
    const p4 = await project('race2');
    const race2 = (await execute(p4)).json().run_id as string;
    let release2!: () => void; let entered2!: () => void;
    const inWord2 = new Promise<void>(resolve => { entered2 = resolve; });
    const racing2 = runPipelineOnce({ pool, blobs, stages: stages({ word: word(() => { entered2(); return new Promise<void>(resolve => { release2 = resolve; }); }) }) });
    await inWord2;
    assert.equal((await send('POST', `/api/v1/runs/${race2}/cancel`, { reason: 'synthetic' })).statusCode, 200);
    release2();
    assert.equal(await racing2, 'lost');
    assert.deepEqual(await terminalEvents(race2), ['cancelled']);
    assert.equal((await runRow(race2)).artifact_id, null, 'a cancelled run has no artifact');

    // 6. Failure keeps recoverable materials and the checkpoint; the Word check fails closed.
    const p5 = await project('failure');
    const failedRun = (await execute(p5)).json().run_id as string;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ word: wordDeliveryStage(async () => Buffer.from('not a docx')) }) }), 'failed');
    row = await runRow(failedRun);
    assert.equal(row.state, 'failed'); assert.equal(row.artifact_id, null); assert.equal(row.job_error, 'DELIVERY_FAILED');
    assert.ok(row.checkpoint.stages.input_lock && row.checkpoint.stages.model_generation, 'checkpoint survives failure');
    assert.equal((await send('GET', `/api/v1/projects/${p5.projectId}/input-revisions/${p5.inputRevision}`)).statusCode, 200, 'input revision still readable');

    // 7. An update without a reviewed historical identity remains pending before rule/model stages.
    const p6MissingIdentity = await project('missing-identity', [], undefined, false);
    const missingIdentityRun = (await execute(p6MissingIdentity)).json().run_id as string;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: defaultRunStages() }), 'paused');
    row = await runRow(missingIdentityRun);
    assert.equal(row.state, 'paused'); assert.equal(row.job_stage, 'capability_not_ready'); assert.equal(row.job_error, null); assert.equal(row.artifact_id, null);
    assert.equal((await pool.query("SELECT payload->>'reason' reason FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1", [missingIdentityRun])).rows[0].reason,
      'historical_material_not_selected');
    assert.equal((await send('POST', `/api/v1/runs/${missingIdentityRun}/cancel`, { reason: 'cleanup' })).statusCode, 200);

    // A reviewed identity passes the identity gate; a missing production rule pin still pauses.
    const p6 = await project('not-ready');
    const notReadyRun = (await execute(p6)).json().run_id as string;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: defaultRunStages() }), 'paused');
    row = await runRow(notReadyRun);
    const pauseReason = (await pool.query("SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1", [notReadyRun])).rows[0].reason;
    assert.equal(row.state, 'paused'); assert.equal(row.job_stage, 'capability_not_ready'); assert.equal(pauseReason, 'rule_applicability_reference_missing'); assert.equal(row.artifact_id, null);
    assert.equal((await send('POST', `/api/v1/runs/${notReadyRun}/cancel`, { reason: 'cleanup' })).statusCode, 200);

    // 8. Pinned materials still parsing -> awaiting_materials; the runtime sweep re-queues after parse succeeds.
    const p7Project = (await send('POST', '/api/v1/projects', { name: 'Synthetic runtime materials', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id as string;
    const text = Buffer.from(`synthetic audit ${randomUUID()}`);
    const m = await upload(p7Project, text, 'text/plain', 'audit', 'synthetic-audit.txt');
    const p7 = await project('materials', [{ material_id: m.material_id, material_version: m.material_version }], p7Project);
    const materialsRun = (await execute(p7)).json().run_id as string;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'paused');
    assert.equal((await runRow(materialsRun)).job_stage, 'awaiting_materials');
    const runtime = new WorkerRuntime({ pool, blobs, runStages: stages(), parse: { material: parseDeps.material } });
    await runtime.sweep();
    assert.equal((await runRow(materialsRun)).state, 'paused', 'still parsing');
    // Parse job SSE before and after the parse completes.
    const parseStream1 = sse((await send('GET', `/api/v1/projects/${p7Project}/materials/${m.material_id}/parse-job/stream`)).body);
    assert.equal(parseStream1[0].event, 'snapshot'); assert.equal(parseStream1.at(-1)!.data.reason, 'max_duration');
    const lastParseSeq = parseStream1.filter(f => f.id !== undefined).at(-1)!.id!;
    assert.equal(await runMaterialParseOnce(parseDeps), 'succeeded');
    const parseStream2 = sse((await send('GET', `/api/v1/projects/${p7Project}/materials/${m.material_id}/parse-job/stream`, undefined, { headers: { 'last-event-id': String(lastParseSeq) } })).body);
    assert.deepEqual(parseStream2.filter(f => f.id !== undefined).map(f => f.data.type), ['material_parse.claimed', 'material_parse.stage_completed', 'material_parse.succeeded']);
    assert.equal(parseStream2.at(-1)!.data.reason, 'terminal');
    await runtime.sweep();
    assert.equal((await runRow(materialsRun)).state, 'queued');
    // Parsed files cannot fix the former notes-context overflow. It must not requeue forever.
    const contextLease=await claim(pool,30);assert.equal(contextLease?.runId,materialsRun);
    await pauseRun(pool,contextLease!,'awaiting_materials','authoring_material_context_too_large');
    await runtime.sweep();await runtime.sweep();
    assert.equal((await runRow(materialsRun)).state,'paused','context failures do not occupy the worker again');
    assert.equal((await send('POST',`/api/v1/runs/${materialsRun}/resume`,{reason:'synthetic explicit resume'})).statusCode,200);
    const pinnedRun = (await pool.query('SELECT id,owner_user_id,project_id,input_revision,input_hash,task_kind FROM bb_runs WHERE id=$1', [materialsRun])).rows[0];
    const materialContext = { pool, run: pinnedRun, values:new Map() } as StageContext;
    assert.deepEqual(await createMaterialsReadyStage().run(materialContext),
      { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_candidate_producer_unavailable' });
    const productionMaterials = workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_JOB_KINDS: 'run' })
      .runStages?.find(stage => stage.name === 'materials_ready');
    assert.deepEqual(await productionMaterials?.run(materialContext),
      { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_candidate_producer_unavailable' });
    let factExtractCalls = 0;
    const extractor: SemanticFactExtractor = { id: 'synthetic-runtime-financial', version: '1.0.0', extract: async request => {
      factExtractCalls++;
      assert.equal(request.owner_user_id, alice);
      assert.equal(request.project_id, p7Project);
      assert.equal(request.input_revision, p7.inputRevision);
      assert.equal(request.input_hash, p7.inputHash);
      assert.equal(request.material_id, m.material_id);
      assert.equal(request.material_version, m.material_version);
      const evidence = request.records[0]!;
      return { schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
        extractor: { id: 'synthetic-runtime-financial', version: '1.0.0' },
        parse_snapshot: { snapshot_id: request.parse_snapshot_id, response_sha256: request.parse_response_sha256,
          parser_version: request.parser_version, material_id: request.material_id, material_version: request.material_version,
          content_sha256: request.material_sha256 },
        facts: [{ extraction_id: 'synthetic-revenue', identity: { scope: 'consolidated', metric: 'operating_revenue',
          period: { start: '2024-01-01', end: '2024-12-31' }, currency: 'CNY', unit: 'yuan', basis: 'reported_financial_statement' },
          value: { kind: 'known', decimalOrText: '123.45' }, source_kind: 'external', confidence: 1,
          uncertainty: ['SYNTHETIC_SOURCE_NOT_VERIFIED'],
          evidence_refs: [evidence.record_id] }],
        needs_review: [{ evidence_refs: [evidence.record_id], reason_code: 'SYNTHETIC_ADJACENT_GAP' }] };
    } };
    const factCandidateProducer = (context: Parameters<typeof produceParsedFactCandidates>[1]) =>
      produceParsedFactCandidates({ pool, extractor }, context);
    const customMaterials: RunStage = { name: 'materials_ready', run: async () => ({ kind: 'pause', stage: 'capability_not_ready', reason: 'custom_materials_gate' }) };
    assert.throws(() => new WorkerRuntime({ pool, blobs, runStages: stages({ materials: customMaterials }), factCandidateProducer }),
      /factCandidateProducer conflicts with explicit materials_ready stage/);
    const changedFactoryOptions = workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_JOB_KINDS: 'run' });
    changedFactoryOptions.runStages = changedFactoryOptions.runStages!.map(stage => stage.name === 'materials_ready' ? customMaterials : stage);
    assert.throws(() => new WorkerRuntime({ ...changedFactoryOptions, factCandidateProducer }),
      /factCandidateProducer conflicts with explicit materials_ready stage/);
    assert.equal(factExtractCalls, 0, 'rejected stage compositions cannot invoke the producer');
    const envRuntime = new WorkerRuntime({
      ...workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_JOB_KINDS: 'run' }), factCandidateProducer,
    });
    const materialStage = (envRuntime as unknown as { o: { runStages: RunStage[] } }).o.runStages.find(stage => stage.name === 'materials_ready');
    assert.ok(materialStage, 'environment runtime retains the materials stage');
    assert.equal((await materialStage.run(materialContext)).kind, 'done', 'environment runtime binds the trusted producer');
    assert.equal(factExtractCalls, 1);
    assert.equal((await materialStage.run(materialContext)).kind, 'done', 'same locked source reuses the ledger');
    assert.equal(factExtractCalls, 1);
    assert.equal((await materialStage.run({ ...materialContext, run: { ...pinnedRun, owner_user_id: mallory } })).kind, 'fail');
    assert.equal((await materialStage.run({ ...materialContext, run: { ...pinnedRun, input_hash: hashText('wrong input') } })).kind, 'fail');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'", [materialsRun])).rows[0].n, 0);
    assert.equal((await materialStage.run(materialContext)).kind, 'done', 'producer persists before the stage checkpoint');
    assert.equal((await materialStage.run(materialContext)).kind, 'done', 'crash replay uses the persisted extraction');
    assert.equal(factExtractCalls, 1);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: materialStage }) }), 'succeeded');
    const factCheckpoint = (await runRow(materialsRun)).checkpoint.stages.materials_ready;
    const newStageEvents = (await pool.query(`SELECT id FROM bb_run_events
      WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed'`, [materialsRun])).rows;
    assert.equal(newStageEvents.length, 1, 'a newly completed materials stage emits one completion event');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bb_outbox WHERE aggregate_type='run' AND aggregate_id=$1
      AND event_type='run.progress' AND payload->>'event_id'=$2`, [materialsRun, newStageEvents[0]!.id])).rows[0].n, 1,
    'the new completion event has one durable outbox record');
    assert.equal(factCheckpoint.extractions.length, 1);
    assert.equal(factCheckpoint.extractions[0].candidate_count, 1);
    assert.equal(factCheckpoint.extractions[0].needs_review_count, 1);
    const persistedFact = (await pool.query(`SELECT source_kind,status,uncertainty,evidence FROM bb_fact_candidates
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3`, [alice, p7Project, m.material_id])).rows;
    assert.equal(persistedFact.length, 1);
    assert.equal(persistedFact[0]!.source_kind, 'external');
    assert.equal(persistedFact[0]!.status, 'needs_confirmation');
    assert.ok(persistedFact[0]!.uncertainty.includes('SYNTHETIC_SOURCE_NOT_VERIFIED'));
    assert.equal(persistedFact[0]!.evidence.length, 1);
    assert.equal(factExtractCalls, 1);
    assert.equal((await materialStage.run({ ...materialContext, checkpoint: { materials_ready: factCheckpoint } })).kind, 'done');
    assert.deepEqual(await materialStage.run({ ...materialContext, checkpoint: { materials_ready: {
      ...factCheckpoint, extractions: [{ ...factCheckpoint.extractions[0], extraction_run_id: 'wrong-run' }] } } }),
    { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_extraction_checkpoint_mismatch' });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='fact.extraction.completed'", [alice, p7Project])).rows[0].n, 1);
    assert.equal((await createMaterialsReadyStage().run({ ...materialContext, run: { ...pinnedRun, owner_user_id: mallory } })).kind, 'fail');
    assert.equal((await createMaterialsReadyStage().run({ ...materialContext, run: { ...pinnedRun, input_hash: hashText('wrong input') } })).kind, 'fail');
    const reviewOnlyExtractor: SemanticFactExtractor = { id: 'synthetic-review-only', version: '1.0.0', extract: async request => {
      const mapped = await extractor.extract(request);
      return { ...mapped, extractor: { id: 'synthetic-review-only', version: '1.0.0' }, facts: [] };
    } };
    assert.deepEqual(await createMaterialsReadyStage(context => produceParsedFactCandidates({ pool, extractor: reviewOnlyExtractor }, context)).run(materialContext),
      { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_candidates_unavailable' });

    const legacyMaterials = factCheckpoint.materials as { material_id: string; material_version: number; outcome: string | null }[];
    const factExtractCallsBeforeLegacy = factExtractCalls;
    const seedLegacyCheckpoint = async (runId: string, materials: typeof legacyMaterials) => {
      await pool.query('UPDATE bb_jobs SET checkpoint=$2::jsonb WHERE run_id=$1',
        [runId, JSON.stringify({ stages: { materials_ready: { materials } } })]);
    };
    const checkpointWithoutLegacyRun = (await execute(p7)).json().run_id as string;
    const checkpointWithoutLegacyLease = await claim(pool, 30);
    assert.ok(checkpointWithoutLegacyLease);
    assert.equal(checkpointWithoutLegacyLease.runId, checkpointWithoutLegacyRun);
    const checkpointBeforeRejectedUpgrade = (await runRow(checkpointWithoutLegacyRun)).checkpoint;
    await assert.rejects(upgradeStageCheckpoint(pool, checkpointWithoutLegacyLease, 'materials_ready', { materials: legacyMaterials, extractions: [] }),
      /STAGE_CHECKPOINT_UPGRADE_REQUIRES_EXISTING_CHECKPOINT/);
    assert.deepEqual((await runRow(checkpointWithoutLegacyRun)).checkpoint, checkpointBeforeRejectedUpgrade,
      'an upgrade without a prior stage checkpoint rolls back');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_run_events WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed'", [checkpointWithoutLegacyRun])).rows[0].n, 0,
      'a rejected upgrade does not emit a completion event');
    assert.equal((await send('POST', `/api/v1/runs/${checkpointWithoutLegacyRun}/cancel`, { reason: 'synthetic cleanup' })).statusCode, 200);

    const legacyFactRun = (await execute(p7)).json().run_id as string;
    const legacyLease = await claim(pool, 30);
    assert.ok(legacyLease);
    assert.equal(legacyLease.runId, legacyFactRun);
    await checkpointStage(pool, legacyLease, 'materials_ready', { materials: legacyMaterials });
    const originalStageEvent = (await pool.query(`SELECT id,seq,type,state,stage,payload FROM bb_run_events
      WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed' ORDER BY seq`, [legacyFactRun])).rows;
    assert.equal(originalStageEvent.length, 1);
    const originalStageOutbox = (await pool.query(`SELECT id,event_type,payload FROM bb_outbox
      WHERE aggregate_type='run' AND aggregate_id=$1 AND event_type='run.progress' AND payload->>'event_id'=$2`,
    [legacyFactRun, originalStageEvent[0].id])).rows;
    assert.equal(originalStageOutbox.length, 1);
    await expire(legacyLease.jobId);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'paused',
      'legacy checkpoint still pauses when the trusted producer is not installed');
    assert.deepEqual((await runRow(legacyFactRun)).checkpoint.stages.materials_ready, { materials: legacyMaterials });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'", [legacyFactRun])).rows[0].n, 0,
      'missing producer does not create a model request snapshot');
    assert.deepEqual((await pool.query(`SELECT id,seq,type,state,stage,payload FROM bb_run_events
      WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed' ORDER BY seq`, [legacyFactRun])).rows,
    originalStageEvent, 'the pre-existing completion event survives the safe pause');
    assert.deepEqual((await pool.query(`SELECT id,event_type,payload FROM bb_outbox
      WHERE aggregate_type='run' AND aggregate_id=$1 AND event_type='run.progress' AND payload->>'event_id'=$2`,
    [legacyFactRun, originalStageEvent[0].id])).rows, originalStageOutbox,
    'the pre-existing outbox record survives the safe pause');
    assert.equal(await resumePausedRun(pool, alice, legacyFactRun, 'materials_ready'), true);

    let enteredUpgrade!: () => void, releaseUpgrade!: () => void;
    const upgradeEntered = new Promise<void>(resolve => { enteredUpgrade = resolve; });
    const upgradeGate = new Promise<void>(resolve => { releaseUpgrade = resolve; });
    const gatedLegacyMaterialStage: RunStage = { ...materialStage, run: async context => {
      const outcome = await materialStage.run(context);
      enteredUpgrade();
      await upgradeGate;
      return outcome;
    } };
    const interruptedUpgrade = runPipelineOnce({ pool, blobs, stages: stages({ materials: gatedLegacyMaterialStage }),
      afterStage: async stage => { if (stage === 'materials_ready') throw new Error('SYNTHETIC_CRASH'); } });
    await upgradeEntered;
    assert.equal(await claim(pool, 30), null, 'a concurrent worker cannot claim the active upgrade lease');
    releaseUpgrade();
    await assert.rejects(interruptedUpgrade, /SYNTHETIC_CRASH/);
    const upgraded = (await runRow(legacyFactRun)).checkpoint.stages.materials_ready;
    assert.deepEqual(upgraded.materials, legacyMaterials);
    assert.deepEqual(upgraded.extractions, factCheckpoint.extractions);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bb_fact_extraction_runs WHERE id=$1`,
      [factCheckpoint.extractions[0]!.extraction_run_id])).rows[0].n, 1,
      'the extractor ledger remains independently unique for the locked source');
    assert.equal(factExtractCalls, factExtractCallsBeforeLegacy,
      'existing extractor output is reused, independently of stage event cardinality');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_run_events WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed'", [legacyFactRun])).rows[0].n, 1,
      'checkpoint upgrade did not append a second logical completion');
    await expire(legacyLease.jobId);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: materialStage }) }), 'succeeded',
      'replay after the committed upgrade continues from the durable checkpoint');
    assert.deepEqual((await runRow(legacyFactRun)).checkpoint.stages.materials_ready, upgraded);
    const retainedStageEvents = (await pool.query(`SELECT id,seq,type,state,stage,payload FROM bb_run_events
      WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed' ORDER BY seq`, [legacyFactRun])).rows;
    const retainedStageOutbox = (await pool.query(`SELECT id,event_type,payload FROM bb_outbox
      WHERE aggregate_type='run' AND aggregate_id=$1 AND event_type='run.progress' AND payload->>'event_id'=$2`,
    [legacyFactRun, originalStageEvent[0].id])).rows;
    assert.deepEqual(retainedStageEvents, originalStageEvent, 'the exact historical event remains unchanged after replay');
    assert.deepEqual(retainedStageOutbox, originalStageOutbox, 'the corresponding durable outbox record remains unchanged');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_run_events WHERE run_id=$1 AND stage='materials_ready' AND payload->>'reason'='stage_completed'", [legacyFactRun])).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bb_outbox WHERE aggregate_type='run' AND aggregate_id=$1
      AND event_type='run.progress' AND payload->>'stage'='materials_ready' AND payload->>'reason'='stage_completed'`, [legacyFactRun])).rows[0].n, 1);

    const mismatchedLedgerRun = (await execute(p7)).json().run_id as string;
    await seedLegacyCheckpoint(mismatchedLedgerRun, legacyMaterials);
    const untrustedLedgerStage = createMaterialsReadyStage(async context => ({
      ...await produceParsedFactCandidates({ pool, extractor }, context), extractionRunId: 'synthetic-missing-ledger' }));
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: untrustedLedgerStage }) }), 'retry');
    assert.deepEqual((await runRow(mismatchedLedgerRun)).checkpoint.stages.materials_ready, { materials: legacyMaterials });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'", [mismatchedLedgerRun])).rows[0].n, 0);
    assert.ok((await pool.query("SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1", [mismatchedLedgerRun])).rows
      .some(row => row.reason === 'material_fact_stage_failed'));
    assert.equal((await send('POST', `/api/v1/runs/${mismatchedLedgerRun}/cancel`, { reason: 'synthetic cleanup' })).statusCode, 200);

    const mismatchedLegacyRun = (await execute(p7)).json().run_id as string;
    const wrongLegacyMaterials = legacyMaterials.map((material, index) => index === 0 ?
      { ...material, material_version: material.material_version + 1 } : material);
    await seedLegacyCheckpoint(mismatchedLegacyRun, wrongLegacyMaterials);
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: materialStage }) }), 'paused');
    assert.equal((await pool.query("SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1", [mismatchedLegacyRun])).rows[0].reason,
      'fact_extraction_checkpoint_mismatch');
    assert.deepEqual((await runRow(mismatchedLegacyRun)).checkpoint.stages.materials_ready, { materials: wrongLegacyMaterials });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'", [mismatchedLegacyRun])).rows[0].n, 0);
    assert.equal((await send('POST', `/api/v1/runs/${mismatchedLegacyRun}/cancel`, { reason: 'synthetic cleanup' })).statusCode, 200);

    const noFinancialInput = await project('legacy without financial material');
    const noFinancialRun = (await execute(noFinancialInput)).json().run_id as string;
    const noFinancialRow = (await pool.query('SELECT id,owner_user_id,project_id,input_revision,input_hash,task_kind FROM bb_runs WHERE id=$1', [noFinancialRun])).rows[0];
    const nonfinancialReady = await materialsReadiness(pool, noFinancialRow);
    assert.equal(nonfinancialReady.status, 'ready');
    await seedLegacyCheckpoint(noFinancialRun, nonfinancialReady.materials.map(({ material_id, material_version, outcome }) =>
      ({ material_id, material_version, outcome })));
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'succeeded');
    assert.deepEqual((await runRow(noFinancialRun)).checkpoint.stages.materials_ready.extractions, []);

    // Two pinned financial sources: a producer error after the first commit cannot checkpoint
    // the stage or enter the model. Recovery reuses that ledger and follows manifest order.
    const multiProject = (await send('POST', '/api/v1/projects', { name: 'Synthetic ordered facts', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id as string;
    const multiA = await upload(multiProject, Buffer.from(`synthetic finance A ${randomUUID()}`), 'text/plain', 'audit', 'a.txt');
    const multiB = await upload(multiProject, Buffer.from(`synthetic finance B ${randomUUID()}`), 'text/plain', 'financial', 'b.txt');
    assert.notEqual(multiA.material_id, multiB.material_id);
    const multiInput = await project('multi', [multiA, multiB].map(material => ({ material_id: material.material_id,
      material_version: material.material_version })), multiProject);
    const multiRun = (await execute(multiInput)).json().run_id as string;
    assert.equal(await runMaterialParseOnce(parseDeps), 'succeeded');
    assert.equal(await runMaterialParseOnce(parseDeps), 'succeeded');
    const pinnedFinancial = (await pool.query(`SELECT material_versions FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [alice, multiProject, multiInput.inputRevision])).rows[0].material_versions
      .filter((ref: { material_id: string }) => [multiA.material_id, multiB.material_id].includes(ref.material_id)) as { material_id: string; material_version: number }[];
    const multiExtractor: SemanticFactExtractor = { id: 'synthetic-ordered-financial', version: '1.0.0', extract: async request => ({
      schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
      extractor: { id: 'synthetic-ordered-financial', version: '1.0.0' },
      parse_snapshot: { snapshot_id: request.parse_snapshot_id, response_sha256: request.parse_response_sha256,
        parser_version: request.parser_version, material_id: request.material_id, material_version: request.material_version,
        content_sha256: request.material_sha256 },
      facts: [{ extraction_id: `synthetic-${request.material_id}`, identity: { scope: 'consolidated', metric: 'operating_revenue',
        period: { start: '2024-01-01', end: '2024-12-31' }, currency: 'CNY', unit: 'yuan', basis: 'reported_financial_statement' },
        value: { kind: 'known', decimalOrText: '1' }, source_kind: request.material_id === multiB.material_id ? 'external' : 'audited', confidence: 1, uncertainty: [],
        evidence_refs: [request.records[0]!.record_id] }], needs_review: [],
    }) };
    const seenMaterials: string[] = [];
    let failSecond = true;
    const multiStage = createMaterialsReadyStage(async context => {
      seenMaterials.push(context.materialId);
      if (failSecond && context.materialId === pinnedFinancial[1]!.material_id) throw new Error('SYNTHETIC_PRODUCER_UNAVAILABLE');
      return produceParsedFactCandidates({ pool, extractor: multiExtractor }, context);
    });
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: multiStage }) }), 'retry');
    assert.deepEqual(seenMaterials, pinnedFinancial.map(ref => ref.material_id));
    assert.equal((await runRow(multiRun)).checkpoint.stages.materials_ready, undefined);
    assert.deepEqual(await attempts((await runRow(multiRun)).job_id), []);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'", [multiRun])).rows[0].n, 0);
    assert.ok((await pool.query("SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1", [multiRun])).rows.some(row => row.reason === 'material_fact_stage_failed'));
    assert.ok((await pool.query("SELECT payload->>'reason' AS reason FROM bb_outbox WHERE aggregate_type='run' AND aggregate_id=$1 AND event_type='run.progress'", [multiRun])).rows.some(row => row.reason === 'material_fact_stage_failed'));
    failSecond = false;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: multiStage }) }), 'succeeded');
    assert.deepEqual(seenMaterials, [...pinnedFinancial.map(ref => ref.material_id), ...pinnedFinancial.map(ref => ref.material_id)]);
    assert.deepEqual((await runRow(multiRun)).checkpoint.stages.materials_ready.extractions.map((item: { material_id: string }) => item.material_id),
      pinnedFinancial.map(ref => ref.material_id));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='fact.extraction.completed'", [alice, multiProject])).rows[0].n, 2);

    const legacyOrderedRun = (await execute(multiInput)).json().run_id as string;
    const orderedMaterials = (await runRow(multiRun)).checkpoint.stages.materials_ready.materials as typeof legacyMaterials;
    await seedLegacyCheckpoint(legacyOrderedRun, [...orderedMaterials].reverse());
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages({ materials: multiStage }) }), 'paused');
    assert.deepEqual((await runRow(legacyOrderedRun)).checkpoint.stages.materials_ready, { materials: [...orderedMaterials].reverse() });
    assert.equal((await pool.query("SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1", [legacyOrderedRun])).rows[0].reason,
      'fact_extraction_checkpoint_mismatch');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'", [legacyOrderedRun])).rows[0].n, 0);
    assert.equal((await send('POST', `/api/v1/runs/${legacyOrderedRun}/cancel`, { reason: 'synthetic cleanup' })).statusCode, 200);

    // 9. Graceful shutdown: in-flight work past the drain window is aborted and its lease released at once.
    const p8 = await project('shutdown');
    const shutdownRun = (await execute(p8)).json().run_id as string;
    let blockEntered!: () => void;
    const blocked = new Promise<void>(resolve => { blockEntered = resolve; });
    const blocking: RunStage = { name: 'word_delivery', run: async ctx => { blockEntered(); await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true })); throw new Error('SYNTHETIC_ABORTED'); } };
    const live = new WorkerRuntime({ pool, blobs, runStages: stages({ word: blocking }), kinds: ['run'], concurrency: 2, pollMs: 50, sweepMs: 60000, drainMs: 200 }).start();
    await blocked;
    await live.stop();
    row = await runRow(shutdownRun);
    assert.equal(row.job_state, 'running'); assert.ok(new Date(row.lease_until ?? (await pool.query('SELECT lease_until FROM bb_jobs WHERE id=$1', [row.job_id])).rows[0].lease_until) <= new Date(), 'lease released');
    assert.equal(await runPipelineOnce({ pool, blobs, stages: stages() }), 'succeeded', 'another worker resumes immediately from the checkpoint');
    const shutdownReasons = (await pool.query("SELECT payload->>'reason' r FROM bb_run_events WHERE run_id=$1 ORDER BY seq", [shutdownRun])).rows.map(r => r.r);
    assert.ok(shutdownReasons.includes('lease_released') && shutdownReasons.includes('lease_recovered'), shutdownReasons.join(','));
    assert.deepEqual(await attempts(row.job_id), [[1, 'completed']], 'the resumed worker reused the model result');

    // 10. Rejections before a run exists: runtime disabled (501) and a stale input hash (409).
    const p9 = await project('reject');
    const rejected501 = await execute(p9, `rej-${randomUUID()}`, closedApp);
    assert.equal(rejected501.statusCode, 501);
    const rejected409 = await execute({ ...p9, inputHash: 'f'.repeat(64) });
    assert.equal(rejected409.statusCode, 409);

    // 11. Timeline completeness for every terminal kind through the #79 admin API.
    const jobOf = async (id: string) => (await runRow(id)).job_id as string;
    const succeededTl = await adminJobTimeline(pool, operator, await jobOf(runId));
    assert.equal(succeededTl.outcome.state, 'succeeded'); assert.equal(succeededTl.outcome.artifact_available, true);
    assert.ok(succeededTl.attempts.length === 1 && succeededTl.prompts.length === 1 && succeededTl.stages.some(s => s.reason === 'lease_recovered'));
    const failedTl = await adminJobTimeline(pool, operator, await jobOf(failedRun));
    assert.equal(failedTl.outcome.state, 'failed'); assert.equal(failedTl.outcome.error_code, 'DELIVERY_FAILED'); assert.equal(failedTl.outcome.artifact_available, false);
    assert.ok(failedTl.errors.some(e => e.code === 'DELIVERY_FAILED' && e.category === 'delivery' && e.stage === 'word_delivery'));
    const cancelledTl = await adminJobTimeline(pool, operator, await jobOf(race2));
    assert.equal(cancelledTl.outcome.state, 'cancelled'); assert.ok(cancelledTl.stages.some(s => s.reason === 'user_cancelled'));
    const recoveredTl = await adminJobTimeline(pool, operator, await jobOf(unknownRun));
    assert.deepEqual(recoveredTl.stages.filter(s => ['provider_reconciliation_required', 'provider_call_reconciled', 'provider_reconciled'].includes(s.reason ?? '')).map(s => s.reason), ['provider_reconciliation_required', 'provider_call_reconciled', 'provider_reconciled']);
    assert.equal(recoveredTl.outcome.state, 'succeeded');
    // A completed first call is durable when the next intent is blocked. Neither pause creates
    // a provider attempt nor consumes the lease retry budget; the sweep resumes after relief.
    await grantOperator(pool, { userId: operator, role: 'log_operator', grantedBy: 'synthetic-test', reasonCode: 'runtime_test' });
    const secondModel = codexModelStage({ name: 'second_model_generation', logicalCallId: 'second-update-generation', config, schema,
      validate: isAnswer, resultSchemaVersion: 'answer-v1', buildPrompt: async ctx => `SYNTHETIC second prompt for run ${ctx.run.id}. SCENARIO:structured` });
    const twoCalls = [syntheticInputLockStage, materialsReadyStage, model(), secondModel, word()];
    const trialConfig = { ...trialConfigFromEnv({}), enabled: true, model_tokens_per_user_per_day: 1 };
    const trialProject = await project('trial limit runtime');
    const quotaRun = (await execute(trialProject)).json().run_id as string;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: twoCalls, afterStage: async stage => {
      if (stage === 'model_generation') configureTrialGuard(trialConfig);
    } }), 'paused');
    const quotaRow = await runRow(quotaRun);
    assert.equal(quotaRow.state, 'paused'); assert.equal(quotaRow.job_stage, 'trial_limit');
    assert.equal(quotaRow.checkpoint.stages.model_generation !== undefined, true);
    assert.deepEqual(await attempts(quotaRow.job_id), [[1, 'completed']], 'blocked intent creates no provider attempt');
    assert.equal((await pool.query('SELECT attempts FROM bb_jobs WHERE id=$1', [quotaRow.job_id])).rows[0].attempts, 1);
    const quotaEvent = (await pool.query("SELECT payload FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1", [quotaRun])).rows[0].payload;
    assert.deepEqual([quotaEvent.reason, quotaEvent.error_code], ['model_tokens_per_user_per_day', 'TRIAL_QUOTA_EXCEEDED']);
    assert.equal((await send('POST', `/api/v1/runs/${quotaRun}/resume`, { reason: 'synthetic' })).statusCode, 429);
    const trialRuntime = new WorkerRuntime({ pool, blobs, runStages: twoCalls });
    await trialRuntime.sweep();
    assert.equal((await runRow(quotaRun)).state, 'paused');
    await createOverride(pool, operator, { user_id: alice, effect: 'allow', reason_code: 'synthetic_trial_relief' });
    await trialRuntime.sweep();
    assert.equal(await runPipelineOnce({ pool, blobs, stages: twoCalls }), 'succeeded');
    assert.deepEqual(await attempts(quotaRow.job_id), [[1, 'completed'], [1, 'completed']], 'first call is reused; only the next call is sent');
    assert.equal((await runRow(quotaRun)).state, 'succeeded');

    const killRun = (await execute(trialProject)).json().run_id as string;
    assert.equal(await runPipelineOnce({ pool, blobs, stages: twoCalls, afterStage: async stage => {
      if (stage === 'model_generation') await setKillSwitch(pool, trialConfig, operator, 'engaged', 'synthetic_trial_pause');
    } }), 'paused');
    const killRow = await runRow(killRun);
    const killEvent = (await pool.query("SELECT payload FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1", [killRun])).rows[0].payload;
    assert.deepEqual([killEvent.reason, killEvent.error_code], ['kill_switch', 'MODEL_CALLS_SUSPENDED']);
    assert.deepEqual(await attempts(killRow.job_id), [[1, 'completed']]);
    await trialRuntime.sweep(); assert.equal((await runRow(killRun)).state, 'paused');
    await setKillSwitch(pool, trialConfig, operator, 'released', 'synthetic_trial_resume');
    await trialRuntime.sweep();
    assert.equal(await runPipelineOnce({ pool, blobs, stages: twoCalls }), 'succeeded');
    assert.deepEqual(await attempts(killRow.job_id), [[1, 'completed'], [1, 'completed']]);

    const denyRun = (await execute(trialProject)).json().run_id as string;
    const denyOverride = await createOverride(pool, operator, { user_id: alice, effect: 'deny', reason_code: 'synthetic_trial_deny' });
    assert.equal(await runPipelineOnce({ pool, blobs, stages: twoCalls }), 'failed');
    const denyRow = await runRow(denyRun);
    assert.equal(denyRow.job_error, 'TRIAL_ACCESS_DENIED');
    assert.equal((await pool.query('SELECT attempts FROM bb_jobs WHERE id=$1', [denyRow.job_id])).rows[0].attempts, 1);
    assert.deepEqual(await attempts(denyRow.job_id), []);
    const denyEvent = (await pool.query("SELECT payload FROM bb_run_events WHERE run_id=$1 AND state='failed' ORDER BY seq DESC LIMIT 1", [denyRun])).rows[0].payload;
    assert.equal(denyEvent.error_code, 'TRIAL_ACCESS_DENIED');
    await revokeOverride(pool, operator, denyOverride.override_id, 'synthetic_trial_done');
    configureTrialGuard(null);
    const unexpectedRun = (await execute(trialProject)).json().run_id as string;
    const unexpectedStage: RunStage = { name: 'model_generation', run: async () => { throw new Error('synthetic_unexpected'); } };
    const unexpectedStages = [syntheticInputLockStage, materialsReadyStage, unexpectedStage, word()];
    assert.equal(await runPipelineOnce({ pool, blobs, stages: unexpectedStages, maxAttempts: 2 }), 'retry');
    assert.equal(await runPipelineOnce({ pool, blobs, stages: unexpectedStages, maxAttempts: 2 }), 'failed');
    const unexpectedRow = await runRow(unexpectedRun);
    assert.equal(unexpectedRow.job_error, 'DATA_UNAVAILABLE');
    assert.equal((await pool.query('SELECT attempts FROM bb_jobs WHERE id=$1', [unexpectedRow.job_id])).rows[0].attempts, 2);
    const rejectedEvents = await adminEvents(pool, operator, parseAdminFilter({ project_id: p9.projectId }));
    const rejections = rejectedEvents.items.filter(e => e.kind === 'operation.rejected').map(e => e.error_code).sort();
    assert.deepEqual(rejections, ['CAPABILITY_NOT_READY', 'INPUT_REVISION_CONFLICT'], 'rejections before any run are queryable');
    const terminalKinds = new Set((await pool.query("SELECT event->>'status' s FROM bb_observability_events WHERE owner_user_id=$1 AND kind='job.state_changed'", [alice])).rows.map(r => r.s));
    for (const kind of ['succeeded', 'failed', 'cancelled', 'paused', 'running', 'queued']) assert.ok(terminalKinds.has(kind), `job.state_changed ${kind}`);

    // 12. A log sink outage never drops a terminal state: rows stay pending and replay once the sink recovers.
    const down = await forwardLogs(pool, { name: 'synthetic_down', deliver: async () => { throw new Error('down'); } }, { batchSize: 1000, retrySeconds: 0 });
    assert.ok(down.failed > 0 && down.delivered === 0);
    const pendingTerminal = (await pool.query(`SELECT count(*)::int n FROM bb_outbox o JOIN bb_observability_events e ON e.id=o.aggregate_id
      WHERE o.aggregate_type='observability' AND o.delivered_at IS NULL AND e.kind='job.state_changed' AND e.event->>'status' IN ('succeeded','failed','cancelled')`)).rows[0].n;
    assert.ok(pendingTerminal >= 4, 'terminal events are still pending after the outage');
    const delivered: LogRecord[] = [];
    await pool.query('UPDATE bb_outbox SET next_attempt_at=NULL WHERE aggregate_type=\'observability\' AND delivered_at IS NULL');
    for (let i = 0; i < 20; i++) { const r = await forwardLogs(pool, { name: 'synthetic_up', deliver: async records => { delivered.push(...records); } }, { batchSize: 1000 }); if (!r.claimed) break; }
    assert.ok(delivered.filter(r => r.event.kind === 'job.state_changed' && ['succeeded', 'failed', 'cancelled'].includes(String(r.event.status))).length >= pendingTerminal);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n, 0);

    // 13. OCR hook: an image pauses at awaiting_ocr without OCR; once OCR is configured the job resumes
    //     through the checkpointed ocr_evidence stage and ends as needs_confirmation, never confirmed.
    const ocrProject = (await send('POST', '/api/v1/projects', { name: 'Synthetic runtime OCR', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id as string;
    const png = await upload(ocrProject, PNG_BYTES, 'image/png', 'other', 'synthetic.png');
    assert.equal(await runMaterialParseOnce(parseDeps), 'paused');
    const unavailable = async () => { throw new Error('OCR_PROCESS_UNAVAILABLE'); };
    assert.equal(await requeueAwaitingOcrParseJobs(pool), 1);
    assert.equal(await runMaterialParseOnce({ ...parseDeps, ocr: unavailable }), 'paused', 'no OCR engine installed -> explicit pending, not failure');
    let ocrJob = (await pool.query("SELECT * FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [png.material_id])).rows[0];
    assert.equal(ocrJob.stage, 'awaiting_ocr');
    assert.equal(await requeueAwaitingOcrParseJobs(pool), 1);
    const ocrCalls: string[] = [];
    const syntheticOcr = async (input: { requestId: string }) => { ocrCalls.push(input.requestId); return { snapshot_id: `synthetic-ocr-${randomUUID()}` }; };
    assert.equal(await runMaterialParseOnce({ ...parseDeps, ocr: syntheticOcr, afterStage: async stage => { if (stage === 'ocr_evidence' && ocrCalls.length === 1) throw new Error('SYNTHETIC_CRASH'); } }).catch(e => e.message), 'SYNTHETIC_CRASH');
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [ocrJob.id]);
    assert.equal(await runMaterialParseOnce({ ...parseDeps, ocr: syntheticOcr }), 'succeeded');
    assert.equal(ocrCalls.length, 1, 'the checkpointed OCR stage is not re-run after a crash');
    ocrJob = (await pool.query("SELECT * FROM bb_jobs WHERE id=$1", [ocrJob.id])).rows[0];
    assert.equal(ocrJob.result.outcome, 'needs_confirmation'); assert.deepEqual(ocrJob.result.pending_capabilities, []);
    assert.ok(ocrJob.checkpoint.stages.ocr_evidence.snapshot_id);
    const ocrTypes = (await pool.query('SELECT type FROM bb_job_events WHERE job_id=$1 ORDER BY seq', [ocrJob.id])).rows.map(r => r.type);
    assert.deepEqual(ocrTypes.filter(t => t === 'material_parse.resumed').length, 2);

    // 14. Legacy backfill: a verified material without a parse job gets exactly one, idempotently.
    const legacyProject = (await send('POST', '/api/v1/projects', { name: 'Synthetic runtime legacy', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id as string;
    const legacy = await upload(legacyProject, Buffer.from(`legacy ${randomUUID()}`), 'text/plain', 'audit', 'legacy.txt');
    // Simulate a pre-0020 material (test clone only): remove its job with triggers/FK checks off for one session.
    const legacyClient = await pool.connect();
    try {
      await legacyClient.query('SET session_replication_role = replica');
      await legacyClient.query("DELETE FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [legacy.material_id]);
      await legacyClient.query('SET session_replication_role = DEFAULT');
    } finally { legacyClient.release(); }
    const dry = await backfillParseJobs(pool, { dryRun: true });
    assert.equal(dry.scanned, 1); assert.equal(dry.enqueued, 0);
    const first = await backfillParseJobs(pool);
    assert.deepEqual([first.scanned, first.enqueued], [1, 1]);
    const again = await backfillParseJobs(pool);
    assert.deepEqual([again.scanned, again.enqueued], [0, 0], 'idempotent');
    const legacyJob = await claimMaterialParse(pool, 30);
    assert.equal(legacyJob?.materialId, legacy.material_id);
  } finally {
    configureTrialGuard(null);
    await app.close(); await closedApp.close();
    await rm(root, { recursive: true, force: true });
    await pool.end();
  }
});
