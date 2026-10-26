// Synthetic Markdown/material; real PostgreSQL, HTTP, queue, Python correction,
// artifact promotion and authorized downloads. Private Blob bytes stay in memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest, Problem, type PrivateBlobs } from '@bondbuddy/api/data';
import { action, claim } from '@bondbuddy/api/queue';
import { resolveRunExecution } from '@bondbuddy/api/run-execution';
import type { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import type { ReviewEditorResponse, ReviewExportRequest } from '@bondbuddy/contracts';
import { inputManifestHash } from '../../api/dist/production-rule-pin.js';
import { listCapturedSupplementFiles, readCapturedSupplementFile } from '../../api/dist/run-supplement-files.js';
import { isolatedTestDatabase } from './test-database.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { inputLockStage, materialsReadyStage, runPipelineOnce, type RunStage, type StageContext, type RunPipelineDependencies } from './run-pipeline.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { loadReviewFileInput, reviewFileStage, type ReviewFileResult } from './review-file-stage.js';
import { correctionFiles } from './review-correction-stage.js';

const connection = await isolatedTestDatabase(undefined, 'review-editor-execution');
const python = process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON;
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const markdown = Buffer.from('## 格式与标点\n### 合成文本修订\n- 复核类别：格式与标点\n- 问题说明：合成修改\n- 原文披露：Synthetic worker upload fixture\n- 核对依据：合成依据\n- 处理方式：直接修改\n- 替换文本：Synthetic reviewed fixture\n- 缺少材料：无\n');
const manualText = 'Manually corrected execution fixture';
const correctionNames = ['baseline.docx', 'clean.docx', 'editor.json', 'report.docx', 'report.md', 'revision.docx'];
const denied = (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT';

function memoryBlobs(): PrivateBlobs {
  const objects = new Map<string, Buffer>();
  return {
    put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = objects.get(key); assert.ok(bytes, 'Missing synthetic private object'); return Buffer.from(bytes); },
    getIfExists: async key => { const bytes = objects.get(key); return bytes ? Buffer.from(bytes) : null; },
    getIfExistsBounded: async (key, limit) => {
      const bytes = objects.get(key); assert.ok(!bytes || bytes.length <= limit, 'Bounded private read');
      return bytes ? Buffer.from(bytes) : null;
    },
    exists: async key => objects.has(key),
    delete: async key => { objects.delete(key); },
  };
}

async function fixture() {
  const pool = new Pool({ connectionString: connection }), owner = randomUUID(), blobs = memoryBlobs();
  let activeOwner: string = owner;
  const origin = 'http://bondbuddy.test';
  const app = createServer({ pool, blobs, allowedOrigin: origin, enableRunRuntime: true, enablePaidReview: false,
    principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url,
    payload: payload as never, headers: { origin, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) } });
  const ok = async (method: string, url: string, payload?: unknown) => {
    const response = await send(method, url, payload); assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
    return response.body ? response.json() : null;
  };
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'editor_exec_' + randomUUID().replaceAll('-', '').slice(0, 12)]);
  const createReview = async () => {
    const project = await ok('POST', '/api/v1/projects', { kind: 'review', name: 'Synthetic execution editor',
      issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private' });
    const projectId: string = project.project_id, path = `/api/v1/projects/${projectId}`;
    const bytes = makeWorkerDocxFixture({ externalLink: false }), declaration = { byte_size: bytes.length, sha256: digest(bytes) };
    const upload = await ok('POST', path + '/materials/uploads', { ...declaration, filename: 'synthetic-editor-source.docx', media_type: docx, role: 'historical' });
    assert.equal((await send('PUT', upload.upload_url, bytes)).statusCode, 204);
    const completed = await ok('POST', path + '/materials/uploads/' + upload.upload_id + '/complete', declaration);
    const sourcePin = { material_id: completed.material_id, material_version: completed.material_version, sha256: completed.sha256 };
    await ok('PUT', path + '/review-draft', { kind: 'input', expected_version: 0, input: {
      source_material_ref: sourcePin, material_versions: [sourcePin], requirements: ['Synthetic frozen requirement'], as_of: null } });
    const run = await ok('POST', path + '/review-executions', { execution_request_id: randomUUID(), operation: 'full_review',
      expected_input_version: 1, source_report_id: null, expected_plan_version: null, finding_ids: [] });
    return { projectId, path, sourcePin, run };
  };
  return { pool, owner, blobs, send, ok, createReview,
    changeOwner: (value: string) => { activeOwner = value; },
    close: async () => { await app.close(); await pool.end(); } };
}

test('trusted correction → exact completed editor → pinned manual export → original and new Word downloads',
  { skip: !connection || !python, timeout: 240000 }, async () => {
    const c = await fixture(), directory = await mkdtemp(join(tmpdir(), 'bb-editor-execution-'));
    // This seam writes private bytes only. It deliberately does not prove the
    // durable raw working-object registry, which has a separate integration suite.
    const syntheticWriter: typeof writeRunWorkingFile = async input => input.blobs.put(input.key, input.bytes, input.mediaType);
    const execute = (model: RunStage, afterStage?: RunPipelineDependencies['afterStage']) => runPipelineOnce({
      pool: c.pool, blobs: c.blobs, leaseSeconds: 300, runKinds: ['review'],
      stages: [inputLockStage, materialsReadyStage, model, historicalWordDeliveryStage()], afterStage,
      onUnexpectedError: error => assert.fail(JSON.stringify(error)),
    });
    try {
      const f = await c.createReview(), sourceRunId: string = f.run.run_id;
      let sourceFiles: ReviewFileResult | undefined, hiddenBeforeFinish = false;
      const sourceStage: RunStage = { name: 'model_generation', run: async ctx => {
        assert.equal(ctx.run.id, sourceRunId);
        sourceFiles = await correctionFiles(ctx, await loadReviewFileInput(ctx), markdown, undefined, syntheticWriter);
        const rows = (await c.pool.query('SELECT * FROM bb_review_execution_editors WHERE run_id=$1', [sourceRunId])).rows;
        assert.equal(rows.length, 1, 'trusted correctionFiles registers its editor through the live lease');
        assert.equal(rows[0].execution_version, ctx.lease.executionVersion);
        assert.equal(rows[0].input_revision, ctx.lease.inputRevision);
        assert.equal(rows[0].input_hash.trim(), ctx.lease.inputHash);
        assert.equal((await c.send('GET', f.path + `/review-executions/${sourceRunId}/editor`)).statusCode, 404,
          'a registered editor remains hidden before final delivery');
        return { kind: 'done', value: sourceFiles };
      } };
      assert.equal(await execute(sourceStage, async stage => {
        if (stage !== 'word_promoted') return;
        assert.equal((await c.send('GET', f.path + `/review-executions/${sourceRunId}/editor`)).statusCode, 404,
          'artifact promotion alone does not publish the editor before finish');
        hiddenBeforeFinish = true;
      }), 'succeeded');
      assert.equal(hiddenBeforeFinish, true);
      const editor = await c.ok('GET', f.path + `/review-executions/${sourceRunId}/editor`) as ReviewEditorResponse;
      const identity = (await c.pool.query('SELECT * FROM bb_run_execution_versions WHERE run_id=$1', [sourceRunId])).rows[0];
      assert.deepEqual(editor.execution, { execution_version: 1, input_revision: identity.input_revision, input_hash: identity.input_hash.trim() });
      assert.equal(editor.sha256, inputManifestHash(editor.snapshot));
      assert.equal(editor.snapshot.source_sha256, f.sourcePin.sha256);
      assert.equal(editor.snapshot.issues.length, 1); assert.equal(editor.snapshot.issues[0].applied, true);
      assert.deepEqual(await c.ok('GET', f.path + `/review-executions/${sourceRunId}/editor?execution_version=1`), editor);
      const mirrored = (await c.pool.query(`SELECT e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash,
        e.snapshot,e.sha256,e.created_at,l.snapshot AS legacy_snapshot,l.sha256 AS legacy_sha256,l.created_at AS legacy_created_at
        FROM bb_review_execution_editors e JOIN bb_review_editors l ON l.run_id=e.run_id WHERE e.run_id=$1`, [sourceRunId])).rows[0];
      assert.equal(mirrored.owner_user_id, c.owner); assert.equal(mirrored.project_id, f.projectId);
      assert.deepEqual(mirrored.snapshot, editor.snapshot); assert.deepEqual(mirrored.legacy_snapshot, editor.snapshot);
      assert.equal(mirrored.sha256.trim(), editor.sha256); assert.equal(mirrored.legacy_sha256.trim(), editor.sha256);
      assert.deepEqual(mirrored.created_at, mirrored.legacy_created_at);
      assert.equal((await c.pool.query(`SELECT count(*)::int n FROM bb_run_execution_deliveries
        WHERE run_id=$1 AND execution_version=1 AND input_revision=$2 AND input_hash=$3
          AND delivery_phase='final' AND terminal_state='succeeded'`,
      [sourceRunId, identity.input_revision, identity.input_hash])).rows[0].n, 1);
      assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_review_reports WHERE run_id=$1', [sourceRunId])).rows[0].n, 0,
        'file-only editor delivery does not invent a structured review report');

      const beforeWorkspace = await c.ok('GET', f.path + '/review-workspace');
      assert.deepEqual(beforeWorkspace.artifacts.map((a: any) => a.kind).sort(), ['clean', 'report', 'revision']);
      const originalFiles = new Map<string, { url: string; bytes: Buffer; sha256: string }>();
      for (const artifact of beforeWorkspace.artifacts) {
        const meta = await c.ok('GET', `/api/v1/artifacts/${artifact.artifact_id}`);
        const downloaded = await c.send('GET', meta.download_url); assert.equal(downloaded.statusCode, 200, downloaded.body);
        assert.equal(digest(downloaded.rawPayload), meta.sha256);
        originalFiles.set(artifact.kind, { url: meta.download_url, bytes: Buffer.from(downloaded.rawPayload), sha256: meta.sha256 });
      }
      assert.ok(sourceFiles);
      await c.blobs.delete(sourceFiles.files['editor.json'].key);
      assert.deepEqual(await c.ok('GET', f.path + `/review-executions/${sourceRunId}/editor`), editor,
        'canonical editor retrieval is independent of a removed working editor.json');

      const exportRequest: ReviewExportRequest = { request_id: randomUUID(), source_run_id: sourceRunId,
        source_execution: structuredClone(editor.execution!), expected_editor_sha256: editor.sha256,
        decisions: editor.snapshot.issues.map(issue => ({ id: issue.id, decision: 'manual', manual_text: manualText })) };
      assert.equal((await c.send('POST', f.path + '/review-exports', { ...exportRequest, request_id: randomUUID(),
        source_execution: { ...exportRequest.source_execution, input_hash: '0'.repeat(64) } })).statusCode, 409);
      const exported = await c.ok('POST', f.path + '/review-exports', exportRequest), exportRunId: string = exported.run_id;
      assert.notEqual(exportRunId, sourceRunId);
      assert.equal((await c.ok('POST', f.path + '/review-exports', exportRequest)).run_id, exportRunId);
      assert.equal((await c.send('POST', f.path + '/review-exports', { ...exportRequest,
        source_execution: { ...exportRequest.source_execution, input_revision: editor.execution!.input_revision + 1 } })).statusCode, 409,
        'request idempotency includes the complete source pin');
      const frozen = (await c.pool.query(`SELECT i.manifest,e.snapshot,r.input_revision,r.input_hash FROM bb_runs r
        JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
        JOIN bb_review_execution_snapshots e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id AND e.execution_version=1
        WHERE r.id=$1`, [exportRunId])).rows[0];
      assert.notEqual(frozen.input_revision, editor.execution!.input_revision);
      assert.notEqual(frozen.input_hash.trim(), editor.execution!.input_hash,
        'the export lease cannot be substituted for the distinct persisted source identity');
      assert.deepEqual(frozen.manifest.review.file_delivery.export, { source_run_id: sourceRunId,
        source_execution: editor.execution, editor_sha256: editor.sha256, decisions: exportRequest.decisions });
      assert.deepEqual(frozen.snapshot.source_execution, editor.execution);
      assert.equal(frozen.snapshot.source_run_id, sourceRunId); assert.equal(frozen.snapshot.export_only, true);

      let modelConstructions = 0, exportWrites = 0;
      const exportStage = reviewFileStage({ writer: async input => { exportWrites++; await syntheticWriter(input); },
        model: () => { modelConstructions++; throw Error('Manual correction must not construct a model stage'); } });
      let malformedPinsChecked = false;
      const exporting: RunStage = { ...exportStage, run: async ctx => {
        if (!malformedPinsChecked) {
          const validInput = await loadReviewFileInput(ctx);
          const malformed = [null, false, 0, '', {}, { ...editor.execution, unknown_field: true }];
          for (const value of [...malformed, 'unknown-export-field'] as const) {
            const input = structuredClone(validInput);
            const savedPin = input.manifest.review.file_delivery!.export! as unknown as Record<string, unknown>;
            if (value === 'unknown-export-field') savedPin.unknown_field = true;
            else savedPin.source_execution = value;
            // An aborted signal would fail with AbortError if malformed pins
            // reached Python. They must fail at strict pin validation first.
            const stopped = { ...ctx, signal: AbortSignal.abort() };
            await assert.rejects(correctionFiles(stopped, input, undefined, undefined, async () => assert.fail('Malformed saved pin reached output IO')),
              { message: 'INPUT_REVISION_CONFLICT' });
            for (const table of ['bb_review_execution_editors', 'bb_review_editors'])
              assert.equal((await c.pool.query(`SELECT count(*)::int n FROM ${table} WHERE run_id=$1`, [exportRunId])).rows[0].n, 0);
          }
          assert.equal(modelConstructions, 0); assert.equal(exportWrites, 0);
          assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1', [exportRunId])).rows[0].n, 0);
          malformedPinsChecked = true;
        }
        return exportStage.run(ctx);
      } };
      let capturedAtModelBoundary = false;
      assert.equal(await execute(exporting, async stage => {
        if (stage !== 'model_generation') return;
        capturedAtModelBoundary = true; await action(c.pool, c.owner, exportRunId, 'pause');
      }), 'paused');
      assert.equal(capturedAtModelBoundary, true); assert.equal(malformedPinsChecked, true); assert.equal(exportWrites, 6);
      assert.equal((await c.send('GET', f.path + `/review-executions/${exportRunId}/editor`)).statusCode, 404);
      const saved = await c.ok('PUT', `/api/v1/runs/${exportRunId}/supplement-draft`, { request_id: randomUUID(), expected_revision: 0,
        base_input_revision: frozen.input_revision, base_input_hash: frozen.input_hash.trim(), changes: [] });
      assert.equal(saved.saved_work.status, 'captured'); assert.equal(saved.saved_work.result_count, 0);
      const scope = { db: c.pool, blobs: c.blobs, owner: c.owner, projectId: f.projectId, runId: exportRunId,
        revision: 1, source: { kind: 'checkpoint' as const, field: 'correction_result' as const } };
      const captured = await listCapturedSupplementFiles(scope);
      assert.deepEqual(captured.map(pin => pin.name).sort(), correctionNames);
      for (const pin of captured) {
        assert.equal(pin.executionVersion, 1); assert.equal(pin.inputRevision, frozen.input_revision);
        assert.equal(pin.inputHash, frozen.input_hash.trim());
        assert.equal(digest(await readCapturedSupplementFile({ ...scope, pin })), pin.sha256);
      }
      const savedWork = (await c.pool.query('SELECT source_checkpoint FROM bb_run_supplement_saved_work WHERE run_id=$1 AND supplement_revision=1', [exportRunId])).rows[0];
      const correction = savedWork.source_checkpoint.stages.model_generation.correction_result;
      assert.ok(captured.every(pin => pin.sourceHash === inputManifestHash(correction)),
        'working scope accepts the full pin persisted in both export manifest and review snapshot');
      assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_working_objects WHERE run_id=ANY($1::text[])', [[sourceRunId, exportRunId]])).rows[0].n, 0,
        'the synthetic writer seam does not stand in for working-object registration');
      await action(c.pool, c.owner, exportRunId, 'resume');
      assert.equal(await execute(exporting), 'succeeded'); assert.equal(exportWrites, 6, 'checkpoint resume reuses deterministic output');
      assert.equal(modelConstructions, 0);
      const exportedEditor = await c.ok('GET', f.path + `/review-executions/${exportRunId}/editor`) as ReviewEditorResponse;
      assert.deepEqual(exportedEditor.execution, { execution_version: 1, input_revision: frozen.input_revision, input_hash: frozen.input_hash.trim() });
      assert.notEqual(exportedEditor.sha256, editor.sha256);
      assert.ok(exportedEditor.snapshot.issues.every(issue => issue.manual_text === manualText && issue.applied));
      assert.deepEqual(await c.ok('GET', f.path + `/review-executions/${sourceRunId}/editor`), editor);
      for (const table of ['bb_model_call_attempts', 'bb_provider_result_refs', 'bb_snapshot_refs', 'bb_credit_reservations']) {
        const count = table === 'bb_model_call_attempts'
          ? await c.pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1', [exportRunId])
          : await c.pool.query(`SELECT count(*)::int n FROM ${table} WHERE run_id=$1`, [exportRunId]);
        assert.equal(count.rows[0].n, 0, `manual export creates no ${table}`);
      }
      assert.equal((await c.pool.query('SELECT billing_mode FROM bb_runs WHERE id=$1', [exportRunId])).rows[0].billing_mode, 'platform_trial');

      const afterWorkspace = await c.ok('GET', f.path + '/review-workspace');
      assert.equal(afterWorkspace.artifact_run.run_id, exportRunId);
      assert.deepEqual(afterWorkspace.artifacts.map((a: any) => a.kind).sort(), ['clean', 'report', 'revision']);
      let newClean: Buffer | undefined, newDownloadUrl: string | undefined;
      for (const artifact of afterWorkspace.artifacts) {
        const meta = await c.ok('GET', `/api/v1/artifacts/${artifact.artifact_id}`);
        const downloaded = await c.send('GET', meta.download_url); assert.equal(downloaded.statusCode, 200, downloaded.body);
        assert.equal(digest(downloaded.rawPayload), meta.sha256);
        if (artifact.kind === 'clean') { newClean = Buffer.from(downloaded.rawPayload); newDownloadUrl = meta.download_url; }
      }
      for (const original of originalFiles.values()) {
        const downloaded = await c.send('GET', original.url); assert.equal(downloaded.statusCode, 200, downloaded.body);
        assert.equal(digest(downloaded.rawPayload), original.sha256); assert.deepEqual(downloaded.rawPayload, original.bytes);
      }
      assert.ok(newClean); const originalClean = originalFiles.get('clean')!;
      assert.notEqual(digest(newClean), originalClean.sha256);
      const originalPath = join(directory, 'original-clean.docx'), exportedPath = join(directory, 'exported-clean.docx');
      await writeFile(originalPath, originalClean.bytes); await writeFile(exportedPath, newClean);
      await promisify(execFile)(python!, ['-c', "import sys;from docx import Document;old='\\n'.join(p.text for p in Document(sys.argv[1]).paragraphs);new='\\n'.join(p.text for p in Document(sys.argv[2]).paragraphs);assert 'Synthetic reviewed fixture' in old;assert 'Manually corrected execution fixture' in new;assert 'Manually corrected execution fixture' not in old", originalPath, exportedPath], { timeout: 30000 });
      c.changeOwner(randomUUID());
      assert.equal((await c.send('GET', f.path + `/review-executions/${sourceRunId}/editor?execution_version=1`)).statusCode, 404);
      assert.equal((await c.send('GET', newDownloadUrl!)).statusCode, 404);
      assert.equal((await c.send('GET', originalClean.url)).statusCode, 404);
      assert.equal((await c.send('POST', f.path + '/review-exports', { ...exportRequest, request_id: randomUUID() })).statusCode, 404);
    } finally { await c.close(); await rm(directory, { recursive: true, force: true }); }
  });

test('real correctionFiles conversion cannot publish an editor with an expired, cancelled or mismatched lease',
  { skip: !connection || !python, timeout: 300000 }, async t => {
    const c = await fixture();
    try {
      for (const mode of ['expired', 'cancelled', 'wrong-token', 'wrong-execution', 'wrong-input-revision', 'wrong-input-hash'] as const) {
        await t.test(mode, async () => {
          const f = await c.createReview(), runId: string = f.run.run_id;
          const lease = await claim(c.pool, 300, { runKinds: ['review'] }); assert.ok(lease); assert.equal(lease.runId, runId);
          try {
            const run = await resolveRunExecution(c.pool, c.owner, runId, lease);
            const ctx: StageContext = { pool: c.pool, blobs: c.blobs, lease, run, signal: new AbortController().signal,
              checkpoint: {}, values: new Map() };
            const lock = await inputLockStage.run(ctx); assert.equal(lock.kind, 'done');
            if (lock.kind === 'done') ctx.values.set('input_lock', lock.value ?? lock.checkpoint ?? {});
            assert.equal((await materialsReadyStage.run(ctx)).kind, 'done');
            const input = await loadReviewFileInput(ctx), bad = { ...ctx, lease: { ...lease } };
            if (mode === 'expired') await c.pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.jobId]);
            else if (mode === 'cancelled') await action(c.pool, c.owner, runId, 'cancel');
            else if (mode === 'wrong-token') bad.lease.token = randomUUID();
            else if (mode === 'wrong-execution') bad.lease.executionVersion = 2;
            else if (mode === 'wrong-input-revision') bad.lease.inputRevision++;
            else bad.lease.inputHash = '0'.repeat(64);
            const written: string[] = [];
            // The raw-file writer seam cannot reject the lease first: this
            // assertion reaches correctionFiles' own editor registration gate.
            const writer: typeof writeRunWorkingFile = async file => { written.push(file.name); await file.blobs.put(file.key, file.bytes, file.mediaType); };
            await assert.rejects(correctionFiles(bad, input, markdown, undefined, writer), denied);
            assert.deepEqual(written.sort(), correctionNames, 'real trusted Python conversion completed before registration was refused');
            for (const table of ['bb_review_execution_editors', 'bb_review_editors', 'bb_artifact_versions'])
              assert.equal((await c.pool.query(`SELECT count(*)::int n FROM ${table} WHERE run_id=$1`, [runId])).rows[0].n, 0, `${mode}: no ${table}`);
            assert.equal((await c.send('GET', f.path + `/review-executions/${runId}/editor`)).statusCode, 404);
          } finally { if (mode !== 'cancelled') await action(c.pool, c.owner, runId, 'cancel'); }
        });
      }
    } finally { await c.close(); }
  });
