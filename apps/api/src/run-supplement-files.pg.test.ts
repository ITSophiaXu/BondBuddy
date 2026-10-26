// Synthetic private file bytes; real PostgreSQL, durable model history and HTTP auth/CSRF.
// These tests verify file authority and byte identity, not generated Word quality.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { ReviewDraftInputSchema, ReviewExecutionOriginSchema, ReviewExportRequestSchema, type ReviewMaterialPin } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { creditBalance, grantCredits } from './billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { saveSnapshotRef } from './observability.js';
import { checkpointStage, claim, pauseAtCheckpoint, recordPotentialCall } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import {
  listCapturedSupplementFiles, readCapturedSupplementFile,
  type CapturedSupplementFilePin, type CapturedSupplementFileSource,
} from './run-supplement-files.js';

const connection = await isolatedTestDatabase(undefined, 'run-supplement-files');
const origin = 'http://bondbuddy.test', schema = 'codex-file-word-v1';
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ok = (response: { statusCode: number; body: string; json(): any }) => {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  return response.json();
};
const denied = (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT';

async function context() {
  const pool = new Pool({ connectionString: connection }), owner = `saved-files-${uid()}`;
  const objects = new Map<string, Buffer>(), reads: Array<{ key: string; limit: number }> = [];
  let writes = 0, deletes = 0;
  const blobs: PrivateBlobs = {
    put: async (key, bytes) => { writes++; objects.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = objects.get(key); assert.ok(bytes, `Missing synthetic object ${key}`); return Buffer.from(bytes); },
    getIfExists: async key => { const bytes = objects.get(key); return bytes ? Buffer.from(bytes) : null; },
    getIfExistsBounded: async (key, limit) => {
      reads.push({ key, limit });
      const bytes = objects.get(key);
      if (bytes && bytes.length > limit) throw Error('Synthetic bounded file read refused');
      return bytes ? Buffer.from(bytes) : null;
    },
    exists: async key => objects.has(key),
    delete: async key => { deletes++; objects.delete(key); },
  };
  const app = createServer({ pool, blobs, allowedOrigin: origin, enableSyntheticQueue: true });
  const session = async (user: string) => {
    const access = uid(), csrf = uid();
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [user, `saved_files_${uid().replaceAll('-', '').slice(0, 20)}`]);
    await pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`, [uid(), user, digest(access), digest(uid()), digest(csrf)]);
    return { cookie: `bb_session=${access}; bb_csrf=${csrf}`, 'x-bb-csrf': csrf, origin };
  };
  const headers = await session(owner);
  await transaction(pool, db => grantCredits(db, { owner, points: 10000, key: `synthetic-${uid()}`,
    source: 'existing_grant', expiresAt: null, actor: 'synthetic-test', reason: 'Verify free supplement file inspection leaves billing unchanged' }));
  const send = (method: string, url: string, payload?: unknown, customHeaders: Record<string, string> = headers) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: customHeaders });
  const material = async (projectId: string): Promise<ReviewMaterialPin> => {
    const id = uid(), uploadId = uid(), bytes = Buffer.from(`Synthetic supplement material ${id}`), sha256 = digest(bytes);
    const uploadKey = `users/${owner}/projects/${projectId}/synthetic/uploads/${uploadId}`;
    const key = `users/${owner}/projects/${projectId}/synthetic/materials/${id}`;
    await blobs.put(key, bytes, 'application/pdf');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic-supplement.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')`,
    [uploadId, owner, projectId, bytes.length, sha256, uploadKey]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'other','synthetic-supplement.pdf','application/pdf',$5,$6,$7,'persisted')`,
    [id, owner, projectId, uploadId, bytes.length, sha256, key]);
    return { material_id: id, material_version: 1, sha256 };
  };

  const fixture = async (options: { wrongAttemptPath?: boolean; innerVersion?: string } = {}) => {
    const projectId = uid(), runId = uid(), jobId = uid();
    const manifest = { draft_revision: 1, issuer_name: 'Synthetic frozen file issuer', market: 'sse', offering: 'private',
      update_details: { reporting_cutoff: '2026-09-30' }, goals: ['Frozen file goal'], requirements: ['Frozen file requirement'],
      materials: [], rule_pack_version: 'frozen-rules', template_version: 'frozen-template', reference_release: 'frozen-reference' };
    const hash = inputManifestHash(manifest);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'Synthetic captured files','update','Synthetic frozen file issuer')", [projectId, owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,
      material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
      VALUES($1,1,$2,1,$3,$4,'[]','[]','frozen-rules','frozen-template','frozen-reference')`, [projectId, owner, hash, manifest]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued')`, [runId, owner, projectId, hash, uid(), digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'update','default','queued','queued')`, [jobId, owner, runId]);
    const lease = await claim(pool, 300, { runKinds: ['update'] });
    assert.ok(lease); assert.equal(lease.runId, runId); assert.equal(lease.jobId, jobId);
    const promptBytes = Buffer.from(JSON.stringify({ version: 'synthetic-file-prompt-v1', input_hash: hash }));
    const promptKey = `users/${owner}/projects/${projectId}/snapshots/${uid()}`;
    await blobs.put(promptKey, promptBytes, 'application/json');
    const promptId = await saveSnapshotRef(pool, { owner, projectId, runId, kind: 'model_request', version: 1,
      objectKey: promptKey, sha256: digest(promptBytes), redactionVersion: 'synthetic_v1', inputRevision: 1, inputHash: hash, blobs });
    await checkpointStage(pool, lease, 'file_authoring_v1_prompt', { snapshot_id: promptId });
    const intent: ProviderCallIntent = { owner_user_id: owner, project_id: projectId, run_id: runId, trace_id: runId,
      job_id: jobId, logical_call_id: 'file-authoring-v1', call_id: uid(), attempt_no: 1,
      model_id: 'synthetic-model', model_config_version: 'synthetic-v1', prompt_snapshot_ref: promptId };
    await recordPotentialCall(pool, lease, intent.logical_call_id, 1,
      { callId: intent.call_id, modelId: intent.model_id, promptSnapshotId: promptId });
    const fileBytes = new Map<string, Buffer>(), files: Record<string, { key: string; sha256: string; byte_size: number }> = {};
    for (const name of ['tracked.docx', 'clean.docx', 'baseline.docx', 'delivery.md']) {
      const bytes = Buffer.from(`Synthetic private ${name} for ${runId}`), sha256 = digest(bytes);
      const attempt = options.wrongAttemptPath ? uid() : intent.call_id;
      const key = `owners/${owner}/projects/${projectId}/runs/${runId}/file-authoring/${attempt}/${sha256}/${name}`;
      await blobs.put(key, bytes, name.endsWith('.docx') ? docx : 'text/markdown');
      fileBytes.set(name, bytes); files[name] = { key, sha256, byte_size: bytes.length };
    }
    const value = { version: options.innerVersion ?? schema, input_hash: hash, files, summary: { authoring_summary: ['Synthetic saved work'] } };
    // Negative fixtures deliberately preserve malformed nested refs in an otherwise
    // exact durable result, so the new file reader must enforce its own authority.
    const validate = (candidate: unknown) => !!candidate && typeof candidate === 'object'
      && (candidate as typeof value).input_hash === hash && !!(candidate as typeof value).files;
    const reference = await persistProviderResultObject({ blobs, intent, bytes: Buffer.from(JSON.stringify(value)), resultSchemaVersion: schema, validate });
    const observed = await recordProviderCallObservation(pool, blobs, { ...intent, ...reference,
      provider_request_id: null, finish_reason: 'stop', outcome: 'completed', error_code: null,
      usage: { status: 'measured', input_tokens: 19, cached_input_tokens: 0, output_tokens: 11, reasoning_tokens: 0, total_tokens: 30 },
    }, validate, { lease, source: 'provider' });
    assert.equal(observed.attempt_status, 'completed');
    const result = (await pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1', [intent.call_id])).rows[0];
    assert.ok(result);
    await checkpointStage(pool, lease, 'model_generation', { logical_call_id: intent.logical_call_id, prompt_snapshot_ref: promptId });
    ok(await send('POST', `/api/v1/runs/${runId}/pause`, { reason: 'Synthetic private-file boundary' }));
    assert.equal(await pauseAtCheckpoint(pool, lease), true);
    const checkpoint = (await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [jobId])).rows[0].checkpoint;
    const source: CapturedSupplementFileSource = { kind: 'provider_result', resultId: result.id, resultSchemaVersion: schema };
    const url = `/api/v1/runs/${runId}/supplement-draft`;
    const request = (expected_revision = 0) => ({ request_id: uid(), expected_revision, base_input_revision: 1, base_input_hash: hash, changes: [] });
    return { projectId, runId, jobId, hash, intent, promptId, promptKey, result, reference, value, files, fileBytes, checkpoint, source, url, request };
  };
  type LocalCorrectionDefect = 'missing_execution' | 'execution_version' | 'execution_operation' | 'snapshot_input'
    | 'snapshot_origin' | 'missing_export_only' | 'false_export_only' | 'snapshot_source_run' | 'missing_export'
    | 'invalid_export_hash' | 'self_source_run' | 'source_not_in_manifest';
  const localCorrectionFixture = async (options: { defect?: LocalCorrectionDefect } = {}) => {
    const projectId = uid(), runId = uid(), jobId = uid(), sourceRunId = uid();
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'Synthetic captured local correction','review','Synthetic correction issuer')", [projectId, owner]);
    const basePin = await material(projectId);
    const sourcePin = options.defect === 'source_not_in_manifest' ? await material(projectId) : basePin;
    const reviewInput = { source_material_ref: sourcePin, material_versions: [sourcePin], requirements: ['Synthetic frozen correction requirement'], as_of: '2026-09-30' };
    const reviewOrigin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
    const exported = { source_run_id: sourceRunId, editor_sha256: digest('Synthetic frozen correction editor'), decisions: [] };
    assert.ok(Value.Check(ReviewDraftInputSchema, reviewInput)); assert.ok(Value.Check(ReviewExecutionOriginSchema, reviewOrigin));
    assert.ok(Value.Check(ReviewExportRequestSchema, { request_id: uid(), source_run_id: exported.source_run_id,
      expected_editor_sha256: exported.editor_sha256, decisions: exported.decisions }));
    assert.notEqual(sourceRunId, runId);
    const manifest: Record<string, any> = { draft_revision: 1, project_kind: 'review', issuer_name: 'Synthetic correction issuer',
      materials: [{ ...basePin, role: 'other' }], review: { version: 'review_v1', operation: 'full_review', version_number: 1,
        input: reviewInput, origin: reviewOrigin, finding_ids: [], file_delivery: { version: 'review-correction-v2', knowledge: [], export: exported } } };
    const snapshot: Record<string, any> = { input: structuredClone(reviewInput), origin: structuredClone(reviewOrigin),
      export_only: true, source_run_id: sourceRunId };
    // Every mismatch is seeded before immutable input/execution insertion. A
    // receipt that frozenBase permits still cannot supply missing file authority.
    if (options.defect === 'snapshot_input') snapshot.input.requirements = ['Different frozen correction requirement'];
    if (options.defect === 'snapshot_origin') snapshot.origin = null;
    if (options.defect === 'missing_export_only') delete snapshot.export_only;
    if (options.defect === 'false_export_only') snapshot.export_only = false;
    if (options.defect === 'snapshot_source_run') snapshot.source_run_id = uid();
    if (options.defect === 'missing_export') delete manifest.review.file_delivery.export;
    if (options.defect === 'invalid_export_hash') manifest.review.file_delivery.export.editor_sha256 = 'invalid-editor-sha256';
    if (options.defect === 'self_source_run') {
      manifest.review.file_delivery.export.source_run_id = runId; snapshot.source_run_id = runId;
    }
    const hash = inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [projectId, owner, hash, manifest, JSON.stringify(manifest.materials)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,'review',$6,'queued','queued')`, [runId, owner, projectId, hash, uid(), digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'review','default','queued','queued')`, [jobId, owner, runId]);
    if (options.defect !== 'missing_execution') await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
      VALUES($1,$2,$3,$4,$5,$6)`, [runId, owner, projectId, options.defect === 'execution_version' ? 2 : 1,
      options.defect === 'execution_operation' ? 'differential_review' : 'full_review', snapshot]);
    const lease = await claim(pool, 300, { runKinds: ['review'] });
    assert.ok(lease); assert.equal(lease.runId, runId); assert.equal(lease.jobId, jobId);
    const fileBytes = new Map<string, Buffer>(), files: Record<string, { key: string; sha256: string; byte_size: number }> = {};
    for (const name of ['revision.docx', 'clean.docx', 'baseline.docx', 'report.docx', 'report.md', 'editor.json']) {
      const bytes = Buffer.from(`Synthetic local correction ${name} for ${runId}`), sha256 = digest(bytes);
      const key = `owners/${owner}/projects/${projectId}/runs/${runId}/review-files/correction/${sha256}/${name}`;
      await blobs.put(key, bytes, name.endsWith('.docx') ? docx : name.endsWith('.json') ? 'application/json' : 'text/markdown');
      fileBytes.set(name, bytes); files[name] = { key, sha256, byte_size: bytes.length };
    }
    const value = { version: 'codex-review-file-v1', input_hash: hash, files };
    await checkpointStage(pool, lease, 'model_generation', { correction_result: value });
    ok(await send('POST', `/api/v1/runs/${runId}/pause`, { reason: 'Synthetic local correction boundary' }));
    assert.equal(await pauseAtCheckpoint(pool, lease), true);
    const checkpoint = (await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [jobId])).rows[0].checkpoint;
    const source: CapturedSupplementFileSource = { kind: 'checkpoint', field: 'correction_result' };
    const expectedPins: CapturedSupplementFilePin[] = Object.entries(files).map(([name, file]) => ({
      version: 'captured-supplement-file-v1', owner, projectId, runId, revision: 1, executionVersion: 1,
      inputRevision: 1, inputHash: hash, checkpointHash: inputManifestHash(checkpoint), sourceHash: inputManifestHash(value),
      source, name, key: file.key, sha256: file.sha256, byteSize: file.byte_size,
      mediaType: name.endsWith('.docx') ? docx : name.endsWith('.json') ? 'application/json' : 'text/markdown',
    }));
    const url = `/api/v1/runs/${runId}/supplement-draft`;
    const request = () => ({ request_id: uid(), expected_revision: 0, base_input_revision: 1, base_input_hash: hash, changes: [] });
    return { projectId, runId, jobId, hash, sourceRunId, basePin, manifest, snapshot, value, checkpoint, files, fileBytes, source, expectedPins, url, request };
  };
  type FileScope = { projectId: string; runId: string; source: CapturedSupplementFileSource };
  type ListInput = Parameters<typeof listCapturedSupplementFiles>[0];
  const scope = (f: FileScope, overrides: Partial<ListInput> = {}): ListInput => ({ db: pool, blobs, owner,
    projectId: f.projectId, runId: f.runId, revision: 1, source: f.source, ...overrides });
  const list = (f: FileScope, overrides: Partial<ListInput> = {}) => listCapturedSupplementFiles(scope(f, overrides));
  const read = (f: FileScope, pin: CapturedSupplementFilePin, overrides: Partial<ListInput> = {}) => readCapturedSupplementFile({ ...scope(f, overrides), pin });
  const evidence = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['bb_runs', 'bb_run_execution_versions', 'bb_jobs', 'bb_input_revisions', 'bb_material_versions', 'bb_model_call_attempts', 'bb_model_call_execution_bindings',
      'bb_provider_result_refs', 'bb_provider_call_observations', 'bb_usage_observations', 'bb_snapshot_refs',
      'bb_run_supplement_drafts', 'bb_run_supplement_saved_work', 'bb_run_supplement_saved_results',
      'bb_credit_events', 'bb_credit_lots', 'bb_credit_accounts', 'bb_credit_reservations', 'bb_artifact_versions', 'bb_artifact_download_grants',
      'bb_review_executions', 'bb_run_events', 'bb_outbox', 'bb_observability_events', 'bb_log_content_tombstones']) {
      result[table] = (await pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`, [owner])).rows;
    }
    result.usage = (await pool.query(`SELECT u.* FROM bb_call_usage u JOIN bb_model_call_attempts a ON a.id=u.attempt_id
      WHERE a.owner_user_id=$1 ORDER BY a.id`, [owner])).rows;
    result.balance = await creditBalance(pool, owner);
    result.storage = { writes, deletes, objects: [...objects].map(([key, bytes]) => [key, digest(bytes)]).sort() };
    return result;
  };
  return { pool, app, owner, headers, objects, reads, session, send, material, fixture, localCorrectionFixture, scope, list, read, evidence,
    close: async () => { await app.close(); await pool.end(); } };
}

test('HTTP capture exposes only counts while internal pins bind the exact provider output and read original private bytes', { skip: !connection }, async () => {
  const c = await context();
  try {
    const f = await c.fixture(), saved = ok(await c.send('PUT', f.url, f.request()));
    assert.equal(saved.adopted, false); assert.equal(saved.saved_work.result_count, 1);
    const publicResponse = JSON.stringify(saved);
    for (const hidden of [f.reference.result_ref, f.files['tracked.docx'].key, f.intent.call_id])
      assert.equal(publicResponse.includes(hidden), false, 'internal storage authority stays out of the HTTP receipt');
    const before = await c.evidence(), pins = await c.list(f);
    assert.deepEqual(pins.map(pin => pin.name).sort(), [...f.fileBytes.keys()].sort());
    for (const pin of pins) {
      assert.equal(pin.version, 'captured-supplement-file-v1'); assert.equal(pin.owner, c.owner);
      assert.equal(pin.projectId, f.projectId); assert.equal(pin.runId, f.runId); assert.equal(pin.revision, 1);
      assert.equal(pin.executionVersion, 1); assert.equal(pin.inputRevision, 1); assert.equal(pin.inputHash, f.hash);
      assert.equal(pin.checkpointHash, inputManifestHash(f.checkpoint)); assert.equal(pin.sourceHash, f.result.result_sha256.trim());
      assert.deepEqual(pin.source, f.source); assert.equal(pin.key, f.files[pin.name].key);
      assert.equal(pin.sha256, digest(f.fileBytes.get(pin.name)!)); assert.equal(pin.byteSize, f.fileBytes.get(pin.name)!.length);
      assert.equal(pin.mediaType, pin.name.endsWith('.docx') ? docx : 'text/markdown');
      assert.deepEqual(await c.read(f, pin), f.fileBytes.get(pin.name));
      assert.deepEqual(c.reads.at(-1), { key: pin.key, limit: pin.byteSize });
    }
    assert.deepEqual(await c.evidence(), before, 'listing and reading create no grants, writes, new calls or charges');
  } finally { await c.close(); }
});

test('captured private file authority rejects changed scopes, sources and every modified pin field', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(); ok(await c.send('PUT', f.url, f.request()));
    const pins = await c.list(f), pin = pins.find(value => value.name === 'tracked.docx')!; assert.ok(pin);
    const foreign = `foreign-files-${uid()}`, foreignHeaders = await c.session(foreign);
    assert.equal((await c.send('GET', f.url, undefined, foreignHeaders)).statusCode, 404);
    assert.equal((await c.send('PUT', f.url, f.request(1), { ...c.headers, 'x-bb-csrf': '' })).statusCode, 403);
    const unchangedReject = async (operation: () => Promise<unknown>) => {
      const before = await c.evidence(); await assert.rejects(operation(), denied); assert.deepEqual(await c.evidence(), before);
    };
    for (const [name, overrides] of [
      ['owner', { owner: foreign }], ['project', { projectId: uid() }], ['run', { runId: uid() }], ['revision', { revision: 99 }],
      ['source result', { source: { kind: 'provider_result', resultId: uid(), resultSchemaVersion: schema } }],
      ['source schema', { source: { kind: 'provider_result', resultId: f.result.id, resultSchemaVersion: 'codex-m4-document-v1' } }],
      ['unrelated checkpoint', { source: { kind: 'checkpoint', field: 'correction_result' } }],
    ] as Array<[string, Partial<Parameters<typeof listCapturedSupplementFiles>[0]>]>) await t.test(`wrong ${name}`, async () => {
      await unchangedReject(() => c.list(f, overrides)); await unchangedReject(() => c.read(f, pin, overrides));
    });
    for (const [name, patch] of [
      ['version', { version: 'captured-supplement-file-v2' }], ['owner', { owner: foreign }], ['projectId', { projectId: uid() }],
      ['runId', { runId: uid() }], ['revision', { revision: 2 }], ['executionVersion', { executionVersion: 2 }],
      ['inputRevision', { inputRevision: 2 }], ['inputHash', { inputHash: digest('other input') }],
      ['checkpointHash', { checkpointHash: digest('other checkpoint') }], ['sourceHash', { sourceHash: digest('other result') }],
      ['name', { name: 'clean.docx' }], ['hash', { sha256: digest('other file') }], ['size', { byteSize: pin.byteSize + 1 }],
      ['media', { mediaType: 'text/plain' }], ['key', { key: f.files['clean.docx'].key }],
      ['attempt path', { key: pin.key.replace(f.intent.call_id, uid()) }],
      ['source binding', { source: { kind: 'provider_result', resultId: uid(), resultSchemaVersion: schema } }],
    ] as Array<[string, Record<string, unknown>]>) await t.test(`modified pin ${name}`, () =>
      unchangedReject(() => c.read(f, { ...pin, ...patch } as CapturedSupplementFilePin)));
    const nextRequest = f.request(1); ok(await c.send('PUT', f.url, nextRequest));
    await unchangedReject(() => c.read(f, pin, { revision: 2 }));
    const newer = (await c.list(f, { revision: 2 })).find(value => value.name === pin.name)!;
    assert.equal(newer.revision, 2); assert.deepEqual(await c.read(f, newer, { revision: 2 }), f.fileBytes.get(pin.name));
  } finally { await c.close(); }
});

test('missing or damaged nested files do not block saving materials and cannot cause retries or mutations', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(), key = f.files['tracked.docx'].key, original = Buffer.from(f.fileBytes.get('tracked.docx')!);
    c.objects.delete(key);
    const added = await c.material(f.projectId), changes = [{ material: added, replaces: null }];
    const request = { ...f.request(), changes }, balance = await creditBalance(c.pool, c.owner);
    const saved = ok(await c.send('PUT', f.url, request));
    assert.equal(saved.revision, 1); assert.equal(saved.saved_work.status, 'captured');
    assert.equal(saved.adopted, false); assert.deepEqual(saved.changes, changes);
    assert.deepEqual(ok(await c.send('PUT', f.url, request)), saved);
    assert.deepEqual(await creditBalance(c.pool, c.owner), balance, 'saving real supplement metadata and replaying it are free');
    const pin = (await c.list(f)).find(value => value.name === 'tracked.docx')!; assert.ok(pin);
    const rejectWithoutChanges = async () => {
      const before = await c.evidence(); await assert.rejects(c.read(f, pin), denied); assert.deepEqual(await c.evidence(), before);
    };
    await t.test('missing nested Blob', rejectWithoutChanges);
    await t.test('same-size hash corruption', async () => {
      const corrupt = Buffer.from(original); corrupt[0] ^= 1; c.objects.set(key, corrupt); await rejectWithoutChanges();
    });
    await t.test('oversized nested Blob', async () => {
      c.objects.set(key, Buffer.concat([original, Buffer.from('excess')])); await rejectWithoutChanges();
    });
    await t.test('short nested Blob', async () => {
      c.objects.set(key, original.subarray(0, original.length - 1)); await rejectWithoutChanges();
    });
    c.objects.set(key, original);
    const before = await c.evidence(); assert.deepEqual(await c.read(f, pin), original); assert.deepEqual(await c.evidence(), before);
    for (const kind of ['provider_result', 'prompt_snapshot'] as const) await t.test(`${kind} tombstone denies retained nested bytes`, async () => {
      const target = kind === 'provider_result' ? f : await c.fixture();
      if (target !== f) ok(await c.send('PUT', target.url, target.request()));
      const targetPin = target === f ? pin : (await c.list(target)).find(value => value.name === 'tracked.docx')!;
      await c.pool.query(`INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version)
        VALUES($1,$2,$3,$4,$5,'retention_expired','synthetic-v1')`,
      [uid(), c.owner, kind, kind === 'provider_result' ? target.result.id : target.promptId,
        kind === 'provider_result' ? target.reference.result_ref : target.promptKey]);
      assert.ok(c.objects.has(targetPin.key));
      const before = await c.evidence(), fileReads = c.reads.filter(read => read.key.startsWith('owners/')).length;
      await assert.rejects(c.list(target), denied); await assert.rejects(c.read(target, targetPin), denied);
      assert.equal(c.reads.filter(read => read.key.startsWith('owners/')).length, fileReads);
      assert.deepEqual(await c.evidence(), before);
    });
  } finally { await c.close(); }
});

test('a durable JSON envelope cannot authorize another attempt directory or an incompatible collector version', { skip: !connection }, async t => {
  const c = await context();
  try {
    for (const [name, options] of [
      ['wrong attempt directory', { wrongAttemptPath: true }], ['wrong nested version', { innerVersion: 'codex-m4-document-v1' }],
    ] as Array<[string, Parameters<typeof c.fixture>[0]]>) await t.test(name, async () => {
      const f = await c.fixture(options), saved = ok(await c.send('PUT', f.url, f.request()));
      assert.equal(saved.revision, 1, 'bad private-file availability never discards the free material receipt');
      const before = await c.evidence(); await assert.rejects(c.list(f), denied); assert.deepEqual(await c.evidence(), before);
    });
  } finally { await c.close(); }
});

test('a real paused local correction captures six exact checkpoint files with zero provider results and no charges', { skip: !connection }, async () => {
  const c = await context();
  try {
    const f = await c.localCorrectionFixture(), beforeSave = await c.evidence(), request = f.request();
    const saved = ok(await c.send('PUT', f.url, request));
    assert.equal(saved.adopted, false); assert.deepEqual(saved.saved_work, { status: 'captured', stage_count: 1, result_count: 0 });
    assert.deepEqual(ok(await c.send('PUT', f.url, request)), saved);
    assert.deepEqual(ok(await c.send('GET', f.url)), saved);
    const afterSave = await c.evidence();
    for (const name of Object.keys(beforeSave)) if (!['bb_run_supplement_drafts', 'bb_run_supplement_saved_work', 'bb_outbox'].includes(name))
      assert.deepEqual(afterSave[name], beforeSave[name], `free capture preserves ${name}`);
    for (const table of ['bb_provider_result_refs', 'bb_snapshot_refs', 'bb_run_supplement_saved_results'])
      assert.equal((await c.pool.query(`SELECT count(*)::int AS n FROM ${table}
        WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3`, [c.owner, f.projectId, f.runId])).rows[0].n, 0,
        'deterministic local correction does not invent a prompt, model call or provider result');
    assert.equal((await c.pool.query(`SELECT count(*)::int AS n FROM bb_model_call_attempts a
      JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id
      WHERE a.owner_user_id=$1 AND a.job_id=$2 AND j.run_id=$3`, [c.owner, f.jobId, f.runId])).rows[0].n, 0,
    'deterministic local correction creates no model attempt for its exact original run/job');
    const captured = (await c.pool.query(`SELECT * FROM bb_run_supplement_saved_work
      WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND supplement_revision=1`, [c.owner, f.projectId, f.runId])).rows;
    assert.equal(captured.length, 1); assert.deepEqual(captured[0].source_checkpoint, f.checkpoint);
    assert.equal(captured[0].checkpoint_hash.trim(), inputManifestHash(f.checkpoint));
    const publicReceipt = JSON.stringify(saved);
    for (const file of Object.values(f.files)) assert.equal(publicReceipt.includes(file.key), false);
    const reads = c.reads.length, pins = await c.list(f);
    assert.equal(c.reads.length, reads, 'checkpoint listing reads no private file bytes');
    const byName = (values: CapturedSupplementFilePin[]) => [...values].sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(byName(pins), byName(f.expectedPins));
    assert.equal(pins.length, 6);
    for (const pin of pins) {
      assert.deepEqual(await c.read(f, pin), f.fileBytes.get(pin.name));
      assert.deepEqual(c.reads.at(-1), { key: pin.key, limit: pin.byteSize });
    }
    assert.deepEqual(await c.evidence(), afterSave, 'local file listing/reads do not mutate execution, capture, storage or ledger');
  } finally { await c.close(); }
});

test('checkpoint correction bytes require the exact review execution, export-only source and frozen source material', { skip: !connection }, async t => {
  const c = await context();
  try {
    const cases: Array<[NonNullable<Parameters<typeof c.localCorrectionFixture>[0]>['defect'], number]> = [
      ['missing_execution', 503], ['execution_version', 503], ['execution_operation', 503],
      ['snapshot_input', 503], ['snapshot_origin', 503],
      ['missing_export_only', 200], ['false_export_only', 200], ['snapshot_source_run', 200],
      ['missing_export', 200], ['invalid_export_hash', 200], ['self_source_run', 200], ['source_not_in_manifest', 200],
    ];
    for (const [defect, expectedStatus] of cases) await t.test(defect!, async () => {
      const f = await c.localCorrectionFixture({ defect }), beforeSave = await c.evidence();
      const response = await c.send('PUT', f.url, f.request());
      assert.equal(response.statusCode, expectedStatus, response.body);
      const afterSave = await c.evidence();
      if (expectedStatus === 200) {
        assert.deepEqual(ok(response).saved_work, { status: 'captured', stage_count: 1, result_count: 0 });
        for (const name of Object.keys(beforeSave)) if (!['bb_run_supplement_drafts', 'bb_run_supplement_saved_work', 'bb_outbox'].includes(name))
          assert.deepEqual(afterSave[name], beforeSave[name], `free malformed-source capture preserves ${name}`);
      } else assert.deepEqual(afterSave, beforeSave, 'frozen business-snapshot rejection creates no partial receipt or capture');
      assert.ok(c.objects.has(f.expectedPins[0].key), 'existing nested bytes alone supply no authority');
      const reads = c.reads.length;
      await assert.rejects(c.list(f), denied); await assert.rejects(c.read(f, f.expectedPins[0]), denied);
      assert.equal(c.reads.length, reads, 'business provenance is checked before reading any nested file');
      assert.deepEqual(await c.evidence(), afterSave, 'a refused local read cannot reconcile, retry, charge or mutate source history');
    });
  } finally { await c.close(); }
});
