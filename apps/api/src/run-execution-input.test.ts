import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { inputManifestHash } from './production-rule-pin.js';
import { readRunExecutionInput } from './run-execution-input.js';

function fixture(kind: 'm1' | 'review' | 'review_result' | 'm4' = 'm1') {
  const pin = { material_id: 'exact', material_version: 2, sha256: 'a'.repeat(64) };
  const reviewInput = { source_material_ref: pin, material_versions: [pin], requirements: ['Frozen requirement'], as_of: null };
  const origin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
  let manifest: Record<string, any> = { synthetic: true, materials: [{ ...pin, role: 'other' }] };
  if (kind === 'review') manifest.review = { version: 'review_v1', version_number: 7, operation: 'full_review',
    report_id: 'report', source_report_id: null, source_report_sha256: null, input: reviewInput, finding_ids: [], origin };
  if (kind === 'review_result') manifest.authoring = { version: 'unified_v1', review_result: {
    version: 'review-result-v1', run_id: 'source-run', input_revision: 1, input_hash: 'b'.repeat(64),
    artifact_id: 'source-artifact', artifact_version: 1, sha256: 'c'.repeat(64), source_material: pin,
    requirements: 'Frozen requirement',
  } };
  if (kind === 'm4') manifest = { version: 'm4-document-input-v1', kind: 'document', topic_id: 'topic',
    execution_scope_project_id: 'project', draft_version: 1, market: 'sse', offering: 'private', billing_task: 'm4_G05',
    template_material: null, input: { document_type: 'private_summary', source_material: { ...pin, source_project_id: 'project' },
      materials: [], template: null, edit_base: null, scope: 'whole', fields: {}, requirements: [] } };
  const hash = inputManifestHash(manifest);
  const run = { id: 'run', owner_user_id: 'owner', project_id: 'project', input_revision: 3,
    input_hash: hash, created_at: '2026-10-26T00:00:00Z', task_kind: kind === 'm4' ? 'generation' : kind === 'review' ? 'review' : 'update' };
  const identity = { executionVersion: 1, inputRevision: 3, inputHash: hash };
  const input = { owner_user_id: 'owner', project_id: 'project', revision: 3, input_hash: hash,
    manifest, draft_revision: 2, material_versions: manifest.materials ?? [], rule_pack_version: null, template_version: null };
  const exact = { owner_user_id: 'owner', project_id: 'project', run_id: 'run', execution_version: 1,
    input_revision: 3, input_hash: hash, created_at: '2026-10-25T00:00:00Z' };
  const state = { run, input, versions: [{ execution_version: 1, input_revision: 3, input_hash: hash }],
    reviews: [] as Record<string, any>[], m4: [] as Record<string, any>[] };
  if (kind === 'review' || kind === 'review_result') state.reviews = [{ ...exact, version: 7,
    operation: kind === 'review' ? 'full_review' : 'revision', source_report_id: null,
    snapshot: { input: reviewInput, finding_ids: [], origin, ...(kind === 'review_result' ? { source_run_id: 'source-run' } : {}) } }];
  if (kind === 'm4') state.m4 = [{ ...exact, topic_id: 'topic', manifest }];
  const reads: string[] = [];
  const db = { query: async (sql: string, args: unknown[]) => {
    reads.push(sql);
    assert.doesNotMatch(sql, /bb_review_executions\b|bb_m4_executions\b|latest|max\(|ORDER BY/i);
    if (sql.startsWith('SELECT r.*')) {
      assert.deepEqual(args, ['owner', 'run']); return { rows: [state.run] };
    }
    if (sql.includes('FROM bb_run_execution_versions')) {
      assert.deepEqual(args, ['owner', 'project', 'run', run.input_revision, run.input_hash]); return { rows: state.versions };
    }
    if (sql.includes('FROM bb_input_revisions')) {
      assert.deepEqual(args, ['owner', 'project', 3]);
      assert.doesNotMatch(sql, /latest|max\(|ORDER BY/i); return { rows: [state.input] };
    }
    assert.deepEqual(args, ['owner', 'project', 'run', 1, 3, identity.inputHash]);
    assert.match(sql, /execution_version=\$4/); assert.match(sql, /input_revision=\$5 AND (?:e\.)?input_hash=\$6/);
    if (sql.includes('FROM bb_review_execution_snapshots')) return { rows: state.reviews };
    if (sql.includes('FROM bb_m4_execution_snapshots')) {
      assert.match(sql, /JOIN bb_m4_topics t/); assert.match(sql, /t\.project_id=e\.project_id/);
      return { rows: state.m4 };
    }
    throw Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Pool;
  const rehash = () => {
    const updated = inputManifestHash(state.input.manifest);
    identity.inputHash = state.run.input_hash = state.input.input_hash = state.versions[0].input_hash = updated;
    for (const snapshot of [...state.reviews, ...state.m4]) snapshot.input_hash = updated;
  };
  return { state, reads, db, identity, rehash };
}
const conflict = (error: unknown) => (error as { code?: string }).code === 'INPUT_REVISION_CONFLICT';

test('execution input reader consumes exact versioned business snapshots without changing origin or business versions', async () => {
  for (const kind of ['review', 'review_result', 'm4'] as const) {
    const f = fixture(kind);
    const before = structuredClone(f.state);
    const result = await readRunExecutionInput(f.db, 'owner', 'run', f.identity);
    assert.equal(result.run.created_at, before.run.created_at);
    assert.equal(result.run.executionVersion, 1);
    assert.deepEqual(result.input, before.input);
    assert.deepEqual(result.reviewExecution, before.reviews[0] ?? null);
    assert.deepEqual(result.m4Execution, before.m4[0] ?? null);
    if (result.reviewExecution) assert.equal(result.reviewExecution.version, 7, 'business version is independent from execution V1');
    assert.deepEqual(f.state, before);
    assert.equal(f.reads.length, 5);
  }
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
    assert.equal(f.reads.some(sql => sql.includes('FROM bb_review_execution_snapshots')), false);
  }
});

test('ordinary M1 has no business snapshots; every component of a business snapshot identity is checked', async () => {
  const f = fixture();
  const result = await readRunExecutionInput(f.db, 'owner', 'run', f.identity);
  assert.equal(result.reviewExecution, null); assert.equal(result.m4Execution, null);
  for (const kind of ['review', 'm4'] as const) {
    for (const changes of [{ owner_user_id: 'other' }, { project_id: 'other' }, { run_id: 'other' },
      { execution_version: 2 }, { input_revision: 4 }, { input_hash: '0'.repeat(64) }]) {
      const f = fixture(kind); Object.assign((kind === 'm4' ? f.state.m4 : f.state.reviews)[0], changes);
      await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
    }
  }
});

test('required snapshots reject absence and duplicates without legacy or latest fallback', async () => {
  for (const kind of ['review', 'review_result', 'm4'] as const) {
    for (const duplicate of [false, true]) {
      const f = fixture(kind), rows = kind === 'm4' ? f.state.m4 : f.state.reviews;
      if (duplicate) rows.push(structuredClone(rows[0])); else rows.splice(0);
      await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
    }
  }
});

test('review snapshots reject invalid shapes and changed input, business version, operation, source, origin or findings', async () => {
  for (const mutate of [
    (row: any) => { row.snapshot = []; },
    (row: any) => { row.snapshot.input.requirements = [false]; },
    (row: any) => { row.snapshot.input.requirements = ['Different']; },
    (row: any) => { row.version = 8; },
    (row: any) => { row.operation = 'revision'; },
    (row: any) => { row.source_report_id = 'other-report'; },
    (row: any) => { row.snapshot.origin = { entrypoint: 'invalid' }; },
    (row: any) => { row.snapshot.finding_ids = ['other-finding']; },
  ]) {
    const f = fixture('review'); f.state.reviews[0] = structuredClone(f.state.reviews[0]); mutate(f.state.reviews[0]);
    await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
  }
});

test('review result revisions keep exact source, materials and saved requirements', async () => {
  for (const mutate of [
    (row: any) => { row.snapshot.source_run_id = 'other-run'; },
    (row: any) => { row.snapshot.input.source_material_ref = null; },
    (row: any) => { row.snapshot.input.material_versions = []; },
    (row: any) => { row.snapshot.input.requirements = ['Changed']; },
  ]) {
    const f = fixture('review_result'); f.state.reviews[0] = structuredClone(f.state.reviews[0]); mutate(f.state.reviews[0]);
    await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
  }
});

test('M4 snapshots require shared manifest schema, exact topic/content and task kind', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.state.m4[0].topic_id = 'other-topic'; },
    (f: ReturnType<typeof fixture>) => { f.state.m4[0].manifest = { ...f.state.input.manifest, project_name: 'Changed' }; },
    (f: ReturnType<typeof fixture>) => { f.state.run.task_kind = 'qa'; },
    (f: ReturnType<typeof fixture>) => { f.state.input.manifest.input.requirements = [false]; f.rehash(); },
  ]) {
    const f = fixture('m4'); mutate(f);
    await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
  }
});

test('an ordinary M1 manifest cannot consume an unrelated business snapshot', async () => {
  const f = fixture(); f.state.reviews = fixture('review').state.reviews; f.rehash();
  await assert.rejects(readRunExecutionInput(f.db, 'owner', 'run', f.identity), conflict);
});
