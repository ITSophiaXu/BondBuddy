// OPT-IN M1 end-to-end synthetic acceptance (#33/#15/#76). This file proves the controlled test
// channel can actually advance the worker main chain instead of parking at the safe gates. Every
// identity, material and binding is synthetic; the model is the fake `codex exec` fixture and the
// Word bytes are the synthetic OOXML fixture, so no provider, no real customer material and no
// industry sign-off is claimed.
//
// The suite is opt-in: it skips (with a printed reason) unless a disposable, already-migrated,
// empty PostgreSQL 16 template, an Azurite connection and the #20 SSE-private candidate assets are
// supplied. The Word-marking scenario additionally needs python-docx/lxml and skips by itself when
// Python cannot import it. Nothing here changes production behavior, DTOs, enums, the run state
// machine or the database schema.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { OWNER_MATERIAL_SCOPE_SHA256 } from '@bondbuddy/api/non-production-test';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord,
} from '@bondbuddy/api/issuer-identity-source';
import {
  appendGenerationIssuerBinding,
  reviewGenerationIssuerBinding,
  type GenerationIssuerBindingDecisionInput,
} from '@bondbuddy/api/generation-issuer-binding';
import { DEFAULT_DISABLED_FEATURES, type CodexAdapterConfig } from './codex-adapter.js';
import {
  codexModelStage,
  inputLockStage,
  runPipelineOnce,
  wordDeliveryStage,
  type RunStage,
} from './run-pipeline.js';
import { loadPinnedApprovedGenerationIssuerBinding } from './generation-issuer-binding-loader.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { runGrantCommand } from './non-production-test-grants.js';
import { createSsePrivateTestRuleCapabilityLoader } from './sse-private-test-rule-capability.js';
import {
  loadSsePrivateCandidateAssets,
  SSE_PRIVATE_CANDIDATE_ASSET_PIN,
  SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT,
} from './sse-private-candidate-assets.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('BB_TEST_E2E_SYNTHETIC_DATABASE_URL');
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const pythonBin = process.env.BB_PYTHON_BIN ?? 'python3';
const wordPythonReady =
  spawnSync(pythonBin, ['-c', 'import lxml'], { stdio: 'ignore' }).status === 0;
const candidateAssetsReady = await loadSsePrivateCandidateAssets(SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT)
  .then(() => true)
  .catch(() => false);
const baseSkipReason = !databaseUrl
  ? 'set BB_TEST_DATABASE_URL (or BB_TEST_E2E_SYNTHETIC_DATABASE_URL) to a disposable, migrated, empty PostgreSQL 16 template'
  : !blobConnection
    ? 'set BB_TEST_AZURITE_CONNECTION_STRING to an Azurite instance'
    : !candidateAssetsReady
      ? 'the #20 SSE-private candidate assets are not installed under knowledge/exchange-bonds/drafts/sse-private'
      : false;
const wordSkipReason =
  baseSkipReason ||
  (wordPythonReady
    ? false
    : `${pythonBin} must import lxml (install python-docx); the test-channel Word marking runs in Python`);

const TEXT = 'text/plain';
const PDF = 'application/pdf';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const taxonomyHash = SSE_PRIVATE_CANDIDATE_ASSET_PIN.taxonomy.contentSha256;
const rulePackHash = SSE_PRIVATE_CANDIDATE_ASSET_PIN.rulePack.contentSha256;
const fakeCodex = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));

/** Structurally valid synthetic PDF (no JavaScript, no encryption) for the historical upload. */
function pdfSample(tag: string): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let document = `%PDF-1.4\n% synthetic ${tag}\n`;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(document, 'ascii'));
    document += object;
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'ascii');
}

type UploadedMaterial = { materialId: string; sha256: string };

function makeHarness(pool: Pool, blobs: ReturnType<typeof azureBlobs>, owner: string) {
  let active = owner;
  const app = createServer({
    pool,
    blobs,
    allowedOrigin: origin,
    principal: async () => ({ userId: active, csrfVerified: true }),
    enableSyntheticQueue: true,
  });
  const send = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as never,
      url,
      headers: {
        origin,
        ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
      },
      payload: payload as never,
    });
  const createProject = async (kind: 'update' | 'generation', name: string): Promise<string> => {
    const response = await send('POST', '/api/v1/projects', {
      name,
      kind,
      issuer_name: kind === 'update' ? null : 'Synthetic browser name',
      market: 'sse',
      offering: 'private',
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  /** Public upload completion path: declare, PUT the bytes, then complete. */
  const upload = async (
    projectId: string,
    role: string,
    label: string,
    bytes: Buffer,
    mediaType = TEXT,
    extension = 'txt',
  ): Promise<UploadedMaterial> => {
    const declaration = { byte_size: bytes.length, sha256: sha(bytes) };
    const created = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      ...declaration,
      filename: `${label}.${extension}`,
      media_type: mediaType,
      role,
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json();
    const put = await send('PUT', session.upload_url as string, bytes);
    assert.equal(put.statusCode, 204, put.body);
    const complete = await send(
      'POST',
      `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`,
      declaration,
    );
    assert.equal(complete.statusCode, 200, complete.body);
    return { materialId: complete.json().material_id as string, sha256: declaration.sha256 };
  };
  return {
    app,
    send,
    setActive: (userId: string) => {
      active = userId;
    },
    createProject,
    upload,
  };
}

/** Fixture: the real parser worker writes these rows; the API and #33 read them as immutable evidence. */
async function insertParseEvidence(
  pool: Pool,
  args: {
    owner: string;
    projectId: string;
    material: UploadedMaterial;
    label: string;
    quote: string;
    mediaType?: string;
  },
): Promise<{ snapshotId: string; recordId: string }> {
  const { owner, projectId, material, label, quote, mediaType = TEXT } = args;
  const snapshotId = randomUUID(),
    recordId = randomUUID(),
    parserVersion = documentParserVersion();
  const meta = {
    schema_version: 'document-parse-response-v1',
    request_id: `parse-${snapshotId}`,
    status: 'parsed',
    parser_version: parserVersion,
    material: {
      material_id: material.materialId,
      material_version: 1,
      media_type: mediaType,
      sha256: material.sha256,
    },
    warnings: [],
    document: { page_count: null },
    error: null,
  };
  await pool.query(
    `INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
    response_status,response_schema_version,response_sha256,record_count,response_meta)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
    [
      snapshotId,
      owner,
      projectId,
      material.materialId,
      material.sha256,
      parserVersion,
      sha(`request-${snapshotId}`),
      sha(`response-${snapshotId}`),
      JSON.stringify(meta),
    ],
  );
  await pool.query(
    `INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
    locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
    VALUES($1,$2,$3,1,$4,$5,$6,'text_line',$7::jsonb,$8,'synthetic e2e evidence','native_text',$9,1,'[]','{}',$10,0)`,
    [
      owner,
      projectId,
      material.materialId,
      snapshotId,
      recordId,
      material.sha256,
      JSON.stringify({ line: 1, stable_ref: `text:${label}` }),
      quote,
      parserVersion,
      sha(recordId),
    ],
  );
  // The public upload completion already enqueued the durable parse job; mark its fixture outcome
  // succeeded instead of inserting a duplicate (a queued row would keep preflight pending).
  const updated = await pool.query(
    `UPDATE bb_jobs SET state='succeeded', result=$6::jsonb, checkpoint=$7::jsonb
    WHERE owner_user_id=$1 AND project_id=$2 AND job_type='parse' AND subtype='material_parse'
      AND material_id=$3 AND material_version=1 AND parser_version=$4 AND material_sha256=$5`,
    [
      owner,
      projectId,
      material.materialId,
      parserVersion,
      material.sha256,
      JSON.stringify({ outcome: 'parsed' }),
      JSON.stringify({ stages: { parse_evidence: { snapshot_id: snapshotId } } }),
    ],
  );
  assert.equal(
    updated.rowCount,
    1,
    'the public upload completion enqueued exactly one durable parse job to mark succeeded',
  );
  return { snapshotId, recordId };
}

/** The #15 fixture the API and #33 read: an active project-scoped grant plus one verified observation. */
async function reviewIdentity(
  pool: Pool,
  args: {
    owner: string;
    reviewer: string;
    projectId: string;
    material: UploadedMaterial;
    recordId: string;
    label: string;
  },
): Promise<void> {
  const { owner, reviewer, projectId, material, recordId, label } = args;
  const record = await appendIssuerIdentitySourceRecord(
    { pool, newId: randomUUID },
    {
      ownerUserId: owner,
      projectId,
      materialId: material.materialId,
      materialVersion: 1,
      requestId: `identity-${label}`,
      sourceRecordId: recordId,
      issuerDisplayName: '合成发行人',
      entityId: `issuer-name:v1:${sha('合成发行人').slice(0, 32)}`,
    },
  );
  const reviewerContext = await authorizeIssuerIdentityReviewer(pool, reviewer, {
    ownerUserId: owner,
    projectId,
  });
  assert.ok(
    reviewerContext,
    'the project-scoped issuer identity grant must authorize the synthetic reviewer',
  );
  await reviewIssuerIdentitySourceRecord(
    { pool, newId: randomUUID },
    {
      ownerUserId: owner,
      projectId,
      materialId: material.materialId,
      materialVersion: 1,
      sourceRecordRowId: record.id,
      reviewer: reviewerContext,
      decision: 'verified',
      reasonCode: 'synthetic_e2e_verified',
      verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
      entityBasisKind: 'manual_attestation',
      entityBasisRef: 'synthetic e2e identity evidence',
    },
  );
}

/** Synthetic model stage on the fake codex fixture: reaches the provider-intent seam with no provider. */
function syntheticModelStage(config: CodexAdapterConfig): RunStage {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' }, n: { type: 'integer' } },
    required: ['answer', 'n'],
    additionalProperties: false,
  };
  return codexModelStage({
    name: 'model_generation',
    logicalCallId: 'm1-e2e-synthetic-generation',
    config,
    schema,
    validate: (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { answer?: unknown }).answer === 'string',
    resultSchemaVersion: 'answer-v1',
    buildPrompt: async (ctx) =>
      `SYNTHETIC M1 e2e prompt for run ${ctx.run.id}. SCENARIO:structured`,
  });
}

function modelConfig(root: string): CodexAdapterConfig {
  return {
    command: [process.execPath, fakeCodex],
    model_id: 'deepseek-flash',
    model_provider: 'deepseek',
    base_url: 'https://api.deepseek.com',
    wire_api: 'responses',
    model_config_version: 'codex-deepseek-flash-test',
    reasoning_effort: null,
    credential: { kind: 'env', name: 'BB_SYNTHETIC_DEEPSEEK_KEY' },
    work_root: join(root, 'work'),
    timeout_ms: 5000,
    kill_grace_ms: 100,
    max_output_bytes: 1 << 20,
    max_schema_reasks: 1,
    disabled_features: DEFAULT_DISABLED_FEATURES,
    path_env: '/usr/bin:/bin',
  };
}

/** Synthetic Word delivery on the OOXML fixture; the pipeline applies the test marking for the channel. */
function syntheticWordStage(): RunStage {
  return wordDeliveryStage(async (ctx) => {
    assert.deepEqual(ctx.values.get('model_generation'), { answer: 'OK', n: 16 });
    return makeWorkerDocxFixture({ externalLink: false });
  });
}

async function attemptsFor(pool: Pool, runId: string): Promise<{ n: number; statuses: string[] }> {
  const rows = (
    await pool.query(
      `SELECT a.status FROM bb_model_call_attempts a
    JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1 ORDER BY a.attempt_no`,
      [runId],
    )
  ).rows;
  return { n: rows.length, statuses: rows.map((row) => String(row.status)) };
}

const pauseReasons = async (pool: Pool, runId: string): Promise<string[]> =>
  (
    await pool.query(
      "SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq",
      [runId],
    )
  ).rows.map((row) => String(row.reason));

function identityGrant(
  pool: Pool,
  reviewer: string,
  grantor: string,
  owner: string,
  projectId: string,
) {
  return pool.query(
    `INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
    VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_e2e_test',$4,$5)`,
    [randomUUID(), reviewer, grantor, owner, projectId],
  );
}

async function insertUsers(pool: Pool, userIds: string[]) {
  for (const userId of userIds) {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [
      userId,
      `e2e${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    ]);
  }
}

function withTestChannel<T>(action: () => Promise<T>): Promise<T> {
  const previous = [process.env.BB_DEPLOYMENT_TIER, process.env.BB_NON_PRODUCTION_TEST_CHANNEL];
  process.env.BB_DEPLOYMENT_TIER = 'preprod';
  process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
  return action().finally(() => {
    for (const [index, key] of ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL'].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  });
}

function preprodGrant(
  pool: Pool,
  owner: string,
  project: string,
  revision: number,
  inputHash: string,
) {
  return runGrantCommand(pool, [
    'create',
    owner,
    project,
    String(revision),
    inputHash,
    OWNER_MATERIAL_SCOPE_SHA256,
    taxonomyHash,
    rulePackHash,
    'preprod_service',
    new Date(Date.now() + 3_600_000).toISOString(),
    'controlled_working_draft:issuance:2026-09-29',
  ]) as Promise<{ grant_id: string }>;
}

async function submitRun(
  harness: ReturnType<typeof makeHarness>,
  payload: {
    project: string;
    locked: { input_revision: number; input_hash: string };
    taskKind: 'update' | 'generation';
    grantId: string;
  },
) {
  const response = await harness.send('POST', '/api/v1/runs/execute', {
    execution_request_id: randomUUID(),
    project_id: payload.project,
    input_revision: payload.locked.input_revision,
    input_hash: payload.locked.input_hash,
    task_kind: payload.taskKind,
    input_manifest_ref: 'synthetic',
    storage_origin: 'cloud',
    workspace_id: 'synthetic-e2e',
    test_grant_id: payload.grantId,
  });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().run_id as string;
}

/** The exact reviewed identity review id for one material/record; #33 observations must cite it. */
async function reviewedId(
  pool: Pool,
  owner: string,
  projectId: string,
  materialId: string,
  recordId: string,
): Promise<string> {
  const row = (
    await pool.query(
      `SELECT rv.id FROM bb_issuer_identity_source_reviews rv
    JOIN bb_issuer_identity_source_records r ON r.id=rv.source_record_id AND r.owner_user_id=rv.owner_user_id
      AND r.project_id=rv.project_id AND r.material_id=rv.material_id AND r.material_version=rv.material_version
    WHERE rv.owner_user_id=$1 AND rv.project_id=$2 AND rv.material_id=$3 AND r.source_record_id=$4
    ORDER BY rv.created_at DESC LIMIT 1`,
      [owner, projectId, materialId, recordId],
    )
  ).rows[0];
  assert.ok(row?.id, 'the verified identity review id is persisted');
  return String(row.id);
}

/** Minimal #15 historical recognition fixture: enough for the free difficulty summary, never a claim. */
function profileFixture(materialId: string) {
  const provenance = {
    material_id: materialId,
    material_version: 1,
    method: 'native_text',
    extractor_version: 'synthetic',
    evidence_refs: [],
  };
  const pendingField = () => ({
    value: null,
    raw_value: null,
    provenance,
    uncertainty: ['synthetic_unconfirmed'],
    status: 'needs_confirmation',
  });
  return {
    material_id: materialId,
    material_version: 1,
    profile_version: 1,
    state: 'needs_confirmation',
    source_market: pendingField(),
    source_offering: pendingField(),
    reporting_periods: [],
    latest_reporting_cutoff: pendingField(),
  };
}

type UpdateChain = {
  project: string;
  locked: { input_revision: number; input_hash: string };
  grantId: string;
};

async function provisionUpdateChain(
  pool: Pool,
  harness: ReturnType<typeof makeHarness>,
  owner: string,
  reviewer: string,
  grantor: string,
): Promise<UpdateChain> {
  await insertUsers(pool, [owner, reviewer, grantor]);
  const project = await harness.createProject('update', 'Synthetic M1 e2e update');
  const historical = await harness.upload(
    project,
    'historical',
    'history',
    pdfSample(randomUUID()),
    PDF,
    'pdf',
  );
  const financial = await harness.upload(
    project,
    'financial',
    'finance',
    Buffer.from(`synthetic financial ${randomUUID()}`),
  );
  const historicalEvidence = await insertParseEvidence(pool, {
    owner,
    projectId: project,
    material: historical,
    label: 'history',
    quote: '合成发行人历史募集说明书',
    mediaType: PDF,
  });
  await insertParseEvidence(pool, {
    owner,
    projectId: project,
    material: financial,
    label: 'finance',
    quote: '合成发行人合并资产负债表',
  });
  await identityGrant(pool, reviewer, grantor, owner, project);
  await reviewIdentity(pool, {
    owner,
    reviewer,
    projectId: project,
    material: historical,
    recordId: historicalEvidence.recordId,
    label: 'history',
  });
  await pool.query(
    `INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
    VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,
    [
      owner,
      project,
      historical.materialId,
      `profile-${project}`,
      'a'.repeat(64),
      JSON.stringify(profileFixture(historical.materialId)),
    ],
  );
  const materials = [
    { material_id: historical.materialId, material_version: 1 },
    { material_id: financial.materialId, material_version: 1 },
  ];
  const lockedResponse = await harness.send('POST', `/api/v1/projects/${project}/input-revisions`, {
    draft_revision: 1,
    material_versions: materials,
    requirement_message_ids: [],
    target_confirmation: {
      market: 'sse',
      offering: 'private',
      document_purpose: 'issuance',
      as_of: '2026-09-27',
      target_reporting_periods: [],
    },
  });
  assert.equal(lockedResponse.statusCode, 201, lockedResponse.body);
  const locked = lockedResponse.json() as { input_revision: number; input_hash: string };
  const manifest = (
    await pool.query(
      'SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, project, locked.input_revision],
    )
  ).rows[0].manifest as Record<string, unknown>;
  assert.equal(
    (manifest.issuer_identity as { status?: string }).status,
    'verified',
    'the API locks the reviewed issuer identity into the manifest',
  );
  const grant = await preprodGrant(pool, owner, project, locked.input_revision, locked.input_hash);
  return { project, locked, grantId: grant.grant_id };
}

test(
  'M1 e2e: an authorized update test run advances past capability_not_ready to model generation, and a revoked grant fails closed',
  { skip: baseSkipReason },
  async () =>
    withTestChannel(async () => {
      assert.ok(databaseUrl && blobConnection);
      const owner = `e2e-owner-${randomUUID()}`,
        reviewer = `e2e-reviewer-${randomUUID()}`,
        grantor = `e2e-grantor-${randomUUID()}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const container = `bb-m1-e2e-${randomUUID()}`;
      const blobs = azureBlobs(blobConnection, container);
      const harness = makeHarness(pool, blobs, owner);
      const root = await mkdtemp(join(tmpdir(), 'bb-m1-e2e-'));
      const capabilityLoader = createSsePrivateTestRuleCapabilityLoader(pool);
      const stages: RunStage[] = [inputLockStage, syntheticModelStage(modelConfig(root))];
      const unexpected: string[] = [];
      try {
        const chain = await provisionUpdateChain(pool, harness, owner, reviewer, grantor);
        const preflight = await harness.send(
          'POST',
          `/api/v1/projects/${chain.project}/preflight`,
          {
            input_revision: chain.locked.input_revision,
            input_hash: chain.locked.input_hash,
            test_grant_id: chain.grantId,
          },
        );
        assert.equal(preflight.statusCode, 200, preflight.body);
        assert.ok(
          !preflight.json().missing_inputs.includes('execution_capability_not_ready'),
          'the synthetic queue removes the execution-capability blocker',
        );
        assert.ok(
          preflight
            .json()
            .advisory_inputs.includes('rule_pack:rule_applicability_reference_missing'),
          'the test grant makes the absent reviewed applicability advisory',
        );

        const runId = await submitRun(harness, {
          project: chain.project,
          locked: chain.locked,
          taskKind: 'update',
          grantId: chain.grantId,
        });
        const outcome = await runPipelineOnce({
          pool,
          blobs,
          stages,
          testRuleCapabilityLoader: capabilityLoader,
          onUnexpectedError: (error) => unexpected.push(JSON.stringify(error)),
        });
        assert.equal(
          outcome,
          'paused',
          'only the model stage is installed, so the run parks after generation',
        );
        assert.deepEqual(
          unexpected,
          [],
          'the real capability loader and the model stage must not raise an unexpected error',
        );
        const run = (await harness.send('GET', `/api/v1/runs/${runId}`)).json();
        assert.equal(
          run.uncovered_items.length,
          31,
          'the real #20 candidate capability projected its 31 coverage gaps into the run',
        );
        assert.equal(
          (await pool.query('SELECT stage FROM bb_runs WHERE id=$1', [runId])).rows[0].stage,
          'capability_not_ready',
          'with no Word stage installed the run parks after the model stage, not before it',
        );
        const reasons = await pauseReasons(pool, runId);
        assert.ok(
          !reasons.some(
            (reason) =>
              reason === 'test_rule_capability_not_ready' || reason === 'test_run_scope_required',
          ),
          `the real test capability must be ready for an update run (${reasons.join(',')})`,
        );
        assert.ok(
          !reasons.some(
            (reason) =>
              reason === 'historical_issuer_identity_not_bound' ||
              reason === 'issuer_identity_not_bound',
          ),
          'the verified issuer identity must open the identity gate',
        );
        const attempts = await attemptsFor(pool, runId);
        assert.ok(
          attempts.n >= 1 && attempts.statuses.every((status) => status === 'completed'),
          `model attempts: ${attempts.statuses.join(',')}`,
        );
        const checkpoint = (
          await pool.query(
            "SELECT checkpoint->'stages'->'model_generation' AS model FROM bb_jobs WHERE run_id=$1",
            [runId],
          )
        ).rows[0].model;
        assert.ok(
          checkpoint && typeof checkpoint === 'object',
          'the model stage wrote a durable checkpoint',
        );

        // Reverse case: revoking the exact test grant fail-closes the next run before any model call.
        const revokedGrant = await preprodGrant(
          pool,
          owner,
          chain.project,
          chain.locked.input_revision,
          chain.locked.input_hash,
        );
        const revokedRunId = await submitRun(harness, {
          project: chain.project,
          locked: chain.locked,
          taskKind: 'update',
          grantId: revokedGrant.grant_id,
        });
        await runGrantCommand(pool, [
          'revoke',
          revokedGrant.grant_id,
          'synthetic-operator',
          'synthetic e2e revocation',
        ]);
        // A revoked grant is fail-closed at the claim gate: no lease is handed out, so no model stage runs.
        assert.equal(
          await runPipelineOnce({
            pool,
            blobs,
            stages,
            testRuleCapabilityLoader: capabilityLoader,
          }),
          'idle',
        );
        assert.deepEqual(
          (await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1', [revokedRunId])).rows[0],
          { state: 'paused', stage: 'test_grant_invalid' },
        );
        assert.equal(
          (await pauseReasons(pool, revokedRunId)).at(-1),
          'test_grant_revoked',
          'the revoked exact grant uses its stable fail-closed code',
        );
        assert.equal(
          (await attemptsFor(pool, revokedRunId)).n,
          0,
          'a revoked test grant cannot start a model call',
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM bb_snapshot_refs WHERE run_id=$1 AND snapshot_kind='model_request'",
              [revokedRunId],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await harness.app.close();
        await pool.end();
        await rm(root, { recursive: true, force: true });
        await BlobServiceClient.fromConnectionString(blobConnection)
          .getContainerClient(container)
          .deleteIfExists();
      }
    }),
);

test(
  'M1 e2e: the test-channel Word delivery marks the artifact as test-only',
  { skip: wordSkipReason },
  async () =>
    withTestChannel(async () => {
      assert.ok(databaseUrl && blobConnection);
      const owner = `e2e-word-owner-${randomUUID()}`,
        reviewer = `e2e-word-reviewer-${randomUUID()}`,
        grantor = `e2e-word-grantor-${randomUUID()}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const container = `bb-m1-e2e-word-${randomUUID()}`;
      const blobs = azureBlobs(blobConnection, container);
      const harness = makeHarness(pool, blobs, owner);
      const root = await mkdtemp(join(tmpdir(), 'bb-m1-e2e-word-'));
      const capabilityLoader = createSsePrivateTestRuleCapabilityLoader(pool);
      const stages: RunStage[] = [
        inputLockStage,
        syntheticModelStage(modelConfig(root)),
        syntheticWordStage(),
      ];
      const unexpected: string[] = [];
      try {
        const chain = await provisionUpdateChain(pool, harness, owner, reviewer, grantor);
        const runId = await submitRun(harness, {
          project: chain.project,
          locked: chain.locked,
          taskKind: 'update',
          grantId: chain.grantId,
        });
        const outcome = await runPipelineOnce({
          pool,
          blobs,
          stages,
          testRuleCapabilityLoader: capabilityLoader,
          onUnexpectedError: (error) => unexpected.push(JSON.stringify(error)),
        });
        assert.equal(outcome, 'test_completed', unexpected.join('; '));
        const run = (await harness.send('GET', `/api/v1/runs/${runId}`)).json();
        assert.equal(run.state, 'test_completed');
        assert.equal(run.channel, 'non_production_test');
        assert.equal(run.billing_mode, 'non_billable_test');
        assert.equal(run.uncovered_items.length, 31);
        const artifact = await harness.send('GET', `/api/v1/artifacts/${run.artifact_id}`);
        assert.equal(artifact.statusCode, 200, artifact.body);
        assert.equal(artifact.json().delivery_status, 'test_only');
        const download = await harness.send('GET', artifact.json().download_url);
        assert.equal(download.statusCode, 200);
        assert.ok(
          download.rawPayload.length > 0,
          'the marked Word bytes are readable by the owner',
        );
      } finally {
        await harness.app.close();
        await pool.end();
        await rm(root, { recursive: true, force: true });
        await BlobServiceClient.fromConnectionString(blobConnection)
          .getContainerClient(container)
          .deleteIfExists();
      }
    }),
);

type GenerationChain = {
  project: string;
  locked: { input_revision: number; input_hash: string };
  bindingWithdraw: () => Promise<void>;
};

async function provisionGenerationChain(
  pool: Pool,
  harness: ReturnType<typeof makeHarness>,
  owner: string,
  reviewer: string,
  grantor: string,
): Promise<GenerationChain> {
  await insertUsers(pool, [owner, reviewer, grantor]);
  const project = await harness.createProject('generation', 'Synthetic M1 e2e generation');
  const audit = await harness.upload(
    project,
    'audit',
    'audit',
    Buffer.from(`synthetic generation audit ${randomUUID()}`),
  );
  const notes = await harness.upload(
    project,
    'notes',
    'notes',
    Buffer.from(`synthetic generation notes ${randomUUID()}`),
  );
  const auditEvidence = await insertParseEvidence(pool, {
    owner,
    projectId: project,
    material: audit,
    label: 'audit',
    quote: '合成发行人甲合并资产负债表',
  });
  const notesEvidence = await insertParseEvidence(pool, {
    owner,
    projectId: project,
    material: notes,
    label: 'notes',
    quote: '本公司为合成发行人甲有限公司',
  });
  await identityGrant(pool, reviewer, grantor, owner, project);
  await reviewIdentity(pool, {
    owner,
    reviewer,
    projectId: project,
    material: audit,
    recordId: auditEvidence.recordId,
    label: 'audit',
  });
  await reviewIdentity(pool, {
    owner,
    reviewer,
    projectId: project,
    material: notes,
    recordId: notesEvidence.recordId,
    label: 'notes',
  });
  const reviewerContext = await authorizeIssuerIdentityReviewer(pool, reviewer, {
    ownerUserId: owner,
    projectId: project,
  });
  assert.ok(reviewerContext);

  const materials = [
    { material_id: audit.materialId, material_version: 1 },
    { material_id: notes.materialId, material_version: 1 },
  ];
  const firstLock = await harness.send('POST', `/api/v1/projects/${project}/input-revisions`, {
    draft_revision: 1,
    material_versions: materials,
    requirement_message_ids: [],
  });
  assert.equal(firstLock.statusCode, 201, firstLock.body);
  const source = firstLock.json() as { input_revision: number; input_hash: string };

  const deps = { pool, newId: randomUUID };
  const materialDecisions: GenerationIssuerBindingDecisionInput[] = [
    {
      material_id: audit.materialId,
      material_version: 1,
      disposition: 'classified',
      reason: '合并编制主体。',
      observations: [
        {
          source_record_id: auditEvidence.recordId,
          observed_subject_label: '合成发行人甲',
          evidence_context: 'financial_statement',
          subject_relation: 'issuer_compiler',
          accounting_scope: 'consolidated',
          relation_reason: '合并编制主体。',
          source_identity_review_id: await reviewedId(
            pool,
            owner,
            project,
            audit.materialId,
            auditEvidence.recordId,
          ),
        },
      ],
    },
    {
      material_id: notes.materialId,
      material_version: 1,
      disposition: 'classified',
      reason: '附注主体说明。',
      observations: [
        {
          source_record_id: notesEvidence.recordId,
          observed_subject_label: '合成发行人甲',
          evidence_context: 'identity_relationship',
          subject_relation: 'issuer_compiler',
          accounting_scope: 'not_applicable',
          relation_reason: '附注主体说明。',
          source_identity_review_id: await reviewedId(
            pool,
            owner,
            project,
            notes.materialId,
            notesEvidence.recordId,
          ),
        },
      ],
    },
  ];
  const appended = await appendGenerationIssuerBinding(deps, {
    ownerUserId: owner,
    projectId: project,
    inputRevision: source.input_revision,
    inputHash: source.input_hash,
    requestId: `binding-${project}`,
    reviewer: reviewerContext,
    materialDecisions,
  });
  const bindingRef = {
    binding_id: appended.bindingId,
    version: appended.version,
    content_sha256: appended.contentSha256,
  };
  await reviewGenerationIssuerBinding(deps, {
    ownerUserId: owner,
    projectId: project,
    bindingId: bindingRef.binding_id,
    version: bindingRef.version,
    contentSha256: bindingRef.content_sha256,
    requestId: `approve-${project}`,
    action: 'approve',
    reason: '逐项核验。',
    reviewer: reviewerContext,
  });

  const pinned = await harness.send('POST', `/api/v1/projects/${project}/input-revisions`, {
    draft_revision: 1,
    material_versions: materials,
    requirement_message_ids: [],
    generation_issuer_binding_ref: bindingRef,
  });
  assert.equal(pinned.statusCode, 201, pinned.body);
  const locked = pinned.json() as { input_revision: number; input_hash: string };
  const manifest = (
    await pool.query(
      'SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, project, locked.input_revision],
    )
  ).rows[0].manifest as Record<string, unknown>;
  assert.deepEqual(
    manifest.generation_issuer_binding_ref,
    bindingRef,
    'the exact approved binding ref is pinned into the immutable manifest',
  );
  return {
    project,
    locked,
    bindingWithdraw: async () => {
      await reviewGenerationIssuerBinding(deps, {
        ownerUserId: owner,
        projectId: project,
        bindingId: bindingRef.binding_id,
        version: bindingRef.version,
        contentSha256: bindingRef.content_sha256,
        requestId: `withdraw-${project}`,
        action: 'withdraw',
        reason: '材料撤回。',
        reviewer: reviewerContext,
      });
    },
  };
}

test(
  'M1 e2e: a generation run crosses issuer_identity_not_bound only with a pinned approved binding',
  { skip: baseSkipReason },
  async () =>
    withTestChannel(async () => {
      assert.ok(databaseUrl && blobConnection);
      const owner = `e2e-gen-owner-${randomUUID()}`,
        reviewer = `e2e-gen-reviewer-${randomUUID()}`,
        grantor = `e2e-gen-grantor-${randomUUID()}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const container = `bb-m1-e2e-gen-${randomUUID()}`;
      const blobs = azureBlobs(blobConnection, container);
      const harness = makeHarness(pool, blobs, owner);
      const root = await mkdtemp(join(tmpdir(), 'bb-m1-e2e-gen-'));
      // The #20 candidate loader is update-scoped; this scenario isolates the #33 binding gate with a
      // deterministic capability boundary that echoes the grant's hashes. The real capability loader is
      // exercised by the update scenarios above.
      const capabilityLoader = async (run: { test_grant_id?: string | null }) => {
        const grant = (
          await pool.query(
            'SELECT sample_manifest_sha256,taxonomy_hash,rule_pack_hash,revoked_at,expires_at FROM bb_non_production_test_grants WHERE grant_id=$1',
            [run.test_grant_id],
          )
        ).rows[0];
        if (!grant || grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now())
          return { status: 'not_ready' as const, reason: 'test_grant_inactive_or_scope_changed' };
        return {
          status: 'ready' as const,
          sampleManifestSha256: String(grant.sample_manifest_sha256).trim(),
          taxonomyHash: String(grant.taxonomy_hash).trim(),
          rulePackHash: String(grant.rule_pack_hash).trim(),
          uncoveredItems: [],
        };
      };
      const stages: RunStage[] = [inputLockStage, syntheticModelStage(modelConfig(root))];
      const unexpected: string[] = [];
      try {
        const chain = await provisionGenerationChain(pool, harness, owner, reviewer, grantor);
        const grant = await preprodGrant(
          pool,
          owner,
          chain.project,
          chain.locked.input_revision,
          chain.locked.input_hash,
        );
        const runId = await submitRun(harness, {
          project: chain.project,
          locked: chain.locked,
          taskKind: 'generation',
          grantId: grant.grant_id,
        });
        const outcome = await runPipelineOnce({
          pool,
          blobs,
          stages,
          loadGenerationIssuerBinding: (scope) =>
            loadPinnedApprovedGenerationIssuerBinding(pool, scope),
          testRuleCapabilityLoader: capabilityLoader,
          onUnexpectedError: (error) => unexpected.push(JSON.stringify(error)),
        });
        assert.equal(
          outcome,
          'paused',
          'only the model stage is installed, so the run parks after generation',
        );
        assert.deepEqual(unexpected, []);
        assert.ok(
          !(await pauseReasons(pool, runId)).includes('issuer_identity_not_bound'),
          'the approved pinned binding must open the issuer gate',
        );
        assert.equal(
          (await attemptsFor(pool, runId)).n,
          1,
          'the generation run reaches the model call',
        );

        // Reverse case: a withdrawn binding no longer opens the gate, and no model call is attempted.
        await chain.bindingWithdraw();
        const withdrawnGrant = await preprodGrant(
          pool,
          owner,
          chain.project,
          chain.locked.input_revision,
          chain.locked.input_hash,
        );
        const withdrawnRunId = await submitRun(harness, {
          project: chain.project,
          locked: chain.locked,
          taskKind: 'generation',
          grantId: withdrawnGrant.grant_id,
        });
        assert.equal(
          await runPipelineOnce({
            pool,
            blobs,
            stages,
            loadGenerationIssuerBinding: (scope) =>
              loadPinnedApprovedGenerationIssuerBinding(pool, scope),
            testRuleCapabilityLoader: capabilityLoader,
          }),
          'paused',
        );
        assert.deepEqual(
          (await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1', [withdrawnRunId]))
            .rows[0],
          { state: 'paused', stage: 'capability_not_ready' },
        );
        assert.equal(
          (await pauseReasons(pool, withdrawnRunId)).at(-1),
          'issuer_identity_not_bound',
        );
        assert.equal(
          (await attemptsFor(pool, withdrawnRunId)).n,
          0,
          'a withdrawn binding cannot start a model call',
        );
      } finally {
        await harness.app.close();
        await pool.end();
        await rm(root, { recursive: true, force: true });
        await BlobServiceClient.fromConnectionString(blobConnection)
          .getContainerClient(container)
          .deleteIfExists();
      }
    }),
);
