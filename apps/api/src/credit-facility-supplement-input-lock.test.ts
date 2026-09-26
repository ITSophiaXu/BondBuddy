import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const origin = 'http://bondbuddy.test';
const testDatabaseUrl = await isolatedTestDatabase('CREDIT_FACILITY_INPUT_PIN_TEST_DATABASE_URL');

test('input revisions lock exact owner/project credit supplement versions without promoting user assertions', {
  skip: !testDatabaseUrl && 'set CREDIT_FACILITY_INPUT_PIN_TEST_DATABASE_URL to a migrated PostgreSQL 16 template through 0050',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const ownerA = `credit-pin-owner-${suffix}`;
  const ownerB = `credit-pin-owner-b-${suffix}`;
  let activeOwner = ownerA;
  const app = createServer({ pool, principal: async () => ({ userId: activeOwner, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown): Promise<any> => app.inject({
    method: method as any, url, headers: { origin }, ...(payload === undefined ? {} : { payload: payload as any }),
  });
  const createProject = async (name: string) => {
    const response = await send('POST', '/api/v1/projects', { name, kind: 'review', issuer_name: null, market: null, offering: null });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  const amount = (sourceId: string, value: string) => ({ bank: '合成银行', as_of: '2025-03-31', currency: 'CNY', unit: '万元',
    basis: '授信额度', scope: 'consolidated', amount: value, source_id: sourceId, statement_date: '2025-04-02' });
  const supplement = async (project: string, requestId: string, total: string, used: string, unused: string, supersedes: unknown = null) => {
    const response = await send('POST', `/api/v1/projects/${project}/credit-facility-supplements`, {
      request_id: requestId, amounts: { total: amount(`${requestId}-t`, total), used: amount(`${requestId}-u`, used), unused: amount(`${requestId}-n`, unused) }, supersedes,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const lockInput = (project: string, refs?: unknown) => send('POST', `/api/v1/projects/${project}/input-revisions`, {
    draft_revision: 1, material_versions: [], requirement_message_ids: [], ...(refs === undefined ? {} : { credit_facility_supplements: refs }),
  });
  try {
    const projectA = await createProject(`Supplement pin A ${suffix}`);
    const projectB = await createProject(`Supplement pin B ${suffix}`);
    const first = await supplement(projectA, `pin-source-${suffix}`, '100', '80', '20');
    const firstRef = { supplement_id: first.supplement_id, version: first.version, request_hash: first.request_hash };

    const lockedResponse = await lockInput(projectA, [firstRef]);
    assert.equal(lockedResponse.statusCode, 201, lockedResponse.body);
    const locked = lockedResponse.json();
    assert.deepEqual(locked.credit_facility_supplements, [firstRef]);
    const storedBefore = await pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [ownerA, projectA, locked.input_revision]);
    const lockedManifest = storedBefore.rows[0]!.manifest as Record<string, any>;
    assert.deepEqual(lockedManifest.credit_facility_supplements, [{ ...firstRef, status: 'user_asserted', eligible_for_manuscript: false }]);
    assert.equal(lockedManifest.credit_facility_supplements[0].status, 'user_asserted');
    assert.equal(lockedManifest.credit_facility_supplements[0].eligible_for_manuscript, false);
    const historicalGet = await send('GET', `/api/v1/projects/${projectA}/input-revisions/${locked.input_revision}`);
    assert.equal(historicalGet.statusCode, 200, historicalGet.body);
    assert.deepEqual(historicalGet.json().credit_facility_supplements, [firstRef]);

    const foreignProject = await lockInput(projectB, [firstRef]);
    assert.equal(foreignProject.statusCode, 404, 'same owner cannot pin a row from another project');
    const staleVersion = await lockInput(projectA, [{ ...firstRef, version: 9 }]);
    assert.equal(staleVersion.statusCode, 404, staleVersion.body);
    const staleHash = await lockInput(projectA, [{ ...firstRef, request_hash: 'a'.repeat(64) }]);
    assert.equal(staleHash.statusCode, 409, staleHash.body);
    const duplicate = await lockInput(projectA, [firstRef, firstRef]);
    assert.equal(duplicate.statusCode, 422, duplicate.body);
    const forgedStatus = await lockInput(projectA, [{ ...firstRef, status: 'verified' }]);
    assert.equal(forgedStatus.statusCode, 422, 'the reference DTO rejects client status/amount assertions');
    const forgedAmount = await lockInput(projectA, [{ ...firstRef, amount: '0' }]);
    assert.equal(forgedAmount.statusCode, 422, 'the reference DTO cannot contain client-supplied financial values');
    activeOwner = ownerB;
    const foreignOwner = await send('POST', `/api/v1/projects/${projectA}/input-revisions`, {
      draft_revision: 1, material_versions: [], requirement_message_ids: [], credit_facility_supplements: [firstRef],
    });
    assert.equal(foreignOwner.statusCode, 404, foreignOwner.body);
    activeOwner = ownerA;

    const runId = `credit-pin-run-${suffix}`;
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,$4,$5,$6,'review',$7,'paused')`, [runId, ownerA, projectA, locked.input_revision, locked.input_hash, `run-key-${suffix}`, 'b'.repeat(64)]);
    const second = await supplement(projectA, `pin-revision-${suffix}`, '100', '80', '20', { supplement_id: first.supplement_id, version: 1 });
    const secondRef = { supplement_id: second.supplement_id, version: second.version, request_hash: second.request_hash };
    const nextInputResponse = await lockInput(projectA, [secondRef]);
    assert.equal(nextInputResponse.statusCode, 201, nextInputResponse.body);
    const nextInput = nextInputResponse.json();
    assert.notEqual(nextInput.input_hash, locked.input_hash, 'a new exact supplement version changes the canonical input hash');
    const oldAfterRevision = await send('GET', `/api/v1/projects/${projectA}/input-revisions/${locked.input_revision}`);
    assert.equal(oldAfterRevision.statusCode, 200);
    assert.equal(oldAfterRevision.json().input_hash, locked.input_hash);
    assert.deepEqual(oldAfterRevision.json().credit_facility_supplements, [firstRef]);
    const oldManifestAfter = await pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [ownerA, projectA, locked.input_revision]);
    assert.equal(oldManifestAfter.rows[0]!.input_hash.trim(), storedBefore.rows[0]!.input_hash.trim());
    assert.deepEqual(oldManifestAfter.rows[0]!.manifest, storedBefore.rows[0]!.manifest);
    const persistedRun = await pool.query('SELECT input_revision,input_hash FROM bb_runs WHERE owner_user_id=$1 AND id=$2', [ownerA, runId]);
    assert.equal(persistedRun.rows[0]!.input_revision, locked.input_revision);
    assert.equal(persistedRun.rows[0]!.input_hash.trim(), locked.input_hash);

    const conflicted = await supplement(projectA, `pin-conflict-${suffix}`, '100', '80', '40');
    const conflictRef = { supplement_id: conflicted.supplement_id, version: conflicted.version, request_hash: conflicted.request_hash };
    assert.equal(conflicted.status, 'conflicted');
    const conflictedInput = await lockInput(projectA, [conflictRef]);
    assert.equal(conflictedInput.statusCode, 201, 'an unresolved user assertion is lockable, not silently promoted or rejected');
    const preflight = await send('POST', `/api/v1/projects/${projectA}/preflight`, {
      input_revision: conflictedInput.json().input_revision, input_hash: conflictedInput.json().input_hash,
    });
    assert.equal(preflight.statusCode, 200, preflight.body);
    assert.ok(preflight.json().uncertainty.some((value: string) => value.startsWith('credit_facility_supplement_conflicted:')));
    assert.ok(!preflight.json().missing_inputs.some((value: string) => value.startsWith('credit_facility_supplement_')),
      'supplement uncertainty is local and does not turn an otherwise partial update into a global hard block');

    const concurrent = await Promise.all([lockInput(projectB), lockInput(projectB, [])]);
    assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [201, 201]);
    const concurrentInputs = concurrent.map(response => response.json()).sort((a, b) => a.input_revision - b.input_revision);
    assert.equal(concurrentInputs[1]!.input_revision, concurrentInputs[0]!.input_revision + 1, 'input POSTs remain append-per-request under the project lock');
    assert.equal(concurrentInputs[0]!.input_hash, concurrentInputs[1]!.input_hash, 'omitted refs and an explicit empty list share the same manifest/hash semantics');
    assert.equal(concurrentInputs[0]!.credit_facility_supplements, undefined);
  } finally {
    await app.close();
    await pool.end();
  }
});
