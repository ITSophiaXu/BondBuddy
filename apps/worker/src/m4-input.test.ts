import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { M4DocumentManifest, M4Requirement } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { projectRunExecution } from '@bondbuddy/api/run-execution';
import { loadM4WorkerInput, loadM4SupplementInput, m4InputGate } from './m4-input.js';
import type { StageContext } from './run-pipeline.js';

const requirement = (text: string): M4Requirement => ({ requirement_id: 'changed-requirement', text,
  message_id: 'changed-message', message_version: 1 });

function fixture(withArtifact = false) {
  const pin = { source_project_id: 'source-project', material_id: 'material', material_version: 2, sha256: digest('synthetic source') };
  const artifact = {source_project_id: 'source-project', artifact_id: 'original-artifact', artifact_version: 2, sha256: digest('original artifact')};
  const manifest: M4DocumentManifest = { version: 'm4-document-input-v1', kind: 'document', topic_id: 'topic',
    execution_scope_project_id: 'project', draft_version: 1, market: 'sse', offering: 'private', billing_task: 'm4_G05',
    input: { document_type: 'private_summary', source_material: pin, materials: [pin], template: null, edit_base: withArtifact ? artifact : null,
      scope: 'whole', fields: { issuer_name: 'Synthetic' }, requirements: [] }, template_material: null };
  const hash = inputManifestHash(manifest);
  const run = { id: 'run', owner_user_id: 'owner', project_id: 'project', input_revision: 3, input_hash: hash, task_kind: 'generation' };
  const input = { owner_user_id: 'owner', project_id: 'project', revision: 3, input_hash: hash, manifest,
    draft_revision: 1, material_versions: [pin], rule_pack_version: null, template_version: null };
  const execution = { owner_user_id: 'owner', project_id: 'project', run_id: 'run', execution_version: 1,
    input_revision: 3, topic_id: 'topic', input_hash: hash, manifest: structuredClone(manifest) };
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
    if (sql.includes('FROM bb_review_execution_snapshots')) {
      assert.deepEqual(args, ['owner', 'project', 'run', 1, 3, hash]); return { rows: [] };
    }
    if (sql.includes('FROM bb_m4_execution_snapshots')) {
      assert.deepEqual(args, ['owner', 'project', 'run', 1, 3, hash]);
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
    if (sql.includes('FROM bb_m4_execution_artifact_versions')) {
      assert.deepEqual(args, ['owner', artifact.artifact_id, artifact.artifact_version]);
      return {rows: [{kind: 'document', document_type: 'private_summary'}]};
    }
    if (sql.includes('FROM bb_delivered_artifact_versions')) {
      assert.deepEqual(args, ['owner', artifact.source_project_id, artifact.artifact_id, artifact.artifact_version]);
      return {rows: [{object_key: 'original-artifact-object', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: artifact.sha256}]};
    }
    throw Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Pool;
  const ctx = { pool, run: projectRunExecution(run, { executionVersion: 1, inputRevision: run.input_revision, inputHash: run.input_hash }), lease: { owner: 'owner', runId: 'run', jobId: 'job', token: 'lease',
    attempts: 1, checkpoint: {}, executionVersion: 1, inputRevision: 3, inputHash: hash },
    checkpoint: {}, values: new Map(), signal: new AbortController().signal } as unknown as StageContext;
  return { ctx, reads, input, run, execution, manifest, scope, state };
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
    (ctx: StageContext) => { ctx.run = { ...ctx.run, id: 'other' }; },
    (ctx: StageContext) => { ctx.run = { ...ctx.run, owner_user_id: 'other' }; },
    (ctx: StageContext) => { ctx.run = { ...ctx.run, input_revision: 4 }; },
    (ctx: StageContext) => { ctx.run = { ...ctx.run, input_hash: '0'.repeat(64) }; },
    (ctx: StageContext) => { ctx.run = { ...ctx.run, executionVersion: 2 }; },
    (ctx: StageContext) => { ctx.run = { ...ctx.run, inputRevision: 4 }; },
    (ctx: StageContext) => { ctx.run = { ...ctx.run, inputHash: '0'.repeat(64) }; },
  ]) {
    const f = fixture(); mismatch(f.ctx);
    await assert.rejects(loadM4WorkerInput(f.ctx), /INPUT_REVISION_CONFLICT/); assert.deepEqual(f.reads, []);
  }
});

test('M4 loader retains V1-only, persisted project/task and immutable M4 snapshot checks', async () => {
  for (const corrupt of [
    (f: ReturnType<typeof fixture>) => { f.ctx.lease.executionVersion = 2; },
    (f: ReturnType<typeof fixture>) => { f.ctx.run = { ...f.ctx.run, project_id: 'other' }; },
    (f: ReturnType<typeof fixture>) => { f.ctx.run = { ...f.ctx.run, task_kind: 'update' }; },
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
    assert.deepEqual(await m4InputGate(f.ctx.pool, f.ctx.run, f.input, f.execution, f.ctx.lease), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.deepEqual(f.reads, [], 'even a valid legacy database snapshot cannot replace a mismatched supplied snapshot');
  }
});

test('M4 standalone gate keeps its execution database check and supplied snapshots retain live scope/subtype checks', async () => {
  const standalone = fixture();
  assert.equal(await m4InputGate(standalone.ctx.pool, standalone.run, standalone.input), null);
  assert.ok(standalone.reads.some(sql => sql.includes('FROM bb_m4_execution_snapshots')));
  assert.equal(standalone.reads.some(sql => sql.includes('FROM bb_m4_executions')), false);
  for (const corrupt of [
    (f: ReturnType<typeof fixture>) => { f.scope.scope_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.scope.subtype = 'm4_qa_v1'; },
  ]) {
    const f = fixture(); corrupt(f);
    assert.deepEqual(await m4InputGate(f.ctx.pool, f.ctx.run, f.input, f.execution, f.ctx.lease), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
});

test('M4 gates reject a projected successor version even when the expected V1 input bytes agree', async () => {
  for (const supplied of [false, true]) {
    const f = fixture();
    const projected = { ...f.ctx.run, executionVersion: 2 };
    assert.deepEqual(await m4InputGate(f.ctx.pool, projected, f.input, supplied ? f.execution : undefined, f.ctx.lease),
      { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.equal(f.reads.filter(sql => sql.includes('FROM bb_run_execution_versions')).length, 1);
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_input_revisions')), false);
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_m4_execution_snapshots')), false);
    assert.equal(f.reads.some(sql => sql.startsWith('SELECT t.source_project_id')), false);
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
});

test('M4 loader and standalone gate reject absent or mismatched versioned snapshots without reading legacy state', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.snapshotAvailable = false; },
    (f: ReturnType<typeof fixture>) => { f.execution.execution_version = 2; },
    (f: ReturnType<typeof fixture>) => { f.execution.input_revision = 4; },
    (f: ReturnType<typeof fixture>) => { f.execution.input_hash = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.execution.project_id = 'other'; },
  ]) {
    const loader = fixture(); change(loader);
    await assert.rejects(loadM4WorkerInput(loader.ctx),
      error => (error as { code?: string }).code === 'INPUT_REVISION_CONFLICT' || (error as Error).message === 'INPUT_REVISION_CONFLICT');
    const direct = fixture(); change(direct);
    assert.deepEqual(await m4InputGate(direct.ctx.pool, direct.ctx.run, direct.input), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    for (const f of [loader, direct]) {
      assert.equal(f.reads.some(sql => sql.includes('FROM bb_m4_executions')), false);
      assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
    }
  }
});

test('supplied M4 snapshots must match every field of the expected execution identity', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.execution.execution_version = 2; },
    (f: ReturnType<typeof fixture>) => { f.execution.input_revision = 4; },
    (f: ReturnType<typeof fixture>) => { f.execution.input_hash = '0'.repeat(64); },
  ]) {
    const f = fixture(); change(f);
    assert.deepEqual(await m4InputGate(f.ctx.pool, f.ctx.run, f.input, f.execution, f.ctx.lease), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_m4_execution_snapshots')), false);
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
});

test('supplied M4 snapshots and a forged successor identity cannot bypass the persisted V1 execution', async () => {
  const f = fixture(); f.execution.execution_version = 2;
  const forged = { ...f.ctx.lease, executionVersion: 2 };
  assert.deepEqual(await m4InputGate(f.ctx.pool, f.ctx.run, f.input, f.execution, forged), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
  assert.equal(f.reads.filter(sql => sql.includes('FROM bb_run_execution_versions')).length, 1);
  assert.equal(f.reads.some(sql => sql.includes('FROM bb_m4_execution_snapshots')), false);
  assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
});

test('M4 candidate files share the exact authorized loader after the original execution gate, without changing its identity', async () => {
  const f = fixture(true), originalHash = f.ctx.run.input_hash;
  const added = {source_project_id: 'project', material_id: 'added', material_version: 1, sha256: digest('added evidence')};
  const query = f.ctx.pool.query.bind(f.ctx.pool);
  f.ctx.pool.query = (async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM bb_material_versions m') && args[2] === added.material_id) {
      assert.deepEqual(args, ['owner', 'project', 'added', 1]);
      f.reads.push(sql);
      return {rows: [{filename: 'added.txt', media_type: 'text/plain', object_key: 'added-object', sha256: added.sha256}]};
    }
    return query(sql, args);
  }) as Pool['query'];
  const candidate = structuredClone(f.manifest); candidate.input.materials.push(added);
  const loaded = await loadM4SupplementInput({pool: f.ctx.pool, owner: 'owner', projectId: 'project', runId: 'run',
    sourceExecution: f.ctx.lease, manifest: candidate, candidateInputHash: inputManifestHash(candidate)});
  assert.equal(loaded.run.input_hash, originalHash);
  assert.equal(f.ctx.run.input_hash, originalHash);
  assert.equal(f.ctx.lease.inputHash, originalHash);
  assert.notEqual(inputManifestHash(candidate), originalHash);
  assert.deepEqual(loaded.input.manifest, candidate);
  assert.deepEqual(loaded.input.materials.map(file => file.pin), [f.manifest.input.source_material, added]);
  assert.equal(loaded.input.materials[1].objectKey, 'added-object');
  assert.deepEqual(loaded.input.artifacts.map(file => file.pin), [f.manifest.input.edit_base]);
  assert.equal(loaded.input.artifacts[0].objectKey, 'original-artifact-object');
  assert.ok(f.reads.some(sql => sql.startsWith('SELECT t.source_project_id')), 'actual live scope/subtype gate still runs');
});

test('M4 candidate preparation cannot change source/template/requirements/method scope or bypass a failing live source gate', async () => {
  for (const corrupt of [
    (m: M4DocumentManifest) => {m.input.requirements = [requirement('unconfirmed new requirement')];},
    (m: M4DocumentManifest) => {m.input.source_material = {...m.input.source_material!, sha256: 'a'.repeat(64)};},
    (m: M4DocumentManifest) => {m.input.edit_base = {source_project_id: 'project', artifact_id: 'new-artifact', artifact_version: 1, sha256: 'b'.repeat(64)};},
    (m: M4DocumentManifest) => {m.input.document_type = 'init';},
  ]) {
    const f = fixture(), candidate = structuredClone(f.manifest); corrupt(candidate);
    await assert.rejects(loadM4SupplementInput({pool: f.ctx.pool, owner: 'owner', projectId: 'project', runId: 'run',
      sourceExecution: f.ctx.lease, manifest: candidate, candidateInputHash: inputManifestHash(candidate)}), /INPUT_REVISION_CONFLICT/);
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
  }
  const f = fixture(); f.scope.subtype = 'm4_qa_v1';
  await assert.rejects(loadM4SupplementInput({pool: f.ctx.pool, owner: 'owner', projectId: 'project', runId: 'run',
    sourceExecution: f.ctx.lease, manifest: f.manifest, candidateInputHash: inputManifestHash(f.manifest)}), /INPUT_REVISION_CONFLICT/);
  assert.equal(f.reads.some(sql => sql.includes('FROM bb_material_versions m')), false);
});
