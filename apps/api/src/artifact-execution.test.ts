import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { assertArtifactExecution } from './artifact-execution.js';
import type { RunExecutionIdentity } from './run-execution.js';

type ArtifactRef = {
  id: string; version: number; owner_user_id: string; run_id: string;
  project_id?: string; media_type?: string; sha256?: string; object_key?: string;
};
const inputHash = 'a'.repeat(64), artifactHash = 'b'.repeat(64);
const unavailable = { status: 503, code: 'DATA_UNAVAILABLE' };

function fixture() {
  // Artifact business version 7 belongs to execution V1 and input revision 3.
  const ref: ArtifactRef = { id: 'artifact', version: 7, owner_user_id: 'owner', run_id: 'run' };
  const expected: RunExecutionIdentity = { executionVersion: 1, inputRevision: 3, inputHash };
  const row: Record<string, unknown> = {
    owner_user_id: 'owner', project_id: 'project', run_id: 'run', artifact_id: 'artifact', artifact_version: 7,
    execution_version: 1, input_revision: 3, input_hash: inputHash,
    artifact_media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    artifact_sha256: artifactHash, artifact_object_key: 'users/owner/runs/run/artifacts/artifact/v7.docx',
    run_input_revision: 3, run_input_hash: inputHash,
  };
  const rows: Record<string, unknown>[] = [row];
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    assert.deepEqual(args, ['owner', 'run', 'artifact', 7], 'lookup pins the business artifact version');
    assert.doesNotMatch(sql, /\blatest\b|\bmax\s*\(|ORDER BY|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    return { rows };
  } } as unknown as Pool;
  return { ref, expected, row, rows, calls, db };
}

test('artifact execution returns the exact V1 identity without confusing artifact and execution versions', async () => {
  const f = fixture(), before = structuredClone(f.rows);
  assert.deepEqual(await assertArtifactExecution(f.db, f.ref), { ...f.expected, projectId: 'project' });
  assert.deepEqual(await assertArtifactExecution(f.db, f.ref, f.expected), { ...f.expected, projectId: 'project' });
  assert.deepEqual(f.rows, before);
  assert.equal(f.calls.length, 2);
});

test('artifact execution checks optional project and registered content metadata when supplied', async () => {
  const f = fixture();
  const pinned = { ...f.ref, project_id: 'project', media_type: String(f.row.artifact_media_type),
    sha256: artifactHash, object_key: String(f.row.artifact_object_key) };
  assert.deepEqual(await assertArtifactExecution(f.db, pinned, f.expected), { ...f.expected, projectId: 'project' });
  for (const field of ['project_id', 'media_type', 'sha256', 'object_key'] as const) {
    await assert.rejects(assertArtifactExecution(f.db, { ...pinned, [field]: 'different' }, f.expected), unavailable, field);
    await assert.rejects(assertArtifactExecution(f.db, { ...pinned, [field]: '' }, f.expected), unavailable, `${field} cannot be ignored when empty`);
  }
});

test('missing and duplicate artifact bindings fail without registry or latest fallback', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    if (duplicate) f.rows.push({ ...f.row }); else f.rows.length = 0;
    await assert.rejects(assertArtifactExecution(f.db, f.ref, f.expected), unavailable);
    assert.equal(f.calls.length, 1, 'an unavailable binding cannot cause another lookup or repair');
  }
});

test('every artifact binding scope component must match the requested owned artifact version', async () => {
  for (const [field, value] of [
    ['owner_user_id', 'other-owner'], ['project_id', 'other-project'], ['run_id', 'other-run'],
    ['artifact_id', 'other-artifact'], ['artifact_version', 8],
  ] as const) {
    const f = fixture(); f.row[field] = value;
    await assert.rejects(assertArtifactExecution(f.db, { ...f.ref, project_id: 'project' }), unavailable, field);
  }
  for (const field of ['owner_user_id', 'project_id', 'run_id', 'artifact_id', 'artifact_version']) {
    const f = fixture(); delete f.row[field];
    await assert.rejects(assertArtifactExecution(f.db, f.ref), unavailable, `missing ${field}`);
  }
});

test('artifact execution refuses successors and incomplete or changed original run inputs', async () => {
  for (const [field, value] of [
    ['execution_version', 2], ['execution_version', 0], ['execution_version', '1'],
    ['input_revision', 4], ['input_hash', 'c'.repeat(64)],
    ['run_input_revision', 4], ['run_input_hash', 'c'.repeat(64)],
    ['run_input_revision', null], ['run_input_hash', null],
    ['input_revision', null], ['input_hash', null],
  ] as const) {
    const f = fixture(); f.row[field] = value;
    await assert.rejects(assertArtifactExecution(f.db, f.ref), unavailable, field);
  }
  for (const revision of [0, -1, 1.5, '3', null]) {
    const f = fixture(); f.row.input_revision = f.row.run_input_revision = revision;
    await assert.rejects(assertArtifactExecution(f.db, f.ref), unavailable, `invalid matching revision ${revision}`);
  }
  for (const hash of ['', 'not-a-hash', 'A'.repeat(64)]) {
    const f = fixture(); f.row.input_hash = f.row.run_input_hash = hash;
    await assert.rejects(assertArtifactExecution(f.db, f.ref), unavailable, 'invalid matching input hashes');
  }
});

test('a supplied worker execution must match version, revision and hash independently', async () => {
  for (const change of [
    { executionVersion: 2 }, { inputRevision: 4 }, { inputHash: 'c'.repeat(64) },
  ]) {
    const f = fixture();
    await assert.rejects(assertArtifactExecution(f.db, f.ref, { ...f.expected, ...change }), unavailable);
  }
  const f = fixture();
  await assert.rejects(assertArtifactExecution(f.db, f.ref,
    { executionVersion: 1 } as RunExecutionIdentity), unavailable, 'a partially supplied identity cannot authorize a result');
});

test('registered metadata corruption cannot satisfy a caller carrying the exact content pin', async () => {
  for (const [field, value] of [
    ['artifact_media_type', 'text/plain'], ['artifact_sha256', 'c'.repeat(64)],
    ['artifact_object_key', 'users/other/runs/other/artifacts/other/v7.docx'],
    ['artifact_media_type', null], ['artifact_sha256', null], ['artifact_object_key', null],
  ] as const) {
    const f = fixture();
    const pin = { ...f.ref, media_type: String(f.row.artifact_media_type), sha256: artifactHash,
      object_key: String(f.row.artifact_object_key) };
    f.row[field] = value;
    await assert.rejects(assertArtifactExecution(f.db, pin, f.expected), unavailable, field);
  }
});
