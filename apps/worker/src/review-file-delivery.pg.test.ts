import {fileAuthoringStage,fileAuthoringDeliveryStage} from './file-authoring-stage.js';
import {unifiedInputGate} from './unified-input.js';
// Synthetic materials/model; real PostgreSQL, private storage, contained process, Word and downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest } from '@bondbuddy/api/data';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { isolatedTestDatabase } from './test-database.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { inputLockStage, materialsReadyStage, runPipelineOnce, type RunPipelineDependencies } from './run-pipeline.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { reviewFileStage } from './review-file-stage.js';

const database = await isolatedTestDatabase(undefined, 'review-files');
const connection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const python = process.env.BONDBUDDY_TEST_PYTHON;
test('file-only review: immutable input → plain CLI → Word → crash recovery without resend → owner download',
  { skip: process.platform !== 'linux' || !database || !connection || !python, timeout: 180000 }, async () => {
    const pool = new Pool({ connectionString: database }), directory = await mkdtemp(join(tmpdir(), 'bb-review-file-pg-'));
    const container = `bb-review-file-${randomUUID().replaceAll('-', '')}`, blobs = azureBlobs(connection!, container);
    const owner = randomUUID(), marker = join(directory, 'calls.jsonl'); let active = owner;
    const origin = 'http://bondbuddy.test', app = createServer({ pool, blobs, allowedOrigin: origin, enableRunRuntime: true,
      principal: async () => ({ userId: active, csrfVerified: true }) });
    const send = (method: string, url: string, payload?: unknown, headers = {}) => app.inject({ method: method as never, url, payload: payload as never, headers: { origin, ...headers } });
    const config = { ...loadCodexAdapterConfig({}), command: [process.execPath, fileURLToPath(new URL('../test-fixtures/codex/review-files.mjs', import.meta.url)), `--marker=${marker}`],
      work_root: join(directory, 'calls'), authoring_timeout_ms: 60000, timeout_ms: 60000 };
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `rf_${randomUUID().slice(0, 8)}`]);
      const created = await send('POST', '/api/v1/projects', { kind: 'review', name: 'Synthetic file review', issuer_name: '合成目标发行人', market: 'sse', offering: 'private' });
      assert.equal(created.statusCode, 201, created.body); const project = created.json().project_id;
      const bytes = makeWorkerDocxFixture({ externalLink: false }), declared = { byte_size: bytes.length, sha256: digest(bytes) };
      const upload = await send('POST', `/api/v1/projects/${project}/materials/uploads`, { ...declared, filename: 'synthetic-source.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', role: 'historical' });
      assert.equal(upload.statusCode, 201, upload.body);
      assert.equal((await send('PUT', upload.json().upload_url, bytes, { 'content-type': 'application/octet-stream' })).statusCode, 204);
      const completed = await send('POST', `/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`, declared);
      assert.equal(completed.statusCode, 200, completed.body);
      const pin = { material_id: completed.json().material_id, material_version: 1, sha256: declared.sha256 };
      const input = { source_material_ref: pin, material_versions: [pin], requirements: ['original requirement'], as_of: '2026-10-05', evidence_links: [] };
      assert.equal((await send('PUT', `/api/v1/projects/${project}/review-draft`, { kind: 'input', expected_version: 0, input })).statusCode, 200);
      const request = { execution_request_id: randomUUID(), operation: 'full_review', expected_input_version: 1, source_report_id: null, expected_plan_version: null, finding_ids: [] };
      const first = await send('POST', `/api/v1/projects/${project}/review-executions`, request);
      assert.equal(first.statusCode, 200, first.body); const runId = first.json().run_id;
      assert.equal((await send('POST', `/api/v1/projects/${project}/review-executions`, request)).json().run_id, runId);
      const manifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1', [owner, project])).rows[0].manifest;
      assert.equal(manifest.review.file_delivery.version, 'review-file-v1');
      assert.ok(manifest.review.file_delivery.knowledge.some((k: { path: string }) => k.path.endsWith('sse-private-review.md')));
      assert.ok(manifest.review.file_delivery.knowledge.every((k: { markdown: string; sha256: string }) => digest(k.markdown) === k.sha256));
      assert.equal((await send('PUT', `/api/v1/projects/${project}/review-draft`, { kind: 'input', expected_version: 1, input: { ...input, requirements: ['late draft'] } })).statusCode, 200);
      // Deliberately leave the parser job queued: direct original files need no extraction stage.
      const execute = (afterStage?: RunPipelineDependencies['afterStage']) => runPipelineOnce({ pool, blobs, leaseSeconds: 60,
        stages: [inputLockStage, materialsReadyStage, reviewFileStage({ config }), historicalWordDeliveryStage()], afterStage,
        onUnexpectedError: error => assert.fail(JSON.stringify(error)) });
      await assert.rejects(execute(async stage => { if (stage === 'word_promoted') throw Error('SYNTHETIC_CRASH'); }), /SYNTHETIC_CRASH/);
      await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1 AND owner_user_id=$2", [runId, owner]);
      assert.equal(await execute(), 'succeeded');
      const calls = (await readFile(marker, 'utf8')).trim().split('\n'); assert.equal(calls.length, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_review_reports WHERE run_id=$1', [runId])).rows[0].n, 0);
      const response = await send('GET', `/api/v1/projects/${project}/review-workspace`);
      assert.equal(response.statusCode, 200, response.body); const workspace = response.json();
      assert.equal(workspace.selected_report, null); assert.equal(workspace.artifact_run.run_id, runId); assert.equal(workspace.artifacts.length, 1);
      const artifact = workspace.artifacts[0]; assert.equal(artifact.kind, 'report');
      const meta = await send('GET', `/api/v1/artifacts/${artifact.artifact_id}`);
      assert.equal(meta.statusCode, 200, meta.body); assert.equal(meta.json().run_id, runId);assert.equal(meta.json().filename,artifact.filename);assert.match(artifact.filename,/_复核报告_V1_[0-9]{8}\.docx$/);
      const download = await send('GET', meta.json().download_url);
      assert.equal(download.statusCode, 200, download.body); assert.equal(digest(download.rawPayload), meta.json().sha256);assert.ok(download.headers['content-disposition']?.includes(encodeURIComponent(artifact.filename)));
      const outputPath = join(directory, 'report.docx'); await writeFile(outputPath, download.rawPayload);
      const parsed = await promisify(execFile)(python!, ['-c', "import sys;from docx import Document;print('\\n'.join(p.text for p in Document(sys.argv[1]).paragraphs))", outputPath], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      assert.match(parsed.stdout, /合成金额100与120不一致/); assert.match(parsed.stdout, /公开检索未执行/);
      assert.equal((await send('GET', `/api/v1/projects/${project}/review-history`)).json().items[0].artifacts[0].artifact_id, artifact.artifact_id);
      assert.equal((await send('GET', `/api/v1/projects/${project}/review-history`)).json().items[0].artifacts[0].filename,artifact.filename);
      const readablePath = `/api/v1/projects/${project}/review-executions/${runId}/readable-report`;
      const readable = await send('GET', readablePath);
      assert.equal(readable.statusCode, 200, readable.body); assert.equal(readable.json().status, 'available');
      assert.match(readable.json().markdown, /合成金额100与120不一致/);
      assert.match(readable.json().markdown, /公开检索未执行/);
      assert.equal(readable.json().content_sha256, digest(Buffer.from(readable.json().markdown)));
      assert.equal(readable.headers['cache-control'], 'private, no-store');
      assert.ok(!readable.body.includes('owners/')); assert.ok(!readable.body.includes('result_ref'));
      assert.equal((await send('GET', `/api/v1/projects/${project}/review-executions/${randomUUID()}/readable-report`)).statusCode, 404);
      const saved = (await pool.query('SELECT result_ref FROM bb_provider_result_refs WHERE run_id=$1', [runId])).rows[0];
      const stored = await blobs.get(saved.result_ref), files = JSON.parse(stored.toString()).files;
      await blobs.delete(files['report.md'].key);
      assert.equal((await send('GET', readablePath)).json().status, 'unavailable');
      assert.equal((await send('GET', meta.json().download_url)).statusCode, 200, 'optional text failure preserves Word');
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'succeeded');
      assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1, 'reading never re-executes');
      const updateRequest={execution_request_id:randomUUID(),source_run_id:runId,requirements:'保留历史名称，依据复核报告修改本期金额。'};
      const updatePath=`/api/v1/projects/${project}/review-updates`;
      active=randomUUID();assert.equal((await send('POST',updatePath,updateRequest)).statusCode,404);active=owner;
      assert.equal((await send('POST',updatePath,{...updateRequest,source_run_id:randomUUID()})).statusCode,404);
      const updates=await Promise.all([send('POST',updatePath,updateRequest),send('POST',updatePath,updateRequest)]);
      for(const response of updates)assert.equal(response.statusCode,200,response.body);
      const update=updates[0].json();assert.equal(updates[1].json().run_id,update.run_id);
      assert.equal(update.billing_mode,'platform_trial');assert.equal(update.reservation_id,null);
      assert.equal((await send('POST',updatePath,{...updateRequest,requirements:'changed'})).statusCode,409);
      assert.equal((await send('POST',updatePath,{...updateRequest,execution_request_id:randomUUID()})).statusCode,409);
      const locked=(await pool.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[owner,project,update.input_revision])).rows[0];
      assert.deepEqual(locked.manifest.materials,manifest.materials);
      assert.equal(locked.manifest.authoring.review_result.artifact_id,artifact.artifact_id);
      assert.equal(locked.manifest.authoring.review_result.requirements,updateRequest.requirements);
      assert.equal(locked.manifest.update_details.reporting_cutoff,null,'missing metadata does not invent a date or block a report-scoped revision');
      const updateRow=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[update.run_id])).rows[0];
      assert.equal(await unifiedInputGate(pool,updateRow,locked),null);
      const corrupted=structuredClone(locked);corrupted.manifest.authoring.review_result.artifact_id=randomUUID();
      assert.deepEqual(await unifiedInputGate(pool,updateRow,corrupted),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
      const updateConfig={...config,command:[process.execPath,fileURLToPath(new URL('../test-fixtures/codex/fake-review-update.mjs',import.meta.url))]};
      const updateOnce=(afterStage?:RunPipelineDependencies['afterStage'])=>runPipelineOnce({pool,blobs,leaseSeconds:60,
        stages:[inputLockStage,materialsReadyStage,fileAuthoringStage({config:updateConfig}),fileAuthoringDeliveryStage()],afterStage,onUnexpectedError:error=>assert.fail(JSON.stringify(error))});
      await assert.rejects(updateOnce(async stage=>{if(stage==='word_promoted')throw Error('SYNTHETIC_CRASH');}),/SYNTHETIC_CRASH/);
      await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1 AND owner_user_id=$2",[update.run_id,owner]);
      assert.equal(await updateOnce(),'succeeded');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[update.run_id])).rows[0].n,1);
      const updatedWorkspace=(await send('GET',`/api/v1/projects/${project}/review-workspace`)).json();
      assert.equal(updatedWorkspace.artifact_run.source_run_id,runId);
      assert.deepEqual(updatedWorkspace.artifacts.map((a:any)=>a.kind).sort(),['clean','revision']);
      for(const item of updatedWorkspace.artifacts){const meta=await send('GET',`/api/v1/artifacts/${item.artifact_id}`);assert.equal(meta.statusCode,200,meta.body);const file=await send('GET',meta.json().download_url);assert.equal(file.statusCode,200);assert.equal(digest(file.rawPayload),meta.json().sha256);}
      assert.equal((await send('POST',updatePath,updateRequest)).json().run_id,update.run_id,'replay after completion returns the same paid-free revision');
      assert.equal((await send('GET',meta.json().download_url)).statusCode,200,'original report remains downloadable');
      active = randomUUID();
      assert.equal((await send('GET', readablePath)).statusCode, 404);
      assert.equal((await send('GET', `/api/v1/projects/${project}/review-workspace`)).statusCode, 404);
      assert.equal((await send('GET', `/api/v1/artifacts/${artifact.artifact_id}`)).statusCode, 404);
      assert.equal((await send('GET', meta.json().download_url)).statusCode, 404);
    } finally {
      await app.close(); await pool.end();
      await BlobServiceClient.fromConnectionString(connection!).getContainerClient(container).deleteIfExists();
      await rm(directory, { recursive: true, force: true });
    }
  });
