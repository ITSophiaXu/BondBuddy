// Production-channel authority, public B1 consent and real worker persistence.
// Only the provider process and private input/Word bytes are synthetic. These
// cases do not claim a real supplier, payment, sandbox or production acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_FIXED_PRICES, emptyUpdateDetails, type RunSupplementDraftResponse } from '@bondbuddy/contracts';
import { createServer } from '@bondbuddy/api';
import { digest, transaction, uid } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { action, type Lease } from '@bondbuddy/api/queue';
import { readExecutionStages } from '@bondbuddy/api/run-execution';
import { loadRunSupplementProcessingBasis } from '@bondbuddy/api/run-supplement-preparation';
import { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { publishPrices, reserveCredits } from '../../api/dist/billing.js';
import { quoteM4, reserveM4, readM4CreditCharge, settleM4Metering } from '@bondbuddy/api/m4-billing';
import { createRunSupplementPreparationTestContext, type RunSupplementBeforeClaim } from '../../api/dist/run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from '../../api/dist/run-supplement-file-preparation-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadCodexAdapterConfig, type CodexAdapterConfig } from './codex-adapter.js';
import { buildM4Method } from './m4-method.js';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { reviewFileStage } from './review-file-stage.js';
import { fileAuthoringStage, fileAuthoringDeliveryStage } from './file-authoring-stage.js';
import { m4DocumentStage, m4DocumentDeliveryStage } from './m4-document-stage.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { codexModelStage, inputLockStage, materialsReadyStage, runPipelineOnce, type RunStage } from './run-pipeline.js';
import type { runContainedModelCall } from './codex-adapter.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';

const database = await isolatedTestDatabase(undefined, 'supplement-production-worker');
const baseConfig = loadCodexAdapterConfig({});
const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const origin = 'http://bondbuddy.test';
const python = process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? '/opt/venv/bin/python';
const skip = !database ? 'requires an isolated migrated PostgreSQL template'
  : spawnSync(python, ['-c', 'import docx,lxml'], { stdio: 'ignore' }).status !== 0 ? 'requires Python Word modules' : false;
type Kind = 'authoring' | 'review' | 'm4';
type Scope = Pick<Awaited<ReturnType<typeof createRunSupplementPreparationTestContext>>, 'pool' | 'blobs' | 'owner' | 'app'> &
  { projectId: string; runId: string; jobId: string };
const ok = (response: { statusCode: number; body: string; json(): any }) => {
  assert.equal(response.statusCode, 200, response.body); return response.json();
};

async function authenticated(f: Scope) {
  const access = uid(), csrf = uid();
  await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,
  [uid(), f.owner, digest(access), digest(uid()), digest(csrf)]);
  return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => f.app.inject({ method, url, payload: payload as any,
    headers: { origin, cookie: `bb_session=${access}; bb_csrf=${csrf}`, 'x-bb-csrf': csrf } });
}

/** Use the original reservation helpers before the first lease or provider
 * history. No billing pointer or policy is rewritten after immutable capture. */
async function prices(pool: Scope['pool']) {
  const price = uid();
  await publishPrices(pool, { id: price, prices: { ...INITIAL_FIXED_PRICES, new_authoring: 4500,
    full_review: 4500, differential_review: 4500 }, effectiveAt: new Date().toISOString(),
  actor: 'synthetic-worker', reason: 'Private production-channel worker fixture' });
  return price;
}
function paidSource(kind: Kind): RunSupplementBeforeClaim {
  return async ({ pool, owner, projectId, runId, manifest }) => {
    const price = await prices(pool);
    await transaction(pool, async db => {
      const project = (await db.query('SELECT * FROM bb_projects WHERE id=$1 FOR UPDATE', [projectId])).rows[0];
      const run = (await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
      await db.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE', [runId]);
      if (kind === 'm4') {
        const hash = inputManifestHash(manifest), result = await quoteM4(db, owner, manifest.topic_id, manifest.billing_task, hash, manifest);
        await reserveM4(db, owner, run, result.quote.quote_id, manifest.topic_id, hash);
      } else {
        // Review quotation precedes its immutable worker manifest in the public
        // execution path, so its pin is a business-intent hash, not the run hash.
        const intent = kind === 'review' ? inputManifestHash({ project_id: projectId, draft_revision: manifest.draft_revision,
          operation: manifest.review.operation, input: manifest.review.input, origin: manifest.review.origin }) : null;
        const quote = uid();
        await db.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason,intent_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,4500,'Synthetic original execution quotation',$8)`,
        [quote, owner, projectId, kind === 'review' ? manifest.draft_revision : run.input_revision, intent ?? run.input_hash,
          price, kind === 'review' ? manifest.review.operation : 'new_authoring', intent]);
        await reserveCredits(db, owner, run, quote, { revision: run.input_revision, manifest }, project, intent ?? undefined);
      }
    });
  };
}

/** Complete M1 target periods; all ordinary production input gates remain in
 * use. The shared preparation fixture deliberately has a smaller target scope. */
async function authoringFixture(paid: boolean) {
  const c = await createRunSupplementPreparationTestContext(database!), { pool, blobs, owner, app } = c;
  try {
    const projectId = uid(), runId = uid(), jobId = uid();
    const scope = { pool, blobs, owner, app, projectId, runId, jobId };
    const send = await authenticated(scope), docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
      VALUES($1,$2,'Synthetic production supplement','update','Frozen issuer','sse','private',1)`, [projectId, owner]);
    const material = async () => {
      const material_id = uid(), upload = uid(), bytes = makeWorkerDocxFixture({ externalLink: false }), sha256 = digest(bytes);
      const objectKey = `users/${owner}/projects/${projectId}/materials/${material_id}/1`;
      await blobs.put(objectKey, bytes, docx);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.docx',$4,$5,$6,'audit',$7,now()+interval '1 hour','completed')`,
      [upload, owner, projectId, docx, bytes.length, sha256, `${objectKey}/upload`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'audit','synthetic.docx',$5,$6,$7,$8,'persisted')`,
      [material_id, owner, projectId, upload, docx, bytes.length, sha256, objectKey]);
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
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,channel)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued','production')`, [runId, owner, projectId, hash, uid(), digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,channel)
      VALUES($1,$2,$3,'update','default','queued','queued','production')`, [jobId, owner, runId]);
    if (paid) await paidSource('authoring')({ pool, owner, projectId, runId, jobId, manifest });
    else await prices(pool);
    return { ...scope, hash, manifest, objects: c.objects, added,
      save: async (expectedRevision = 0): Promise<RunSupplementDraftResponse> => ok(await send('PUT', `/api/v1/runs/${runId}/supplement-draft`, {
        request_id: uid(), expected_revision: expectedRevision, base_input_revision: 1, base_input_hash: hash,
        changes: [{ material: { material_id: added.material_id, material_version: 1, sha256: added.sha256 }, replaces: null }] })),
      cleanup: c.close };
  } catch (error) { await c.close(); throw error; }
}

/** Explicit provider seam. Real prompt snapshots, durable attempts/results,
 * request builders, working-file writers and delivery stages execute unchanged. */
function syntheticModel(config: CodexAdapterConfig, unknownSuccessor: boolean): typeof codexModelStage {
  const runContainedCall: typeof runContainedModelCall = async (input, journal) => {
    const prior = await journal.latestAttempt(input.logical_call_id);
    if (prior) {
      assert.equal(prior.status, 'completed');
      const saved = await journal.readCompleted(input.logical_call_id, prior.attempt_no); assert.ok(saved);
      return { status: 'reused', value: saved.value, error_code: null, attempts: [], thread_id: null, codex_home: null };
    }
    assert.ok(journal.attemptState); const state = await journal.attemptState(input.logical_call_id);
    const intent = { owner_user_id: input.owner_user_id, project_id: input.project_id, job_id: input.job_id,
      run_id: input.run_id, trace_id: input.trace_id, logical_call_id: input.logical_call_id, call_id: uid(), attempt_no: state.next_attempt_no,
      model_id: config.model_id, model_config_version: config.model_config_version, prompt_snapshot_ref: input.prompt_snapshot_ref };
    const cwd = join(config.work_root, intent.call_id); await mkdir(cwd);
    assert.ok(input.fileWorkspace); await input.fileWorkspace.prepare(cwd);
    await journal.recordIntent(intent);
    const result = spawnSync(config.command[0]!, [...config.command.slice(1), 'exec', '--cd', cwd], { cwd, input: input.prompt, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const value = await input.fileWorkspace.collect(cwd, intent, { text: 'Synthetic Word files saved.' });
    const ref = await journal.storeResult(intent, Buffer.from(JSON.stringify(value)), input.result_schema_version);
    const workspace = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    const unknown = unknownSuccessor && !!workspace.continuation;
    await journal.recordObservation({ ...intent, ...ref, provider_request_id: null, finish_reason: 'stop',
      outcome: unknown ? 'pending_reconcile' : 'completed', error_code: unknown ? 'MODEL_USAGE_PENDING' : null,
      usage: unknown ? { status: 'unknown', input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null, total_tokens: null }
        : { status: 'measured', input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_tokens: 0, total_tokens: 150 } });
    // The real model stage must recover the completed, price-bound result while
    // the provider's cost evidence remains unknown. Returning done here would
    // skip the consumer branch these free-origin cases need to exercise.
    return { status: unknown ? 'needs_reconcile' : 'completed', value: unknown ? null : value,
      error_code: unknown ? 'MODEL_USAGE_PENDING' : null, attempts: [], thread_id: null, codex_home: null };
  };
  return options => codexModelStage({ ...options, runContainedCall });
}

for (const {kind, paid, unknownSuccessor} of [
  { kind: 'authoring', paid: true, unknownSuccessor: false }, { kind: 'review', paid: true, unknownSuccessor: false },
  { kind: 'm4', paid: true, unknownSuccessor: false }, { kind: 'authoring', paid: false, unknownSuccessor: true },
  { kind: 'm4', paid: false, unknownSuccessor: true },
] as const) test(`${kind}: ${paid ? 'paid' : 'free'} origin public positive B1 adoption makes a fresh production Word${unknownSuccessor ? ' with unknown usage recovery' : ''} and replays without another call`,
  { skip, timeout: 240000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'bb-production-successor-')), marker = join(scratch, 'calls.jsonl');
    const config: CodexAdapterConfig = { ...baseConfig, command: [process.execPath,
      fileURLToPath(new URL('../test-fixtures/codex/supplement-word-files.mjs', import.meta.url)), `--marker=${marker}`, `--python=${python}`, `--repo=${root}`],
      work_root: scratch, timeout_ms: 30000, authoring_timeout_ms: 60000 };
    const method = await buildM4Method('document', loadM4RuntimeSkill('m4-underwriter'), config);
    const f = kind === 'authoring' ? await authoringFixture(paid)
      : await createRunSupplementFilePreparationFixture(database!, kind, { method, earlyPause: 'before_prompt', beforeClaim: paid ? paidSource(kind) : async ({pool}) => { await prices(pool); },
        ...(kind === 'review' ? { operation: 'differential_review' as const } : {}) });
    try {
      if (kind !== 'authoring') await action(f.pool, f.owner, f.runId, 'resume');
      const originalRun = (await f.pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0];
      assert.equal(originalRun.channel, 'production'); assert.equal(originalRun.test_grant_id, null);
      if (paid) assert.ok(originalRun.reservation_id);
      else { assert.equal(originalRun.reservation_id, null); assert.equal(originalRun.billing_mode, 'platform_trial'); }
      const modelOptions = { config, model: syntheticModel(config, unknownSuccessor) };
      const model = kind === 'authoring' ? fileAuthoringStage(modelOptions) : kind === 'review' ? reviewFileStage(modelOptions) : m4DocumentStage(modelOptions);
      const delivery = kind === 'authoring' ? fileAuthoringDeliveryStage() : kind === 'review' ? historicalWordDeliveryStage() : m4DocumentDeliveryStage();
      let stageError: unknown;
      const trace = (stage: RunStage): RunStage => ({ ...stage, run: async ctx => {
        try { return await stage.run(ctx); } catch (error) { stageError = error; throw error; }
      } });
      const stages = [inputLockStage, materialsReadyStage, trace(model), trace(delivery)];
      let v1Lease: Lease | undefined;
      const execute = (afterStage?: (stage: string, lease: Lease) => Promise<void>) => runPipelineOnce({ pool: f.pool, blobs: f.blobs,
        stages, leaseSeconds: 300, afterStage, onUnexpectedError: error =>
          assert.fail(stageError instanceof Error ? stageError.stack : stageError ? String(stageError) : JSON.stringify(error)) });
      assert.equal(await execute(async (stage, lease) => {
        if (stage === 'word_promoted') { v1Lease = lease; await action(f.pool, f.owner, f.runId, 'pause'); }
      }), 'paused');
      assert.ok(v1Lease);
      const v1Artifacts = (await f.pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id', [f.owner, f.runId])).rows;
      assert.ok(v1Artifacts.length > 0);
      const saved = await f.save(kind === 'authoring' ? 0 : 1);
      const originalBytes = new Map([...f.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]));
      const checkpoint = (await f.pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0].checkpoint;
      const basis = await loadRunSupplementProcessingBasis({ db: f.pool, blobs: f.blobs, owner: f.owner, projectId: f.projectId, runId: f.runId,
        revision: saved.revision, expectedCheckpointHash: inputManifestHash(checkpoint),
        expectedCandidateInputHash: saved.input_preview.candidate_input_hash! }, kind);
      assert.ok(basis.priorWork);
      const send = await authenticated(f), base = `/api/v1/runs/${f.runId}`;
      const quoted = ok(await send('POST', `${base}/supplement-quotes`, { request_id: uid(), supplement_revision: saved.revision,
        saved_request_id: saved.request_id, candidate_input_hash: saved.input_preview.candidate_input_hash }));
      assert.equal(quoted.quote.total_points, 4500); assert.equal(quoted.quote.items[0].needs_redo, true);
      const accepted = ok(await send('POST', `${base}/supplement-quotes/${quoted.quote.quote_id}/confirm`,
        { request_id: uid(), quote_hash: quoted.quote.quote_hash }));
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_model_call_attempts WHERE job_id=$1', [f.jobId])).rows[0].n, 1);
      const request = { request_id: uid(), quote_id: quoted.quote.quote_id, confirmation_id: accepted.confirmation.confirmation_id, quote_hash: quoted.quote.quote_hash };
      const adopted = ok(await send('POST', `${base}/supplement-adoptions`, request)).adoption;
      assert.deepEqual(ok(await send('POST', `${base}/supplement-adoptions`, request)).adoption, adopted);
      assert.equal(adopted.assignment_kind, 'rework'); assert.equal(adopted.additional_points, 4500);
      assert.notEqual(adopted.billing_segment_id, originalRun.reservation_id);
      const currentCharge = ok(await send('GET', `${base}/credit-charge`));
      assert.equal(currentCharge.state, 'held'); assert.equal(currentCharge.progress.policy, 'authoring_balance_v2');
      assert.equal(currentCharge.progress.charged_points, 0);
      if (kind === 'm4') {
        const charge = await readM4CreditCharge(f.pool, f.owner, f.runId);
        assert.equal(charge.state, 'held'); assert.equal(charge.quote?.quote_id, quoted.quote.quote_id);
        assert.equal(charge.quote?.input_hash, adopted.input_hash); assert.equal(charge.quote?.points, 4500);
        assert.equal(charge.quote?.price_version, quoted.quote.items[0].price_version);
        assert.equal(charge.quote?.task_type, (f.manifest as any).billing_task);
        assert.equal(charge.quote?.topic_id, (f.manifest as any).topic_id);
        assert.deepEqual(await settleM4Metering(f.pool, f.owner, f.runId), { ready: true, charged_points: 4500 });
        assert.equal((await readM4CreditCharge(f.pool, f.owner, f.runId)).state, 'held', 'meter readiness does not settle a held fee');
      } else {
        assert.equal(currentCharge.quote.quote_id, quoted.quote.quote_id); assert.equal(currentCharge.quote.points, 4500);
      }
      const closedOriginal = paid ? (await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1', [originalRun.reservation_id])).rows[0] : null;
      if (paid) assert.equal(closedOriginal.state, 'settled');
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
      assert.equal(await execute(), 'succeeded');
      const calls = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.length, 2, 'crash replay reuses the saved V2 result');
      assert.equal(calls[0].continuation, null); assert.equal(calls[1].continuation, basis.basisHash);
      assert.equal(calls[1].input_hash, adopted.input_hash); assert.equal(calls[1].materials.includes(f.added.material_id), true);
      const attempts = (await f.pool.query(`SELECT a.*,b.execution_version FROM bb_model_call_attempts a
        JOIN bb_model_call_execution_bindings b ON b.attempt_id=a.id WHERE a.job_id=$1 ORDER BY b.execution_version`, [f.jobId])).rows;
      assert.deepEqual(attempts.map(row => [row.execution_version, row.logical_call_id, row.attempt_no, row.status]),
        [[1, logical, 1, 'completed'], [2, logical, 2, 'completed']]);
      assert.notEqual(attempts[0].id, attempts[1].id);
      const v1Workspace = JSON.parse(await readFile(join(scratch, attempts[0].id, 'input.json'), 'utf8'));
      const v2Workspace = JSON.parse(await readFile(join(scratch, attempts[1].id, 'input.json'), 'utf8'));
      assert.equal(v1Workspace.input_hash, f.hash); assert.equal(v2Workspace.input_hash, adopted.input_hash);
      assert.equal(v2Workspace.continuation.basis_hash, basis.basisHash);
      for (const file of basis.priorWork.files)
        assert.deepEqual(await readFile(join(scratch, attempts[1].id, 'previous_work', file.name)), originalBytes.get(file.key));
      if (kind === 'review') {
        assert.equal(v2Workspace.scope.operation, 'differential_review');
        assert.equal(v2Workspace.scope.source_report_id, (f.manifest as any).review.source_report_id);
        assert.deepEqual(v2Workspace.scope.selected_findings.map((finding: any) => finding.finding_id), (f.manifest as any).review.finding_ids);
      }
      if (kind === 'm4') {
        assert.deepEqual(v2Workspace.task.input.source_material, (f.manifest as any).input.source_material);
        assert.deepEqual(v2Workspace.task.input.template, (f.manifest as any).input.template);
      }
      const prompts = (await f.pool.query(`SELECT execution_version,input_revision,input_hash FROM bb_snapshot_refs
        WHERE owner_user_id=$1 AND run_id=$2 AND snapshot_kind='model_request' ORDER BY execution_version`, [f.owner, f.runId])).rows;
      assert.deepEqual(prompts.map(row => [row.execution_version, row.input_revision, row.input_hash.trim()]),
        [[1, v1Lease.inputRevision, f.hash], [2, adopted.input_revision, adopted.input_hash]]);
      const v2Artifacts = (await f.pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND execution_version=2', [f.owner, f.runId])).rows;
      assert.ok(v2Artifacts.length > 0);
      for (const artifact of v2Artifacts) {
        assert.equal(artifact.input_revision, adopted.input_revision); assert.equal(artifact.input_hash.trim(), adopted.input_hash);
        assert.equal(v1Artifacts.some(old => old.id === artifact.id), false);
        assert.equal(digest(f.objects.get(artifact.object_key)!), artifact.sha256.trim());
      }
      if (kind === 'authoring') {
        assert.ok(v2Artifacts.some(row => v1Artifacts.some(old => old.sha256.trim() === row.sha256.trim())),
          'identical Word bytes retain separate execution artifact identities');
        const pair = readExecutionStages((await f.pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0].checkpoint,
          { executionVersion: 2, inputRevision: adopted.input_revision, inputHash: adopted.input_hash }).word_delivery_pair;
        assert.equal(pair?.baseline_kind, 'saved_clean_work');
        assert.equal(pair?.source_sha256, basis.priorWork.files.find(pin => pin.name === 'clean.docx')!.sha256);
      }
      assert.deepEqual((await f.pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=ANY($3::text[]) ORDER BY id',
        [f.owner, f.runId, v1Artifacts.map(row => row.id)])).rows, v1Artifacts);
      for (const [key, bytes] of originalBytes) assert.deepEqual(f.objects.get(key), bytes, `historical private bytes: ${key}`);
      const receipt = (await f.pool.query("SELECT * FROM bb_run_execution_deliveries WHERE run_id=$1 AND execution_version=2 AND delivery_phase='final'", [f.runId])).rows[0];
      assert.ok(receipt); assert.equal(receipt.input_revision, adopted.input_revision); assert.equal(receipt.input_hash.trim(), adopted.input_hash);
      assert.equal(receipt.channel, 'production'); assert.equal(receipt.terminal_state, 'succeeded'); assert.equal(receipt.test_grant_id, null);
      const members = (await f.pool.query("SELECT * FROM bb_run_execution_delivery_artifacts WHERE run_id=$1 AND execution_version=2 AND delivery_phase='final' ORDER BY role", [f.runId])).rows;
      assert.deepEqual(members.map(row => row.role), kind === 'authoring' ? ['clean', 'revision'] : kind === 'review' ? ['comments', 'report'] : ['document', 'preparation_note']);
      assert.equal(receipt.artifact_manifest.length, members.length);
      for (const member of members) assert.ok(v2Artifacts.some(row => row.id === member.artifact_id && row.version === member.artifact_version));
      const completedRun = (await f.pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0];
      assert.equal(completedRun.reservation_id, originalRun.reservation_id); assert.equal(completedRun.billing_mode, originalRun.billing_mode);
      assert.equal(completedRun.input_hash, originalRun.input_hash); assert.equal(completedRun.input_revision, originalRun.input_revision);
      if (paid) assert.deepEqual((await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1', [originalRun.reservation_id])).rows[0], closedOriginal);
      const fee = (await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1', [adopted.reservation_id])).rows[0];
      assert.equal(fee.billing_policy, 'authoring_balance_v2'); assert.equal(Number(fee.points), 4500);
      assert.equal(fee.state, 'settled'); assert.equal(Number(fee.charged_points), 4500);
      assert.equal(ok(await send('GET', `${base}/credit-charge`)).state, 'settled');
      if (kind === 'm4') {
        const charge = await readM4CreditCharge(f.pool, f.owner, f.runId);
        assert.equal(charge.state, 'settled'); assert.equal(charge.quote?.quote_id, quoted.quote.quote_id);
        assert.equal(charge.quote?.input_hash, adopted.input_hash); assert.equal(charge.progress?.charged_points, 4500);
        assert.deepEqual(await settleM4Metering(f.pool, f.owner, f.runId), { ready: true, charged_points: 4500 });
      }
      const bindings = (await f.pool.query('SELECT * FROM bb_run_execution_billing_bindings WHERE run_id=$1 ORDER BY execution_version', [f.runId])).rows;
      assert.deepEqual(bindings.map(row => [row.execution_version, row.billing_segment_id, row.assignment_kind]),
        [...(paid ? [[1, originalRun.reservation_id, 'original']] : []), [2, adopted.reservation_id, 'rework']]);
      if (unknownSuccessor) {
        const usage = (await f.pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1', [attempts[1].id])).rows[0];
        assert.equal(usage.usage_status, 'unknown', 'fixed-price work is recoverable without inventing measured provider usage');
        assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2', [f.owner, f.runId])).rows[0].n, 1);
      }
      let actor = f.owner;
      const viewer = createServer({ pool: f.pool, blobs: f.blobs, allowedOrigin: origin,
        principal: async () => ({ userId: actor, csrfVerified: true }) });
      try {
        for (const member of members) {
          const descriptor = ok(await viewer.inject({ method: 'GET', url: `/api/v1/artifacts/${member.artifact_id}` }));
          assert.equal(descriptor.sha256, member.artifact_sha256.trim()); assert.equal(descriptor.delivery_status, 'available');
          const download = await viewer.inject({ method: 'GET', url: descriptor.download_url });
          assert.equal(download.statusCode, 200, download.body); assert.equal(digest(download.rawPayload), member.artifact_sha256.trim());
          if (kind === 'm4') {
            const dedicated = await viewer.inject({ method: 'GET', url: `/api/v1/m4/artifacts/${member.artifact_id}/versions/${member.artifact_version}/bytes` });
            assert.equal(dedicated.statusCode, 200, dedicated.body); assert.equal(digest(dedicated.rawPayload), member.artifact_sha256.trim());
          }
          actor = `${f.owner}-foreign`;
          assert.equal((await viewer.inject({ method: 'GET', url: descriptor.download_url })).statusCode, 404); actor = f.owner;
        }
        // Receipt replay and static historical artifact origin outlive the paid
        // active phase; settlement must not hide a successful V2 download.
        assert.deepEqual(ok(await send('GET', `${base}/supplement-adoptions?request_id=${encodeURIComponent(request.request_id)}`)).adoption, adopted);
      } finally { await viewer.close(); }
    } finally {
      await action(f.pool, f.owner, f.runId, 'cancel').catch(() => undefined); await f.cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  });
