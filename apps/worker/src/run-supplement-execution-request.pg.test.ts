// Real adopted leases and immutable supplement receipts. The contained CLI
// scenarios below additionally require the pinned Linux sandbox and Python.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { createServer } from '@bondbuddy/api';
import { digest, uid } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { action, checkpointStage, claim, type Lease } from '@bondbuddy/api/queue';
import { readExecutionStages, resolveRunExecution } from '@bondbuddy/api/run-execution';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingKind } from '@bondbuddy/api/run-supplement-preparation';
import { createRunSupplementProcessingPlan } from '@bondbuddy/api/run-supplement-processing-plan';
import { adoptRunSupplementTestInput, stageRunSupplementTestInput } from '@bondbuddy/api/run-supplement-test-adoption';
import { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { createRunSupplementPreparationFixture, createRunSupplementPreparationTestContext,
  grantSyntheticSupplementInput } from '../../api/dist/run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from '../../api/dist/run-supplement-file-preparation-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadCodexAdapterConfig, type CodexAdapterConfig } from './codex-adapter.js';
import { buildM4Method } from './m4-method.js';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { loadM4DocumentSkill } from './m4-document-request.js';
import { loadM4WorkerInput } from './m4-input.js';
import { type UnifiedInput, type UnifiedManifest } from './unified-input.js';
import { loadReviewFileInput, reviewFileStage } from './review-file-stage.js';
import { fileAuthoringStage, fileAuthoringDeliveryStage } from './file-authoring-stage.js';
import { m4DocumentStage, m4DocumentDeliveryStage } from './m4-document-stage.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { inputLockStage, materialsReadyStage, runPipelineOnce, type StageContext, type RunStage, type TestRuleCapabilityLoader, type codexModelStage } from './run-pipeline.js';
import { adoptedFileAuthoringRequest, adoptedM4DocumentRequest, adoptedReviewFileRequest } from './run-supplement-execution-request.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { CodexDurableJournal } from './durable-probe-journal.js';

const database = await isolatedTestDatabase(undefined, 'supplement-active-worker');
const baseConfig = loadCodexAdapterConfig({});
const method = await buildM4Method('document', loadM4RuntimeSkill('m4-underwriter'), baseConfig);
const previous = { tier: process.env.BB_DEPLOYMENT_TIER, channel: process.env.BB_NON_PRODUCTION_TEST_CHANNEL };
before(() => { process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled'; });
after(() => {
  if (previous.tier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = previous.tier;
  if (previous.channel === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previous.channel;
});
const capability: TestRuleCapabilityLoader = async () => ({ status: 'ready',
  sampleManifestSha256: digest('synthetic-supplement-fixture'), taxonomyHash: digest('synthetic-supplement-fixture'),
  rulePackHash: digest('synthetic-supplement-fixture'), uncoveredItems: [] });
type PreparationInput = Parameters<typeof loadRunSupplementProcessingBasis>[0];
type Scope = { pool: StageContext['pool']; blobs: StageContext['blobs']; owner: string; projectId: string; runId: string; jobId: string };
async function adopt(f: Scope, preparationInput: PreparationInput, kind: RunSupplementProcessingKind) {
  const basis = await loadRunSupplementProcessingBasis(preparationInput, kind);
  const plan = await createRunSupplementProcessingPlan({ ...preparationInput, kind, requestId: uid(), expectedBasisHash: basis.basisHash });
  const prepared = { ...preparationInput, kind, planId: plan.id, expectedPlanHash: plan.planHash };
  const target = await stageRunSupplementTestInput(prepared);
  const testGrantId = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
  const adoption = await adoptRunSupplementTestInput({ ...prepared, requestId: uid(), targetInputRevision: target.inputRevision, testGrantId });
  return { basis, plan, target, adoption };
}
async function context(f: Scope, kind: RunSupplementProcessingKind) {
  const lease = await claim(f.pool, 300, { runKinds: [kind === 'authoring' ? 'update' : kind === 'review' ? 'review' : 'generation'] });
  assert.ok(lease); assert.equal(lease.runId, f.runId);
  const run = await resolveRunExecution(f.pool, f.owner, f.runId, lease);
  const ctx: StageContext = { pool: f.pool, blobs: f.blobs, lease, run, signal: new AbortController().signal,
    checkpoint: { ...readExecutionStages(lease.checkpoint, lease) }, values: new Map() };
  return ctx;
}
async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-active-supplement-'));
  try { await visit(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  test(`${kind}: adopted worker bundle retains builder metadata and prepares exact historical work plus candidate materials`,
    { skip: !database, timeout: 120000 }, async () => {
      const f = kind === 'authoring' ? await createRunSupplementPreparationFixture(database!, { nonProduction: true })
        : await createRunSupplementFilePreparationFixture(database!, kind, { nonProduction: true, method,
          ...(kind === 'review' ? { operation: 'differential_review' as const } : {}) });
      try {
        const { basis, plan } = await adopt(f, f.preparationInput, kind), ctx = await context(f, kind);
        let bundle;
        if (kind === 'authoring') {
          // This existing authority fixture intentionally omits target periods;
          // exercise only the bundle here. The full pipeline fixture below has
          // real complete target information and uses the ordinary active loader.
          const input: UnifiedInput = { manifest: basis.manifest as UnifiedManifest,
            materials: basis.materials.map(m => ({ ...m, records: [] })), requirements: ['Frozen user requirement'] };
          bundle = await adoptedFileAuthoringRequest(ctx, input, async () => structuredClone(input));
          assert.equal(bundle.input, input);
          assert.equal(bundle.request.baselineKind, 'saved_clean_work');
          assert.equal(bundle.request.sourceHash, basis.priorWork!.files.find(file => file.name === 'clean.docx')!.sha256);
          assert.equal(bundle.request.source, null);
        } else if (kind === 'review') {
          const input = await loadReviewFileInput(ctx);
          bundle = await adoptedReviewFileRequest(ctx, input, () => loadReviewFileInput(ctx), baseConfig);
        } else {
          const input = await loadM4WorkerInput(ctx);
          assert.equal(input.manifest.kind, 'document');
          if (input.manifest.kind !== 'document') throw Error('document fixture expected');
          bundle = await adoptedM4DocumentRequest(ctx, input, () => loadM4WorkerInput(ctx), loadM4DocumentSkill(input.manifest), baseConfig);
          assert.equal(bundle.methodHash, inputManifestHash(method));
          assert.equal(typeof Object.getOwnPropertyDescriptor(bundle.request, 'linkedSource')?.get, 'function');
        }
        await workspace(async cwd => {
          await bundle.request.buildPrompt(); await bundle.request.prepare(cwd); await bundle.request.verifyOriginals(cwd);
          const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
          assert.equal(data.input_hash, ctx.lease.inputHash); assert.notEqual(data.input_hash, f.hash);
          assert.equal(data.continuation.processing_plan_id, plan.id);
          assert.equal(data.continuation.basis_hash, basis.basisHash);
          assert.equal(data.materials.some((m: any) => m.material_id === f.added.material_id), true);
          for (const pin of basis.priorWork!.files)
            assert.deepEqual(await readFile(join(cwd, 'previous_work', pin.name)), f.objects.get(pin.key));
          if (kind === 'authoring') assert.equal(data.baseline_path, 'previous_work/clean.docx');
          if (kind === 'review') {
            const source = (f.manifest as any).review;
            assert.equal(data.scope.operation, 'differential_review'); assert.equal(data.scope.source_report_id, source.source_report_id);
            assert.deepEqual(data.scope.selected_findings.map((finding: any) => finding.finding_id), source.finding_ids);
            assert.equal(data.materials.find((m: any) => m.review_source).material_version, 2);
          }
          if (kind === 'm4') {
            assert.deepEqual(data.task.input.source_material, (f.manifest as any).input.source_material);
            assert.deepEqual(data.task.input.template, (f.manifest as any).input.template);
          }
          const before = await f.snapshot();
          await chmod(join(cwd, 'input.json'), 0o600);
          await writeFile(join(cwd, 'input.json'), '{}');
          await assert.rejects(bundle.request.verifyOriginals(cwd), /INPUT_REVISION_CONFLICT/);
          assert.deepEqual(await f.snapshot(), before);
        });
      } finally { await action(f.pool, f.owner, f.runId, 'cancel').catch(() => undefined); await f.cleanup(); }
    });
}

test('M4 current method drift is rejected before V2 method checkpoint and provider intent, including no-prior-work receipts',
  { skip: !database, timeout: 120000 }, async () => {
    for (const early of [false, true]) {
      const f = early ? await createRunSupplementFilePreparationFixture(database!, 'm4', { nonProduction: true, method, earlyPause: 'before_prompt' })
        : await createRunSupplementFilePreparationFixture(database!, 'm4', { nonProduction: true, method });
      try {
        await adopt(f, f.preparationInput, 'm4');
        const ctx = await context(f, 'm4'), before = await f.snapshot();
        let called = false;
        const stage = m4DocumentStage({ config: { ...baseConfig, model_id: 'changed-model' }, model: () => {
          called = true; throw Error('provider must not be constructed');
        } });
        await assert.rejects(stage.run(ctx), /m4_document_method_changed/);
        assert.equal(called, false); assert.deepEqual(await f.snapshot(), before);
        const checkpoint = (await f.pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0].checkpoint;
        assert.equal(readExecutionStages(checkpoint, ctx.lease).m4_document_method, undefined);
      } finally { await action(f.pool, f.owner, f.runId, 'cancel').catch(() => undefined); await f.cleanup(); }
    }
  });

/** Complete M1 target data, owned Word materials and an independently granted
 * test run. No input gate is disabled to make the contained pipeline advance. */
async function authoringFixture() {
  const c = await createRunSupplementPreparationTestContext(database!), { pool, blobs, owner } = c;
  const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test', enableSyntheticQueue: true,
    principal: async () => ({ userId: owner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url,
    headers: { origin: 'http://bondbuddy.test' }, payload: payload as any });
  const projectId = uid(), runId = uid(), jobId = uid(), docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering)
    VALUES($1,$2,'Synthetic active supplement','update','Frozen issuer','sse','private')`, [projectId, owner]);
  const material = async () => {
    const material_id = uid(), upload = uid(), bytes = makeWorkerDocxFixture({ externalLink: false }), sha256 = digest(bytes);
    const objectKey = `users/${owner}/projects/${projectId}/materials/${material_id}/1`;
    await blobs.put(objectKey, bytes, docx);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.docx',$4,$5,$6,'audit',$7,now()+interval '1 hour','completed')`,
    [upload, owner, projectId, docx, bytes.length, sha256, `${objectKey}/upload`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'audit','synthetic.docx',$5,$6,$7,$8,'persisted')`, [material_id, owner, projectId, upload, docx, bytes.length, sha256, objectKey]);
    return { material_id, material_version: 1, sha256, role: 'audit' };
  };
  const first = await material(), added = await material(), knowledge = 'Synthetic full-document recheck policy';
  const manifest = { issuer_name: 'Frozen issuer', market: 'sse', offering: 'private', draft_revision: 1,
    requirements: ['Frozen user requirement'], materials: [first], update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1',
      target_reporting_periods: [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }] },
    authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [{ path: 'frozen.md', markdown: knowledge, sha256: digest(knowledge) }],
      knowledge_status: 'authoring_reference_not_compliance_approval' } };
  const hash = inputManifestHash(manifest);
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [projectId, owner, hash, manifest, JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
  const grant = await grantSyntheticSupplementInput(pool, owner, projectId, 1, hash);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,channel,test_grant_id)
    VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued','non_production_test',$7)`, [runId, owner, projectId, hash, uid(), digest(uid()), grant]);
  await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,channel,test_grant_id)
    VALUES($1,$2,$3,'update','default','queued','queued','non_production_test',$4)`, [jobId, owner, runId, grant]);
  return { pool, blobs, owner, projectId, runId, jobId, hash, manifest, objects: c.objects, added,
    save: async (expectedRevision = 0) => {
      const response = await send('PUT', `/api/v1/runs/${runId}/supplement-draft`, { request_id: uid(), expected_revision: expectedRevision,
        base_input_revision: 1, base_input_hash: hash, changes: [{ material: { material_id: added.material_id, material_version: 1, sha256: added.sha256 }, replaces: null }] });
      assert.equal(response.statusCode, 200, response.body); return response.json();
    }, cleanup: async () => { await app.close(); await c.close(); } };
}

test('legacy update still requires issuer identity in the per-stage test gate even when input_lock is omitted',
  { skip: !database, timeout: 120000 }, async () => {
    const f = await authoringFixture();
    try {
      // Use a separate immutable legacy input/run instead of rewriting a pinned
      // unified input. Absence of the unified marker must retain the old gate.
      const legacy = { issuer_name: 'Frozen issuer', materials: [], update_details: emptyUpdateDetails() };
      const hash = inputManifestHash(legacy), runId = uid(), jobId = uid();
      await f.pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,1,$3,$4,'[]','[]')`, [f.projectId, f.owner, hash, legacy]);
      await f.pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1', [f.projectId]);
      const grant = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, 2, hash);
      await f.pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,channel,test_grant_id)
        VALUES($1,$2,$3,2,$4,$5,'update',$6,'queued','queued','non_production_test',$7)`, [runId, f.owner, f.projectId, hash, uid(), digest(uid()), grant]);
      await f.pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,channel,test_grant_id)
        VALUES($1,$2,$3,'update','default','queued','queued','non_production_test',$4)`, [jobId, f.owner, runId, grant]);
      await action(f.pool, f.owner, f.runId, 'pause');
      let called = false;
      assert.equal(await runPipelineOnce({ pool: f.pool, blobs: f.blobs, testRuleCapabilityLoader: capability,
        stages: [{ name: 'model_generation', run: async () => { called = true; throw Error('must not reach model'); } }] }), 'paused');
      assert.equal(called, false);
      const reasons = (await f.pool.query("SELECT payload->>'reason' AS reason FROM bb_run_events WHERE run_id=$1 AND state='paused' ORDER BY seq", [runId])).rows;
      assert.equal(reasons.at(-1)?.reason, 'historical_issuer_identity_not_bound');
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_model_call_attempts WHERE job_id=$1', [jobId])).rows[0].n, 0);
    } finally { await f.cleanup(); }
  });

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const python = process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? '/opt/venv/bin/python';
const containedReady = process.platform === 'linux' && spawnSync('/usr/local/bin/codex', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync(python, ['-c', 'import docx,lxml'], { stdio: 'ignore' }).status === 0;
const containedSkip = !database ? 'requires an isolated migrated PostgreSQL template'
  : !containedReady ? 'requires Linux, the real pinned /usr/local/bin/codex sandbox and Python Word modules' : false;

/** Cross-platform provider seam only. Real stages/builders, durable journal,
 * working-file authority, Word promotion and downloads remain in use. This
 * explicitly does not claim containment: the separate Linux case exercises it. */
function localSyntheticModel(config: CodexAdapterConfig): typeof codexModelStage {
  return options => ({ name: options.name, replay: true, run: async ctx => {
    const gate = await ctx.validateBeforeModelCall?.(); if (gate) return gate;
    const journal = new CodexDurableJournal({ pool: ctx.pool, blobs: ctx.blobs, lease: ctx.lease, validateResult: options.validate });
    const prior = await journal.latestAttempt(options.logicalCallId), promptStage = `${options.name}_prompt`;
    if (prior) {
      assert.equal(prior.status, 'completed');
      const saved = await journal.readCompleted(options.logicalCallId, prior.attempt_no); assert.ok(saved);
      return { kind: 'done', value: saved.value, checkpoint: { logical_call_id: options.logicalCallId,
        prompt_snapshot_ref: ctx.checkpoint[promptStage]!.snapshot_id } };
    }
    const body = await options.buildPrompt(ctx);
    const version = Number((await ctx.pool.query('SELECT COALESCE(max(version),0)+1 AS version FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2',
      [ctx.run.owner_user_id, ctx.run.project_id])).rows[0].version);
    const snapshot = await savePromptSnapshot(ctx.pool, ctx.blobs, { owner: ctx.run.owner_user_id, projectId: ctx.run.project_id, runId: ctx.run.id,
      kind: 'model_request', version, body, executionVersion: ctx.lease.executionVersion, inputRevision: ctx.lease.inputRevision,
      inputHash: ctx.lease.inputHash, templateVersion: options.templateVersion });
    await checkpointStage(ctx.pool, ctx.lease, promptStage, { snapshot_id: snapshot }); ctx.checkpoint[promptStage] = { snapshot_id: snapshot };
    const attemptState = await journal.attemptState(options.logicalCallId);
    const intent = { owner_user_id: ctx.run.owner_user_id, project_id: ctx.run.project_id, job_id: ctx.lease.jobId,
      run_id: ctx.run.id, trace_id: ctx.run.id, logical_call_id: options.logicalCallId, call_id: uid(), attempt_no: attemptState.next_attempt_no,
      model_id: config.model_id, model_config_version: config.model_config_version, prompt_snapshot_ref: snapshot };
    const cwd = join(config.work_root, intent.call_id); await mkdir(cwd);
    assert.ok(options.fileWorkspace); await options.fileWorkspace.prepare(cwd);
    await journal.recordIntent(intent);
    const result = spawnSync(config.command[0]!, [...config.command.slice(1), 'exec', '--cd', cwd], { cwd, input: body, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const value = await options.fileWorkspace.collect(cwd, intent, { text: 'Synthetic Word files saved.' });
    assert.equal(options.validate(value), true);
    const ref = await journal.storeResult(intent, Buffer.from(JSON.stringify(value)), options.resultSchemaVersion);
    await journal.recordObservation({ ...intent, ...ref, provider_request_id: null, finish_reason: 'stop', outcome: 'completed', error_code: null,
      usage: { status: 'measured', input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_tokens: 0, total_tokens: 150 } });
    return { kind: 'done', value, checkpoint: { logical_call_id: options.logicalCallId, prompt_snapshot_ref: snapshot } };
  } });
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  for (const contained of [false, true]) test(`${kind}: ${contained ? 'real contained' : 'synthetic provider with real worker'} V1 Word → user pause → supplement receipt → adoption → V2 Word and crash replay`,
    { skip: contained ? containedSkip : !database || spawnSync(python, ['-c', 'import docx,lxml'], { stdio: 'ignore' }).status !== 0,
      timeout: 240000 }, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'bb-successor-cli-')), marker = join(scratch, 'calls.jsonl');
      const config: CodexAdapterConfig = { ...baseConfig, command: [process.execPath,
        fileURLToPath(new URL('../test-fixtures/codex/supplement-word-files.mjs', import.meta.url)), `--marker=${marker}`, `--python=${python}`, `--repo=${root}`],
        work_root: scratch, timeout_ms: 30000, authoring_timeout_ms: 60000 };
      const actualMethod = await buildM4Method('document', loadM4RuntimeSkill('m4-underwriter'), config);
      const f = kind === 'authoring' ? await authoringFixture()
        : await createRunSupplementFilePreparationFixture(database!, kind, { nonProduction: true, method: actualMethod, earlyPause: 'before_prompt',
          ...(kind === 'review' ? { operation: 'differential_review' as const } : {}) });
      try {
        if (kind !== 'authoring') await action(f.pool, f.owner, f.runId, 'resume');
        const modelOptions = { config, ...(contained ? {} : { model: localSyntheticModel(config) }) };
        const model = kind === 'authoring' ? fileAuthoringStage(modelOptions) : kind === 'review' ? reviewFileStage(modelOptions) : m4DocumentStage(modelOptions);
        const delivery = kind === 'authoring' ? fileAuthoringDeliveryStage() : kind === 'review' ? historicalWordDeliveryStage() : m4DocumentDeliveryStage();
        let stageError: unknown;
        const trace = (stage: RunStage): RunStage => ({ ...stage, run: async ctx => {
          try { return await stage.run(ctx); } catch (error) { stageError = error; throw error; }
        } });
        const stages: RunStage[] = [inputLockStage, materialsReadyStage, trace(model), trace(delivery)];
        let v1Lease: Lease | undefined;
        const execute = (afterStage?: (stage: string, lease: Lease) => Promise<void>) => runPipelineOnce({ pool: f.pool, blobs: f.blobs, stages,
          testRuleCapabilityLoader: capability, leaseSeconds: 300, afterStage, onUnexpectedError: error =>
            assert.fail(stageError instanceof Error ? stageError.stack : stageError ? String(stageError) : JSON.stringify(error)) });
        assert.equal(await execute(async (stage, lease) => {
          if (stage === 'word_promoted') { v1Lease = lease; await action(f.pool, f.owner, f.runId, 'pause'); }
        }), 'paused');
        assert.ok(v1Lease);
        const v1Artifacts = (await f.pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id', [f.owner, f.runId])).rows;
        assert.ok(v1Artifacts.length > 0);
        const saved = await f.save(kind === 'authoring' ? 0 : 1);
        const checkpoint = (await f.pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0].checkpoint;
        const preparationInput: PreparationInput = { db: f.pool, blobs: f.blobs, owner: f.owner, projectId: f.projectId, runId: f.runId,
          revision: saved.revision, expectedCheckpointHash: inputManifestHash(checkpoint), expectedCandidateInputHash: saved.input_preview.candidate_input_hash };
        const { basis, target, adoption } = await adopt(f, preparationInput, kind);
        assert.ok(basis.priorWork);
        const logical = kind === 'authoring' ? 'file-authoring-v1' : kind === 'review' ? 'review-file-v1' : 'm4-document-v1';
        const oldAttempt = (await f.pool.query('SELECT id FROM bb_model_call_attempts WHERE job_id=$1 AND logical_call_id=$2', [f.jobId, logical])).rows[0];
        const staleBytes = kind === 'm4' ? makeWorkerDocxFixture({ externalLink: true }) : Buffer.from('Synthetic stale V1 write');
        const staleName = kind === 'authoring' ? 'delivery.md' : kind === 'review' ? 'report.md' : 'document.docx';
        const schema = kind === 'authoring' ? 'codex-file-word-v1' : kind === 'review' ? 'codex-review-file-v1' : 'codex-m4-document-v1';
        const folder = kind === 'authoring' ? 'file-authoring' : kind === 'review' ? 'review-files' : 'm4-documents';
        await assert.rejects(writeRunWorkingFile({ pool: f.pool, blobs: f.blobs, lease: v1Lease, projectId: f.projectId,
          source: { kind: 'provider', attemptId: oldAttempt.id, resultSchemaVersion: schema }, name: staleName,
          key: `owners/${f.owner}/projects/${f.projectId}/runs/${f.runId}/${folder}/${oldAttempt.id}/${digest(staleBytes)}/${staleName}`,
          bytes: staleBytes, mediaType: kind === 'm4' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown' }),
        { code: 'INPUT_REVISION_CONFLICT' });
        await assert.rejects(execute(async stage => { if (stage === 'model_generation') throw Error('SYNTHETIC_CRASH'); }), /SYNTHETIC_CRASH/);
        await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.jobId]);
        assert.equal(await execute(), 'test_completed');
        const calls = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(calls.length, 2, 'V2 crash replay must not execute a third CLI');
        assert.equal(calls[0].continuation, null); assert.equal(calls[1].continuation, basis.basisHash);
        assert.equal(calls[1].input_hash, target.inputHash);
        assert.equal(calls[1].materials.includes(f.added.material_id), true);
        const attempts = (await f.pool.query(`SELECT a.*,b.execution_version FROM bb_model_call_attempts a
          JOIN bb_model_call_execution_bindings b ON b.attempt_id=a.id WHERE a.job_id=$1 ORDER BY b.execution_version`, [f.jobId])).rows;
        assert.deepEqual(attempts.map(row => [row.execution_version, row.logical_call_id, row.attempt_no, row.status]), [[1, logical, 1, 'completed'], [2, logical, 2, 'completed']]);
        const prompts = (await f.pool.query("SELECT execution_version,input_revision,input_hash FROM bb_snapshot_refs WHERE owner_user_id=$1 AND run_id=$2 AND snapshot_kind='model_request' ORDER BY execution_version", [f.owner, f.runId])).rows;
        assert.deepEqual(prompts.map(row => [row.execution_version, row.input_revision, row.input_hash.trim()]), [[1, v1Lease.inputRevision, f.hash], [2, target.inputRevision, target.inputHash]]);
        const v2Artifacts = (await f.pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND execution_version=2', [f.owner, f.runId])).rows;
        assert.ok(v2Artifacts.length > 0);
        for (const artifact of v2Artifacts) {
          assert.equal(artifact.input_revision, target.inputRevision); assert.equal(artifact.input_hash.trim(), target.inputHash);
          assert.equal(v1Artifacts.some(old => old.id === artifact.id), false);
          assert.equal(digest(f.objects.get(artifact.object_key)!), artifact.sha256.trim());
        }
        if (kind === 'authoring') {
          assert.ok(v2Artifacts.some(row => v1Artifacts.some(old => old.sha256.trim() === row.sha256.trim())),
            'identical V1/V2 Word bytes still need different immutable artifact identities');
          const pair = readExecutionStages((await f.pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0].checkpoint, target).word_delivery_pair;
          assert.equal(pair?.baseline_kind, 'saved_clean_work');
          assert.equal(pair?.source_sha256, basis.priorWork.files.find(pin => pin.name === 'clean.docx')!.sha256);
        }
        assert.deepEqual((await f.pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=ANY($3::text[]) ORDER BY id',
          [f.owner, f.runId, v1Artifacts.map(row => row.id)])).rows, v1Artifacts);
        const receipt = (await f.pool.query("SELECT * FROM bb_run_execution_deliveries WHERE run_id=$1 AND execution_version=2 AND delivery_phase='final'", [f.runId])).rows[0];
        assert.ok(receipt); assert.equal(receipt.input_revision, target.inputRevision); assert.equal(receipt.input_hash.trim(), target.inputHash);
        assert.equal(receipt.channel, 'non_production_test'); assert.equal(receipt.terminal_state, 'test_completed'); assert.equal(receipt.test_grant_id, adoption.testGrantId);
        const members = (await f.pool.query("SELECT * FROM bb_run_execution_delivery_artifacts WHERE run_id=$1 AND execution_version=2 AND delivery_phase='final' ORDER BY role", [f.runId])).rows;
        assert.deepEqual(members.map(row => row.role), kind === 'authoring' ? ['clean', 'revision'] : kind === 'review' ? ['comments', 'report'] : ['document', 'preparation_note']);
        assert.equal(receipt.artifact_manifest.length, members.length);
        for (const member of members) {
          assert.equal(member.input_revision, target.inputRevision); assert.equal(member.input_hash.trim(), target.inputHash);
          assert.equal(v2Artifacts.some(row => row.id === member.artifact_id && row.version === member.artifact_version), true);
        }
        // The delivered authority is the successor's exact grant, independently
        // of the old run row and old grant. Download every frozen member.
        const originGrant = (await f.pool.query('SELECT test_grant_id FROM bb_runs WHERE id=$1', [f.runId])).rows[0].test_grant_id;
        assert.notEqual(originGrant, adoption.testGrantId);
        await f.pool.query("UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_worker',revoked_reason='Original grant must not control V2 delivery' WHERE grant_id=$1", [originGrant]);
        let actor = f.owner;
        const viewer = createServer({ pool: f.pool, blobs: f.blobs, allowedOrigin: 'http://bondbuddy.test',
          principal: async () => ({ userId: actor, csrfVerified: true }) });
        try {
          const urls = [];
          for (const member of members) {
            const response = await viewer.inject({ method: 'GET', url: `/api/v1/artifacts/${member.artifact_id}` });
            assert.equal(response.statusCode, 200, response.body); const descriptor = response.json(); urls.push(descriptor.download_url);
            assert.equal(descriptor.sha256, member.artifact_sha256.trim()); assert.equal(descriptor.delivery_status, 'test_only');
            const download = await viewer.inject({ method: 'GET', url: descriptor.download_url });
            assert.equal(download.statusCode, 200, download.body); assert.equal(digest(download.rawPayload), member.artifact_sha256.trim());
            const filename = /filename\*=UTF-8''([^;]+)/.exec(String(download.headers['content-disposition']))?.[1];
            assert.ok(filename); assert.equal(decodeURIComponent(filename), descriptor.filename);
            actor = `${f.owner}-foreign`;
            assert.equal((await viewer.inject({ method: 'GET', url: descriptor.download_url })).statusCode, 404);
            actor = f.owner;
          }
          await f.pool.query("UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_worker',revoked_reason='Close V2 downloads' WHERE grant_id=$1", [adoption.testGrantId]);
          for (const url of urls) assert.equal((await viewer.inject({ method: 'GET', url })).statusCode, 404);
          assert.deepEqual((await f.pool.query("SELECT * FROM bb_run_execution_deliveries WHERE run_id=$1 AND execution_version=2 AND delivery_phase='final'", [f.runId])).rows[0], receipt);
        } finally { await viewer.close(); }
      } finally { await action(f.pool, f.owner, f.runId, 'cancel').catch(() => undefined); await f.cleanup(); await rm(scratch, { recursive: true, force: true }); }
    });
}
