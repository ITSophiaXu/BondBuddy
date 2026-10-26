// Synthetic rows exercise the actual execution reader and review input gate without PostgreSQL.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { loadReviewInput, reviewInputGate, type ReviewManifest } from './review-input.js';
import type { StageContext } from './run-pipeline.js';

function fixture() {
  const owner = 'synthetic-owner', project = 'synthetic-project', runId = 'synthetic-review-run';
  const source = { material_id: 'synthetic-source', material_version: 3, sha256: 'a'.repeat(64) };
  const manifest: ReviewManifest = {
    issuer_name: null, market: null, offering: null, materials: [{ ...source, role: 'historical' }],
    review: { version: 'review_v1', operation: 'full_review', report_id: 'synthetic-report', version_number: 2,
      input: { source_material_ref: source, material_versions: [source], requirements: ['Keep this fixed requirement'], as_of: null },
      source_report_id: null, source_report_sha256: null, finding_ids: [] },
  };
  const hash = inputManifestHash(manifest);
  const persistedRun = { id: runId, owner_user_id: owner, project_id: project, input_revision: 7, input_hash: hash,
    task_kind: 'review', created_at: new Date('2026-10-20T08:00:00Z') };
  const originInput = { owner_user_id: owner, project_id: project, revision: 7, input_hash: hash,
    draft_revision: 4, material_versions: [source], manifest, rule_pack_version: null, template_version: null,
    created_at: new Date('2026-10-19T07:00:00Z') };
  const inputs = [originInput];
  const identities = [{ owner_user_id: owner, project_id: project, run_id: runId, execution_version: 1, input_revision: 7, input_hash: hash }];
  const reviewExecution = { owner_user_id: owner, project_id: project, run_id: runId, report_id: manifest.review.report_id,
    execution_version: 1, input_revision: 7, input_hash: hash, source_report_id: null,
    version: 2, operation: 'full_review', snapshot: { input: manifest.review.input, finding_ids: [] } };
  const state = { snapshotAvailable: true };
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    let rows: unknown[];
    if (sql.includes('FROM bb_input_revisions') && sql.includes('JOIN bb_runs')) {
      // The old loader silently used this origin even when ctx/lease named a different revision.
      const origin = inputs.find(row => row.revision === persistedRun.input_revision);
      rows = origin ? [{ ...origin, created_at: persistedRun.created_at }] : [];
    } else if (sql.includes('FROM bb_runs r JOIN bb_projects')) {
      rows = params[0] === owner && params[1] === runId ? [persistedRun] : [];
    } else if (sql.includes('FROM bb_run_execution_versions')) {
      rows = identities.filter(row => row.owner_user_id === params[0] && row.project_id === params[1] && row.run_id === params[2]);
    } else if (sql.includes('FROM bb_input_revisions')) {
      rows = inputs.filter(row => row.owner_user_id === params[0] && row.project_id === params[1] && row.revision === params[2]);
    } else if (sql.includes('FROM bb_review_execution_snapshots')) {
      assert.deepEqual(params, [owner, project, runId, 1, 7, hash]);
      rows = state.snapshotAvailable ? [reviewExecution] : [];
    } else if (sql.includes('FROM bb_m4_execution_snapshots')) {
      assert.deepEqual(params, [owner, project, runId, 1, 7, hash]);
      rows = [];
    } else if (sql.includes('FROM bb_material_versions')) {
      rows = params[0] === owner && params[1] === project && params[2] === source.material_id && params[3] === source.material_version
        ? [{ sha256: source.sha256, role: 'historical' }] : [];
    } else {
      throw new Error(`Unexpected query: ${sql}`);
    }
    return { rows, rowCount: rows.length };
  } } as unknown as Pool;
  const ctx: StageContext = {
    pool, run: { ...persistedRun },
    lease: { runId, owner, jobId: 'synthetic-job', token: 'synthetic-lease', attempts: 1, checkpoint: {},
      executionVersion: 1, inputRevision: 7, inputHash: hash },
    checkpoint: { review_sources: { snapshots: [{ ...source, snapshot_id: null, response_sha256: null, gap: 'Synthetic unavailable evidence' }] } },
    blobs: {} as StageContext['blobs'], signal: new AbortController().signal, values: new Map(),
  };
  return { ctx, calls, persistedRun, originInput, inputs, identities, manifest, reviewExecution, state };
}

async function rejectsWithoutResult(f: ReturnType<typeof fixture>) {
  const checkpoint = structuredClone(f.ctx.checkpoint);
  await assert.rejects(loadReviewInput(f.ctx), error => {
    assert(error instanceof Error);
    assert.equal('code' in error ? error.code : error.message, 'INPUT_REVISION_CONFLICT');
    return true;
  });
  assert.equal(f.ctx.values.has('review_input'), false);
  assert.deepEqual(f.ctx.checkpoint, checkpoint);
  assert.equal(f.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false);
}

test('review loader consumes the resolved V1 input and keeps the original run creation time', async () => {
  const f = fixture();
  const loaded = await loadReviewInput(f.ctx);
  assert.deepEqual(loaded.requirements, f.manifest.review.input.requirements);
  assert.deepEqual(loaded.evidence.source_material, f.manifest.review.input.source_material_ref);
  assert.equal(loaded.input_hash, f.ctx.lease.inputHash);
  assert.equal(loaded.report_version, 2);
  assert.equal(loaded.created_at, f.persistedRun.created_at.toISOString());
  assert.notEqual(loaded.created_at, f.originInput.created_at.toISOString());
  assert.equal(f.ctx.values.get('review_input'), loaded);
  const reads = f.calls.filter(call => call.sql.includes('FROM bb_input_revisions'));
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].params, [f.ctx.run.owner_user_id, f.ctx.run.project_id, 7]);
  assert.equal(reads[0].sql.includes('JOIN bb_runs'), false);
  assert(f.calls.some(call => call.sql.includes('FROM bb_run_execution_versions')));
  assert.equal(f.calls.filter(call => call.sql.includes('FROM bb_review_execution_snapshots')).length, 1);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_review_executions')), false);
});

test('another revision with identical bytes cannot fall back to the original run input', async () => {
  const f = fixture();
  f.inputs.push({ ...f.originInput, revision: 8 });
  f.ctx.run.input_revision = 8;
  f.ctx.lease.inputRevision = 8;
  await rejectsWithoutResult(f);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_input_revisions')), false);
});

test('review context and lease identity must agree before loading evidence', async t => {
  const changes: [string, (ctx: StageContext) => void][] = [
    ['context run', ctx => { ctx.run.id = 'other-run'; }],
    ['context owner', ctx => { ctx.run.owner_user_id = 'other-owner'; }],
    ['context project', ctx => { ctx.run.project_id = 'other-project'; }],
    ['context revision', ctx => { ctx.run.input_revision = 8; }],
    ['context hash', ctx => { ctx.run.input_hash = 'b'.repeat(64); }],
    ['lease run', ctx => { ctx.lease.runId = 'other-run'; }],
    ['lease owner', ctx => { ctx.lease.owner = 'other-owner'; }],
    ['lease revision', ctx => { ctx.lease.inputRevision = 8; }],
    ['lease hash', ctx => { ctx.lease.inputHash = 'b'.repeat(64); }],
    ['successor execution', ctx => { ctx.lease.executionVersion = 2; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const f = fixture(); change(f.ctx);
    await rejectsWithoutResult(f);
    assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
  });
});

test('missing execution identity never falls back to an otherwise valid origin snapshot', async () => {
  const f = fixture(); f.identities.length = 0;
  await rejectsWithoutResult(f);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_input_revisions')), false);
});

test('missing exact input never selects another revision with the same hash', async () => {
  const f = fixture(); f.inputs[0] = { ...f.originInput, revision: 6 };
  await rejectsWithoutResult(f);
  const reads = f.calls.filter(call => call.sql.includes('FROM bb_input_revisions'));
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].params, [f.ctx.run.owner_user_id, f.ctx.run.project_id, 7]);
});

test('tampered fixed manifest is rejected before material evidence is read', async () => {
  const f = fixture(); f.originInput.manifest = { ...f.manifest, issuer_name: 'Changed after hashing' };
  await rejectsWithoutResult(f);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
});

test('resolved input still passes the existing immutable review snapshot gate', async () => {
  const f = fixture();
  f.reviewExecution.snapshot.input = { ...f.manifest.review.input, requirements: ['Different execution requirement'] };
  await rejectsWithoutResult(f);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
  assert.equal(f.calls.filter(call => call.sql.includes('FROM bb_review_execution_snapshots')).length, 1);
});

test('an explicitly missing or differently scoped resolved review snapshot cannot reload the origin', async () => {
  for (const changes of [null, { owner_user_id: 'other-owner' }, { project_id: 'other-project' }, { run_id: 'other-run' }]) {
    const f = fixture();
    const snapshot = changes === null ? null : { ...f.reviewExecution, ...changes };
    assert.deepEqual(await reviewInputGate(f.ctx.pool, f.ctx.run, f.originInput, snapshot),
      { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.deepEqual(f.calls, []);
  }
});

test('direct review gate callers resolve the exact versioned database snapshot', async () => {
  const f = fixture();
  assert.equal(await reviewInputGate(f.ctx.pool, f.ctx.run, f.originInput), null);
  assert.equal(f.calls.filter(call => call.sql.includes('FROM bb_review_execution_snapshots')).length, 1);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_review_executions')), false);
  f.reviewExecution.snapshot.input = { ...f.manifest.review.input, requirements: ['Changed persisted snapshot'] };
  assert.deepEqual(await reviewInputGate(f.ctx.pool, f.ctx.run, f.originInput),
    { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
});

test('malformed review snapshot objects fail explicitly for resolved and direct database gates', async () => {
  for (const snapshot of [null, [], {}, { input: null }, { input: [] }]) {
    for (const resolved of [true, false]) {
      const f = fixture();
      Object.assign(f.reviewExecution, { snapshot });
      assert.deepEqual(await reviewInputGate(f.ctx.pool, f.ctx.run, f.originInput,
        resolved ? f.reviewExecution : undefined, f.ctx.lease), { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
      assert.equal(f.calls.filter(call => call.sql.includes('FROM bb_review_execution_snapshots')).length, resolved ? 0 : 1);
      assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
    }
  }
});

test('review loader and standalone gate reject missing or mismatched execution snapshots without a legacy fallback', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.state.snapshotAvailable = false; },
    f => { f.reviewExecution.execution_version = 2; },
    f => { f.reviewExecution.input_revision = 8; },
    f => { f.reviewExecution.input_hash = 'b'.repeat(64); },
    f => { f.reviewExecution.owner_user_id = 'other-owner'; },
    f => { f.reviewExecution.project_id = 'other-project'; },
    f => { f.reviewExecution.run_id = 'other-run'; },
  ];
  for (const change of changes) {
    const loader = fixture(); change(loader); await rejectsWithoutResult(loader);
    const direct = fixture(); change(direct);
    assert.deepEqual(await reviewInputGate(direct.ctx.pool, direct.ctx.run, direct.originInput),
      { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    for (const f of [loader, direct]) {
      assert.equal(f.calls.some(call => call.sql.includes('FROM bb_review_executions')), false);
      assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
    }
  }
});

test('supplied review snapshots must match every field of the expected execution identity', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.reviewExecution.execution_version = 2; },
    (f: ReturnType<typeof fixture>) => { f.reviewExecution.input_revision = 8; },
    (f: ReturnType<typeof fixture>) => { f.reviewExecution.input_hash = 'b'.repeat(64); },
  ]) {
    const f = fixture(); change(f);
    assert.deepEqual(await reviewInputGate(f.ctx.pool, f.ctx.run, f.originInput, f.reviewExecution, f.ctx.lease),
      { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.equal(f.calls.some(call => call.sql.includes('FROM bb_review_execution_snapshots')), false);
    assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
  }
});

test('supplied review snapshots and a forged successor identity cannot bypass the persisted V1 execution', async () => {
  const f = fixture(); f.reviewExecution.execution_version = 2;
  const forged = { ...f.ctx.lease, executionVersion: 2 };
  assert.deepEqual(await reviewInputGate(f.ctx.pool, f.ctx.run, f.originInput, f.reviewExecution, forged),
    { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
  assert.equal(f.calls.filter(call => call.sql.includes('FROM bb_run_execution_versions')).length, 1);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_review_execution_snapshots')), false);
  assert.equal(f.calls.some(call => call.sql.includes('FROM bb_material_versions')), false);
});
