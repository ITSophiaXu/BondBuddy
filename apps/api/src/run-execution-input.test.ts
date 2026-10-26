import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { inputManifestHash } from './production-rule-pin.js';
import { readRunExecutionInput } from './run-execution-input.js';

function fixture() {
  const manifest = { synthetic: true, materials: [{ material_id: 'exact', material_version: 2 }] };
  const hash = inputManifestHash(manifest);
  const run = { id: 'run', owner_user_id: 'owner', project_id: 'project', input_revision: 3,
    input_hash: hash, created_at: '2026-10-26T00:00:00Z', task_kind: 'update' };
  const identity = { executionVersion: 1, inputRevision: 3, inputHash: hash };
  const input = { owner_user_id: 'owner', project_id: 'project', revision: 3, input_hash: hash,
    manifest, draft_revision: 2, material_versions: manifest.materials, rule_pack_version: null, template_version: null };
  const state = { run, input, versions: [{ execution_version: 1, input_revision: 3, input_hash: hash }],
    reviews: [] as Record<string, unknown>[], m4: [] as Record<string, unknown>[] };
  const reads: string[] = [];
  const db = { query: async (sql: string, args: unknown[]) => {
    reads.push(sql);
    if (sql.startsWith('SELECT r.*')) {
      assert.deepEqual(args, ['owner', 'run']); return { rows: [state.run] };
    }
    if (sql.includes('FROM bb_run_execution_versions')) {
      assert.deepEqual(args, ['owner', 'project', 'run']); return { rows: state.versions };
    }
    if (sql.includes('FROM bb_input_revisions')) {
      assert.deepEqual(args, ['owner', 'project', 3]);
      assert.doesNotMatch(sql, /latest|max\(|ORDER BY/i); return { rows: [state.input] };
    }
    assert.deepEqual(args, ['owner', 'project', 'run']);
    if (sql.includes('FROM bb_review_executions')) return { rows: state.reviews };
    if (sql.includes('FROM bb_m4_executions')) {
      assert.match(sql, /JOIN bb_m4_topics t/); assert.match(sql, /t\.project_id=\$2/);
      return { rows: state.m4 };
    }
    throw Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Pool;
  return { state, reads, db, identity };
}
const conflict = (error: unknown) => (error as { code?: string }).code === 'INPUT_REVISION_CONFLICT';

test('execution input reader returns exact immutable input and scoped business snapshots without changing origin', async () => {
  const f = fixture();
  f.state.reviews = [{ owner_user_id: 'owner', project_id: 'project', run_id: 'run', version: 1,
    operation: 'revision', snapshot: { input: { material_versions: [] } } }];
  f.state.m4 = [{ owner_user_id: 'owner', run_id: 'run', topic_id: 'topic', manifest: f.state.input.manifest,
    input_hash: f.state.input.input_hash }];
  const before = structuredClone(f.state);
  const result = await readRunExecutionInput(f.db, 'owner', 'run', f.identity);
  assert.equal(result.run.created_at, before.run.created_at);
  assert.equal(result.run.executionVersion, 1);
  assert.deepEqual(result.input, before.input);
  assert.deepEqual(result.reviewExecution, before.reviews[0]);
  assert.deepEqual(result.m4Execution, before.m4[0]);
  assert.deepEqual(f.state, before);
  assert.equal(f.reads.length, 5);
});

test('execution input reader retains V1-only resolution and rejects a changed input manifest or identity', async () => {
  const invalidations = [
    (f: ReturnType<typeof fixture>) => { f.identity.executionVersion = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.versions = []; },
    (f: ReturnType<typeof fixture>) => { f.state.input.manifest.synthetic = false; },
    (f: ReturnType<typeof fixture>) => { f.state.input.input_hash = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.state.input.owner_user_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.state.input.project_id = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.state.input.revision = 4; },
  ];
  for (const invalidate of invalidations) {
    const f = fixture(); invalidate(f);
    await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_review_executions')), false);
  }
});

test('business snapshots may be absent but never come from a different run, owner or project', async () => {
  const f = fixture();
  const result = await readRunExecutionInput(f.db, 'owner', 'run', f.identity);
  assert.equal(result.reviewExecution, null); assert.equal(result.m4Execution, null);
  for (const changes of [{ owner_user_id: 'other' }, { project_id: 'other' }, { run_id: 'other' }]) {
    const review = fixture();
    review.state.reviews = [{ owner_user_id: 'owner', project_id: 'project', run_id: 'run', ...changes }];
    await assert.rejects(readRunExecutionInput(review.db, 'owner', 'run', review.identity), conflict);
  }
  for (const changes of [{ owner_user_id: 'other' }, { run_id: 'other' }]) {
    const m4 = fixture(); m4.state.m4 = [{ owner_user_id: 'owner', run_id: 'run', ...changes }];
    await assert.rejects(readRunExecutionInput(m4.db, 'owner', 'run', m4.identity), conflict);
  }
});
