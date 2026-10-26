// Synthetic inputs; real PostgreSQL claims, immutable snapshots and production loaders.
// No Azurite, parser, Python process or provider is needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_SUBTYPE,
  type M4DocumentManifest, type ReviewFileDeliveryPin, type TargetReportingPeriod } from '@bondbuddy/contracts';
import { digest, transaction, uid, type PrivateBlobs } from '@bondbuddy/api/data';
import { claim } from '@bondbuddy/api/queue';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { loadM4Knowledge } from '@bondbuddy/api/m4-knowledge';
import { grantCredits } from '../../api/dist/billing.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { inputLockStage, type StageContext } from './run-pipeline.js';
import { loadUnifiedInput, type UnifiedManifest } from './unified-input.js';
import { loadReviewInput, type ReviewManifest } from './review-input.js';
import { loadReviewFileInput } from './review-file-stage.js';
import { loadM4WorkerInput } from './m4-input.js';

const connection = await isolatedTestDatabase(undefined, 'execution-input-loaders');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const conflict = (error: unknown) => error instanceof Error
  && ('code' in error ? error.code : error.message) === 'INPUT_REVISION_CONFLICT';

test('real claimed M1, legacy/file M3 and M4 loaders read exact immutable execution inputs without changing history or credits',
  { skip: !connection, timeout: 60000 }, async t => {
    const pool = new Pool({ connectionString: connection }), owner = uid();
    const bytes = new Map<string, Buffer>();
    const blobs: PrivateBlobs = {
      put: async (key, value) => { bytes.set(key, Buffer.from(value)); },
      get: async key => { const value = bytes.get(key); assert.ok(value); return Buffer.from(value); },
      getIfExists: async key => bytes.has(key) ? Buffer.from(bytes.get(key)!) : null,
      getIfExistsBounded: async (key, limit) => {
        const value = bytes.get(key); assert(!value || value.length <= limit);
        return value ? Buffer.from(value) : null;
      },
      exists: async key => bytes.has(key), delete: async key => { bytes.delete(key); },
    };
    const period: TargetReportingPeriod = { start: '2025-01-01', end: '2025-12-31', period_kind: 'annual',
      scope: 'consolidated', status: 'user_asserted', evidence_refs: [] };
    const requirementText = 'Synthetic fixed requirement: preserve the selected source and disclose missing evidence.';
    const knowledgeText = '# Synthetic fixed authoring guide\nKeep original source provenance and uncertainty.';
    const gap = 'Synthetic source has not been parsed; no evidence coverage is claimed.';
    const project = async (kind: string, scope: string | null = null) => {
      const id = uid();
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,execution_scope_project_id)
        VALUES($1,$2,'Synthetic execution loader',$3,'Synthetic issuer','sse','private',$4)`, [id, owner, kind, scope]);
      return id;
    };
    const material = async (projectId: string) => {
      const id = uid(), upload = uid(), content = makeWorkerDocxFixture({ externalLink: false });
      const key = `users/${owner}/projects/${projectId}/synthetic/${id}.docx`, sha = digest(content);
      await blobs.put(key, content, DOCX);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic-source.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed')`,
      [upload, owner, projectId, DOCX, content.length, sha, key]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic-source.docx',$5,$6,$7,$8,'persisted')`,
      [id, owner, projectId, upload, DOCX, content.length, sha, key]);
      return { pin: { material_id: id, material_version: 1, sha256: sha }, key };
    };
    const fixture = async (kind: 'm1' | 'm3' | 'm4') => {
      const task = kind === 'm1' ? 'update' : kind === 'm3' ? 'review' : 'generation';
      const sourceProject = kind === 'm4' ? await project('update') : null;
      const projectId = await project(task, sourceProject), sourceId = sourceProject ?? projectId;
      const source = await material(sourceId), runId = uid(), jobId = uid();
      let manifest: UnifiedManifest | ReviewManifest | M4DocumentManifest;
      let topic: string | null = null;
      let checkpoint: Record<string, unknown> = {};
      if (kind === 'm1') {
        const snapshot = await savePromptSnapshot(pool, blobs, { owner, projectId, kind: 'user_prompt', version: 1, body: requirementText });
        const submission = uid(), message = uid();
        await pool.query(`INSERT INTO bb_user_submission_versions(id,owner_user_id,project_id,snapshot_id,submission_kind,
          message_id,submission_request_id,message_version,version,content_sha256,material_versions)
          VALUES($1,$2,$3,$4,'project_message',$5,$6,1,1,$7,$8)`,
        [submission, owner, projectId, snapshot, message, uid(), digest(requirementText), JSON.stringify([source.pin])]);
        manifest = { issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private',
          update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', target_reporting_periods: [period] },
          materials: [{ ...source.pin, role: 'historical' }], authoring: { version: 'unified_v1',
            source_prospectuses: [{ ...source.pin, issuer_name: 'Synthetic issuer', relation: 'same_issuer',
              market: 'sse', offering: 'private', reporting_periods: [period], status: 'user_asserted' }],
            requirements: [{ submission_id: submission, message_id: message, message_version: 1, content_sha256: digest(requirementText) }],
            knowledge: [{ path: 'synthetic-fixed-guide.md', sha256: digest(knowledgeText), markdown: knowledgeText }],
            knowledge_status: 'authoring_reference_not_compliance_approval' } };
      } else if (kind === 'm3') {
        const fileDelivery: ReviewFileDeliveryPin = { version: 'review-file-v1',
          knowledge: [{ path: 'synthetic-review-guide.md', markdown: knowledgeText, sha256: digest(knowledgeText) }] };
        manifest = { issuer_name: 'Synthetic issuer', market: null, offering: null, materials: [{ ...source.pin, role: 'historical' }],
          review: { version: 'review_v1', operation: 'full_review', report_id: uid(), version_number: 1,
            input: { source_material_ref: source.pin, material_versions: [source.pin], requirements: [requirementText], as_of: null },
            source_report_id: null, source_report_sha256: null, finding_ids: [],
            file_delivery: fileDelivery,
            origin: { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null } } };
        checkpoint = { stages: { review_sources: { snapshots: [{ ...source.pin, snapshot_id: null, response_sha256: null, gap }] } } };
      } else {
        topic = uid();
        await pool.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash)
          VALUES($1,$2,$3,$4,'Synthetic cross-project loader',$5,$6)`, [topic, owner, projectId, sourceId, uid(), digest(uid())]);
        const pin = { ...source.pin, source_project_id: sourceId };
        manifest = { version: 'm4-document-input-v1', kind: 'document', topic_id: topic, execution_scope_project_id: sourceId,
          draft_version: 1, market: 'sse', offering: 'private', billing_task: M4_DOCUMENT_BILLING_TASKS.underwriter,
          knowledge: loadM4Knowledge('sse', 'underwriter', 'private'), template_material: null,
          input: { document_type: 'underwriter', source_material: pin, materials: [pin], template: null, edit_base: null,
            scope: 'whole', fields: { issuer_name: 'Synthetic issuer' },
            requirements: [{ requirement_id: uid(), text: requirementText, message_id: uid(), message_version: 1 }] } };
      }
      const hash = inputManifestHash(manifest);
      const pins = kind === 'm4' ? (manifest as M4DocumentManifest).input.materials : (manifest as UnifiedManifest | ReviewManifest).materials;
      // A newer saved revision with identical bytes must not change the run's exact revision identity.
      for (const revision of [1, 2]) await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,
        input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
        VALUES($1,$2,$3,1,$4,$5,$6,'[]','synthetic-rules','synthetic-template')`,
      [projectId, revision, owner, hash, manifest, JSON.stringify(pins)]);
      await pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1', [projectId]);
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,
        request_hash,state,stage,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,'queued','queued','2026-10-20T08:00:00Z')`,
      [runId, owner, projectId, hash, uid(), task, digest(uid())]);
      if (kind === 'm3') {
        const review = (manifest as ReviewManifest).review;
        await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
          VALUES($1,$2,$3,1,'full_review',$4)`, [runId, owner, projectId, { input: review.input, origin: review.origin, finding_ids: review.finding_ids }]);
      }
      if (kind === 'm4') await pool.query(`INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash)
        VALUES($1,$2,$3,$4,$5)`, [runId, owner, topic, manifest, hash]);
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint)
        VALUES($1,$2,$3,$4,$5,'queued','queued',$6)`, [jobId, owner, runId, task, kind === 'm4' ? M4_DOCUMENT_SUBTYPE : 'default', checkpoint]);
      const lease = await claim(pool, 300, { runKinds: [task] });
      assert.ok(lease); assert.equal(lease.runId, runId);
      assert.deepEqual({ version: lease.executionVersion, revision: lease.inputRevision, hash: lease.inputHash },
        { version: 1, revision: 1, hash });
      const run = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [runId])).rows[0];
      const ctx: StageContext = { pool, blobs, run, lease, signal: new AbortController().signal,
        checkpoint: structuredClone(lease.checkpoint.stages ?? {}) as StageContext['checkpoint'], values: new Map() };
      assert.equal((await inputLockStage.run(ctx)).kind, 'done', 'persisted fixture must pass its normal production input gate');
      return { ctx, manifest, source, projectId, sourceId, hash };
    };
    const historyTables = ['bb_projects', 'bb_uploads', 'bb_material_versions', 'bb_input_revisions', 'bb_run_execution_versions',
      'bb_runs', 'bb_jobs', 'bb_review_executions', 'bb_m4_executions', 'bb_review_execution_snapshots', 'bb_m4_execution_snapshots', 'bb_snapshot_refs', 'bb_user_submission_versions',
      'bb_model_call_attempts', 'bb_artifact_versions', 'bb_run_events', 'bb_outbox', 'bb_authoring_progress',
      'bb_credit_accounts', 'bb_credit_lots', 'bb_credit_events', 'bb_credit_reservations', 'bb_m4_metering'] as const;
    const evidence = async (includeAccessAudit = false) => Object.fromEntries(await Promise.all(
      [...historyTables, ...(includeAccessAudit ? ['bb_log_access_audit'] : [])].map(async table => [table,
        (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`, [owner])).rows])));
    const blobEvidence = () => [...bytes].map(([key, value]) => [key, digest(value)]).sort();
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `loader_${uid().replaceAll('-', '').slice(0, 20)}`]);
      await transaction(pool, client => grantCredits(client, { owner, source: 'existing_grant', key: uid(), points: 10000,
        expiresAt: null, actor: 'synthetic-test', reason: 'Nonempty ledger for read-only execution loader regression' }));
      for (const kind of ['m1', 'm3', 'm4'] as const) await t.test(kind, async current => {
        const f = await fixture(kind), before = await evidence(), storedBytes = blobEvidence();
        if (kind === 'm1') {
          const loaded = await loadUnifiedInput(f.ctx, { originalFiles: true }), expected = f.manifest as UnifiedManifest;
          assert.deepEqual(loaded.manifest, expected);
          assert.deepEqual(loaded.requirements, [requirementText]);
          assert.deepEqual(loaded.manifest.authoring.source_prospectuses, expected.authoring.source_prospectuses);
          assert.deepEqual(loaded.manifest.authoring.knowledge, expected.authoring.knowledge);
          assert.equal(loaded.materials[0].objectKey, f.source.key);
          assert.deepEqual(loaded.materials[0].pin, expected.materials[0]);
        } else if (kind === 'm3') {
          const loaded = await loadReviewInput(f.ctx), expected = f.manifest as ReviewManifest;
          assert.deepEqual(loaded.requirements, expected.review.input.requirements);
          assert.deepEqual(loaded.evidence.source_material, f.source.pin);
          assert.equal(loaded.evidence.records.length, 0);
          assert(loaded.limitations.includes(gap));
          assert.equal(loaded.input_hash, f.hash);
          assert.equal(loaded.created_at, '2026-10-20T08:00:00.000Z');
          const files = await loadReviewFileInput(f.ctx);
          assert.deepEqual(files.manifest, expected);
          assert.deepEqual(files.manifest.review.file_delivery, expected.review.file_delivery);
          assert.deepEqual(files.manifest.review.input.requirements, [requirementText]);
          assert.deepEqual(files.materials.map(item => item.pin), expected.materials);
          assert.equal(files.materials[0].object_key, f.source.key);
          assert.deepEqual(files.selected_findings, []);
        } else {
          const loaded = await loadM4WorkerInput(f.ctx), expected = f.manifest as M4DocumentManifest;
          assert.notEqual(f.sourceId, f.projectId);
          assert.deepEqual(loaded.manifest, expected);
          assert.deepEqual(loaded.manifest.kind === 'document' && loaded.manifest.knowledge, expected.knowledge);
          assert.deepEqual(loaded.manifest.kind === 'document' && loaded.manifest.input.requirements, expected.input.requirements);
          assert.equal(loaded.materials.length, 1);
          assert.equal(loaded.materials[0].pin.source_project_id, f.sourceId);
          assert.equal(loaded.materials[0].objectKey, f.source.key);
        }
        assert.deepEqual(await evidence(), before, 'loading preserves run/input/business snapshots, checkpoints, provider history and credits');
        assert.deepEqual(blobEvidence(), storedBytes);
        const loaders: [string, (ctx: StageContext) => Promise<unknown>][] = kind === 'm1'
          ? [['unified', ctx => loadUnifiedInput(ctx, { originalFiles: true })]]
          : kind === 'm3' ? [['legacy review', loadReviewInput], ['file review', loadReviewFileInput]]
            : [['M4 document', loadM4WorkerInput]];
        const rejectedContexts: [string, StageContext][] = [
          ['successor version', { ...f.ctx, lease: { ...f.ctx.lease, executionVersion: 2 } }],
          ['same bytes, different revision', { ...f.ctx, run: { ...f.ctx.run, input_revision: 2 }, lease: { ...f.ctx.lease, inputRevision: 2 } }],
          ['context project', { ...f.ctx, run: { ...f.ctx.run, project_id: uid() } }],
          ['context owner', { ...f.ctx, run: { ...f.ctx.run, owner_user_id: uid() } }],
          ['context run', { ...f.ctx, run: { ...f.ctx.run, id: uid() } }],
          ['lease hash', { ...f.ctx, lease: { ...f.ctx.lease, inputHash: digest('different-input') } }],
        ];
        const beforeRejections = await evidence(true);
        for (const [loaderName, load] of loaders) for (const [name, ctx] of rejectedContexts) {
          await assert.rejects(load(ctx), conflict, `${loaderName}: ${name}`);
          assert.deepEqual(await evidence(true), beforeRejections, `${loaderName}: ${name} must not change durable state or access audit`);
        }
        assert.deepEqual(blobEvidence(), storedBytes);
        if (kind !== 'm1') await current.test(`${kind}: missing exact business snapshot never falls back to legacy`, async () => {
          const client = await pool.connect();
          const table = kind === 'm3' ? 'bb_review_execution_snapshots' : 'bb_m4_execution_snapshots';
          const legacy = kind === 'm3' ? 'bb_review_executions' : 'bb_m4_executions';
          try {
            await client.query('BEGIN');
            // Deliberate corruption exists only inside this private clone transaction.
            await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
            await client.query(`DELETE FROM ${table} WHERE owner_user_id=$1 AND run_id=$2`, [owner, f.ctx.run.id]);
            assert.equal((await client.query(`SELECT 1 FROM ${legacy} WHERE owner_user_id=$1 AND run_id=$2`, [owner, f.ctx.run.id])).rowCount, 1);
            const context = { ...f.ctx, pool: client as unknown as Pool };
            assert.deepEqual(await inputLockStage.run(context), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
            for (const [name, load] of loaders) await assert.rejects(load(context), conflict, `${name} must require its exact snapshot`);
          } finally { await client.query('ROLLBACK'); client.release(); }
          assert.deepEqual(await evidence(true), beforeRejections);
          assert.deepEqual(blobEvidence(), storedBytes);
        });
      });
    } finally { await pool.end(); }
  });
