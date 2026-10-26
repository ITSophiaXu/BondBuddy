import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { loadUnifiedInput, type UnifiedManifest } from './unified-input.js';
import type { StageContext } from './run-pipeline.js';

function fixture() {
  const pin = { material_id: 'source', material_version: 2, role: 'historical', sha256: digest('synthetic source') };
  const manifest: UnifiedManifest = { issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private',
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' }, materials: [pin],
    authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [],
      knowledge_status: 'authoring_reference_not_compliance_approval' } };
  const hash = inputManifestHash(manifest);
  const run = { id: 'run', owner_user_id: 'owner', project_id: 'project', input_revision: 3, input_hash: hash, task_kind: 'update' };
  const input = { owner_user_id: 'owner', project_id: 'project', revision: 3, input_hash: hash, manifest,
    draft_revision: 1, material_versions: [pin], rule_pack_version: null, template_version: null };
  const reads: string[] = [];
  const pool = { query: async (sql: string, args: unknown[]) => {
    reads.push(sql);
    if (sql.startsWith('SELECT r.*')) { assert.deepEqual(args, ['owner', 'run']); return { rows: [run] }; }
    if (sql.includes('FROM bb_run_execution_versions')) {
      assert.deepEqual(args, ['owner', 'project', 'run']);
      return { rows: [{ execution_version: 1, input_revision: 3, input_hash: hash }] };
    }
    if (sql.includes('FROM bb_input_revisions')) {
      assert.deepEqual(args, ['owner', 'project', 3]); return { rows: [input] };
    }
    if (sql.includes('FROM bb_review_execution_snapshots') || sql.includes('FROM bb_m4_execution_snapshots')) {
      assert.deepEqual(args, ['owner', 'project', 'run', 1, 3, hash]); return { rows: [] };
    }
    if (sql.includes('FROM bb_material_versions m')) {
      assert.deepEqual(args.slice(0, 4), ['owner', 'project', 'source', 2]);
      return { rows: [{ filename: 'synthetic.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', object_key: 'exact-source' }] };
    }
    throw Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Pool;
  const ctx = { pool, run: { ...run }, lease: { owner: 'owner', runId: 'run', jobId: 'job', token: 'lease',
    attempts: 1, checkpoint: {}, executionVersion: 1, inputRevision: 3, inputHash: hash },
    checkpoint: {}, values: new Map(), signal: new AbortController().signal } as unknown as StageContext;
  return { ctx, reads, input, run, manifest };
}

test('unified original-file loader uses the resolved exact input before reading material bytes', async () => {
  const f = fixture();
  const result = await loadUnifiedInput(f.ctx, { originalFiles: true });
  assert.deepEqual(result.manifest, f.manifest);
  assert.deepEqual(result.materials.map(material => ({ pin: material.pin, objectKey: material.objectKey })),
    [{ pin: f.manifest.materials[0], objectKey: 'exact-source' }]);
  assert.deepEqual(result.requirements, []);
  assert.equal(f.reads.filter(sql => sql.includes('FROM bb_input_revisions')).length, 1);
  assert.ok(f.reads.findIndex(sql => sql.includes('FROM bb_run_execution_versions'))
    < f.reads.findIndex(sql => sql.includes('FROM bb_material_versions m')));
});

test('unified loader rejects stale run/lease identity before any material or input read', async () => {
  for (const mismatch of [
    (ctx: StageContext) => { delete (ctx as Partial<StageContext>).lease; },
    (ctx: StageContext) => { ctx.run.id = 'other'; },
    (ctx: StageContext) => { ctx.run.owner_user_id = 'other'; },
    (ctx: StageContext) => { ctx.run.input_revision = 4; },
    (ctx: StageContext) => { ctx.run.input_hash = '0'.repeat(64); },
  ]) {
    const f = fixture(); mismatch(f.ctx);
    await assert.rejects(loadUnifiedInput(f.ctx, { originalFiles: true }), /INPUT_REVISION_CONFLICT/);
    assert.deepEqual(f.reads, []);
  }
});

test('unified loader rejects another persisted project or task and corrupted frozen input before material access', async () => {
  for (const corrupt of [
    (f: ReturnType<typeof fixture>) => { f.ctx.run.project_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.ctx.run.task_kind = 'generation'; },
    (f: ReturnType<typeof fixture>) => { f.input.manifest.issuer_name = 'Changed after locking'; },
    (f: ReturnType<typeof fixture>) => { f.ctx.lease.executionVersion = 2; },
  ]) {
    const f = fixture(); corrupt(f);
    await assert.rejects(loadUnifiedInput(f.ctx, { originalFiles: true }),
      error => (error as { code?: string }).code === 'INPUT_REVISION_CONFLICT' || (error as Error).message === 'INPUT_REVISION_CONFLICT');
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
});
