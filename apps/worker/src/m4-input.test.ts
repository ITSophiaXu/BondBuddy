import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { M4DocumentManifest, M4Requirement } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { loadM4WorkerInput, m4InputGate } from './m4-input.js';
import type { StageContext } from './run-pipeline.js';

const requirement = (text: string): M4Requirement => ({ requirement_id: 'changed-requirement', text,
  message_id: 'changed-message', message_version: 1 });

function fixture() {
  const pin = { source_project_id: 'source-project', material_id: 'material', material_version: 2, sha256: digest('synthetic source') };
  const manifest: M4DocumentManifest = { version: 'm4-document-input-v1', kind: 'document', topic_id: 'topic',
    execution_scope_project_id: 'project', draft_version: 1, market: 'sse', offering: 'private', billing_task: 'm4_G05',
    input: { document_type: 'private_summary', source_material: pin, materials: [pin], template: null, edit_base: null,
      scope: 'whole', fields: { issuer_name: 'Synthetic' }, requirements: [] }, template_material: null };
  const hash = inputManifestHash(manifest);
  const run = { id: 'run', owner_user_id: 'owner', project_id: 'project', input_revision: 3, input_hash: hash, task_kind: 'generation' };
  const input = { owner_user_id: 'owner', project_id: 'project', revision: 3, input_hash: hash, manifest,
    draft_revision: 1, material_versions: [pin], rule_pack_version: null, template_version: null };
  const execution = { owner_user_id: 'owner', run_id: 'run', topic_id: 'topic', input_hash: hash, manifest: structuredClone(manifest) };
  const scope = { source_project_id: 'source-project', scope_id: 'project', input_hash: hash,
    manifest: structuredClone(manifest), subtype: 'm4_document_v1' };
  const state = { snapshotAvailable: true };
  const reads: string[] = [];
  const pool = { query: async (sql: string, args: unknown[]) => {
    reads.push(sql);
    if (sql.startsWith('SELECT r.*')) { assert.deepEqual(args, ['owner', 'run']); return { rows: [run] }; }
    if (sql.includes('FROM bb_run_execution_versions')) return { rows: [{ execution_version: 1, input_revision: 3, input_hash: hash }] };
    if (sql.includes('FROM bb_input_revisions')) {
      assert.deepEqual(args, ['owner', 'project', 3]); return { rows: [input] };
    }
    if (sql.includes('FROM bb_review_executions')) return { rows: [] };
    if (sql.startsWith('SELECT e.* FROM bb_m4_executions')) {
      assert.deepEqual(args, ['owner', 'project', 'run']); assert.match(sql, /t\.project_id=\$2/);
      return { rows: state.snapshotAvailable ? [execution] : [] };
    }
    if (sql.startsWith('SELECT t.source_project_id')) {
      assert.deepEqual(args, ['owner', 'topic', 'run', 'project']);
      return { rows: [scope] };
    }
    if (sql.includes('FROM bb_material_versions m')) {
      assert.deepEqual(args, ['owner', 'source-project', 'material', 2]);
      return { rows: [{ filename: 'synthetic.txt', media_type: 'text/plain', object_key: 'exact-source', sha256: pin.sha256 }] };
    }
    throw Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Pool;
  const ctx = { pool, run: { ...run }, lease: { owner: 'owner', runId: 'run', jobId: 'job', token: 'lease',
    attempts: 1, checkpoint: {}, executionVersion: 1, inputRevision: 3, inputHash: hash },
    checkpoint: {}, values: new Map(), signal: new AbortController().signal } as unknown as StageContext;
  return { ctx, reads, input, execution, manifest, scope, state };
}

test('M4 loader resolves the exact execution input and retains scoped source-material checks', async () => {
  const f = fixture(); const loaded = await loadM4WorkerInput(f.ctx);
  assert.deepEqual(loaded.manifest, f.manifest);
  assert.equal(loaded.materials.length, 1);
  assert.equal(loaded.materials[0].pin.source_project_id, 'source-project');
  assert.equal(loaded.materials[0].objectKey, 'exact-source');
  assert.equal(f.reads.filter(sql => sql.includes('FROM bb_input_revisions')).length, 1);
  assert.ok(f.reads.findIndex(sql => sql.includes('FROM bb_run_execution_versions'))
    < f.reads.findIndex(sql => sql.startsWith('SELECT t.source_project_id')));
  assert.doesNotMatch(f.reads.find(sql => sql.startsWith('SELECT t.source_project_id'))!, /JOIN bb_m4_executions/);
});

test('M4 loader rejects stale run/lease identity before reading inputs', async () => {
  for (const mismatch of [
    (ctx: StageContext) => { delete (ctx as Partial<StageContext>).lease; },
    (ctx: StageContext) => { ctx.run.id = 'other'; },
    (ctx: StageContext) => { ctx.run.owner_user_id = 'other'; },
    (ctx: StageContext) => { ctx.run.input_revision = 4; },
    (ctx: StageContext) => { ctx.run.input_hash = '0'.repeat(64); },
  ]) {
    const f = fixture(); mismatch(f.ctx);
    await assert.rejects(loadM4WorkerInput(f.ctx), /INPUT_REVISION_CONFLICT/); assert.deepEqual(f.reads, []);
  }
});

test('M4 loader retains V1-only, persisted project/task and immutable M4 snapshot checks', async () => {
  for (const corrupt of [
    (f: ReturnType<typeof fixture>) => { f.ctx.lease.executionVersion = 2; },
    (f: ReturnType<typeof fixture>) => { f.ctx.run.project_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.ctx.run.task_kind = 'update'; },
    (f: ReturnType<typeof fixture>) => { f.state.snapshotAvailable = false; },
    (f: ReturnType<typeof fixture>) => { f.execution.topic_id = 'other-topic'; },
    (f: ReturnType<typeof fixture>) => { f.execution.input_hash = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.execution.manifest.input.requirements = [requirement('Changed snapshot')]; },
    (f: ReturnType<typeof fixture>) => { f.input.manifest.input.requirements = [requirement('Changed input')]; },
  ]) {
    const f = fixture(); corrupt(f);
    await assert.rejects(loadM4WorkerInput(f.ctx),
      error => (error as { code?: string }).code === 'INPUT_REVISION_CONFLICT' || (error as Error).message === 'INPUT_REVISION_CONFLICT');
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
});

test('M4 supplied snapshots are checked directly and explicit absence never falls back to a database snapshot', async () => {
  const missing = fixture();
  assert.deepEqual(await m4InputGate(missing.ctx.pool, missing.ctx.run, missing.input, null), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
  assert.deepEqual(missing.reads, []);
  for (const corrupt of [
    (f: ReturnType<typeof fixture>) => { f.execution.owner_user_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.execution.run_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.execution.topic_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.execution.input_hash = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.execution.manifest.input.requirements = [requirement('Changed snapshot')]; },
  ]) {
    const f = fixture(); corrupt(f);
    assert.deepEqual(await m4InputGate(f.ctx.pool, f.ctx.run, f.input, f.execution), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.deepEqual(f.reads, [], 'even a valid legacy database snapshot cannot replace a mismatched supplied snapshot');
  }
});

test('M4 standalone gate keeps its execution database check and supplied snapshots retain live scope/subtype checks', async () => {
  const standalone = fixture();
  assert.equal(await m4InputGate(standalone.ctx.pool, standalone.ctx.run, standalone.input), null);
  assert.match(standalone.reads[0], /JOIN bb_m4_executions/);
  for (const corrupt of [
    (f: ReturnType<typeof fixture>) => { f.scope.scope_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.scope.subtype = 'm4_qa_v1'; },
  ]) {
    const f = fixture(); corrupt(f);
    assert.deepEqual(await m4InputGate(f.ctx.pool, f.ctx.run, f.input, f.execution), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
});
