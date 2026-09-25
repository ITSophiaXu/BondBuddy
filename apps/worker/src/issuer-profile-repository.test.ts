import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import {
  appendIssuerBusinessProfile, getPendingIssuerBusinessProfile, loadReviewedIssuerAnnualProfile,
  type IssuerBusinessProfileClient, type IssuerBusinessProfileDependencies, type IssuerBusinessProfilePool,
} from './issuer-profile-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('ISSUER_BUSINESS_PROFILE_TEST_DATABASE_URL');
const owner = 'issuer-profile-owner-synthetic';
const project = 'issuer-profile-project-synthetic';
const run = 'issuer-profile-run-synthetic';
const material = 'issuer-profile-material-synthetic';
const inputHash = 'a'.repeat(64);
const evidenceRefs = ['issuer-evidence-source', 'issuer-evidence-a', 'issuer-evidence-b', 'issuer-evidence-c'];

function profile(overrides: Partial<AnnualBusinessProfile> = {}): AnnualBusinessProfile {
  return {
    issuerId: 'synthetic-target-issuer', profileVersion: 'caller-version-is-ignored', taxonomyVersion: 'taxonomy-synthetic-v1',
    fiscalYear: 2025, completeAnnualPeriod: true, latestCompleteAnnual: true, verificationStatus: 'verified',
    accountingScope: 'consolidated', revenueBasis: 'operating_revenue', currency: 'CNY', unit: 'yuan',
    allComparableBusinessLinesPresent: true, sourceEvidence: [evidenceRefs[0]!],
    lines: ['A', 'B', 'C'].map((code, index) => ({ code, label: `Synthetic ${code}`, originalLabel: `原始业务${code}`,
      revenue: String(300 - index * 100), rank: index + 1, evidence: [evidenceRefs[index + 1]!],
      classificationEvidence: [evidenceRefs[0]!] })),
    ...overrides,
  };
}

const scope = { ownerUserId: owner, projectId: project, runId: run, inputRevision: 1, inputHash };
const appendInput = (overrides: Record<string, unknown> = {}) => ({ ...scope, requestId: 'issuer-request-synthetic',
  sourceMaterialId: material, sourceMaterialVersion: 1, profile: profile(), ...overrides });

class MockClient implements IssuerBusinessProfileClient {
  calls: { sql: string; values: unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
  outbox: Record<string, unknown>[] = [];
  knownEvidence = new Set(evidenceRefs);
  sourceExists = true;
  materialRole = 'audit';
  failOutbox = false;
  private before: { rows: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null = null;
  released = false;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.before = { rows: structuredClone(this.rows), outbox: structuredClone(this.outbox) }; return { rows: [] }; }
    if (sql === 'COMMIT') { this.before = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.before) { this.rows = this.before.rows; this.outbox = this.before.outbox; }
      this.before = null; return { rows: [] };
    }
    if (sql.includes('FROM bb_runs r') && sql.includes('FOR UPDATE OF i')) {
      return { rows: this.sourceExists && values[0] === owner && values[1] === project && values[2] === run &&
        values[3] === 1 && values[6] === inputHash ? [{ id: run, input_revision: 1, input_hash: inputHash,
          material_versions: [{ material_id: material, material_version: 1 }], role: this.materialRole }] : [] };
    }
    if (sql.includes('FROM bb_parse_evidence e')) return { rows: (values[4] as string[]).filter(ref => this.knownEvidence.has(ref)).map(record_id => ({ record_id })) };
    if (sql.includes('FROM bb_issuer_business_profiles') && sql.includes('request_id=$4')) return {
      rows: this.rows.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] && row.run_id === values[2] && row.request_id === values[3]),
    };
    if (sql.includes('max(profile_version)')) return { rows: [{ profile_version: this.rows.length ? Math.max(...this.rows.map(row => Number(row.profile_version))) : 0 }] };
    if (sql.startsWith('INSERT INTO bb_issuer_business_profiles')) {
      const profileValue = JSON.parse(String(values[11])) as Record<string, unknown>;
      const row = { id: values[0], owner_user_id: values[1], project_id: values[2], run_id: values[3], input_revision: values[4],
        input_hash: values[5], source_material_id: values[6], source_material_version: values[7], profile_version: values[8],
        request_id: values[9], request_hash: values[10], profile: profileValue, profile_sha256: values[12],
        evidence_refs: JSON.parse(String(values[13])) as string[], review_status: 'pending_review', created_at: new Date('2026-09-25T00:00:00Z') };
      this.rows.push(row); return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_id: values[2], event_type: 'issuer.business_profile.pending_review' });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  release(): void { this.released = true; }
}

function dependencies(client: MockClient): IssuerBusinessProfileDependencies {
  let id = 0;
  return { pool: { connect: async () => client, query: (sql, values) => client.query(sql, values) }, newId: () => `issuer-id-${++id}` };
}

test('append snapshots bind owner/run/input/material and force every caller status to pending review', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  const callerProfile = profile({ verificationStatus: 'verified', profileVersion: '999' });
  const first = await appendIssuerBusinessProfile(deps, appendInput({ profile: callerProfile }));
  assert.equal(first.reviewStatus, 'pending_review');
  assert.equal(first.profile.verificationStatus, 'pending');
  assert.equal(first.profile.profileVersion, '1');
  assert.equal(first.profileSha256.length, 64);
  assert.deepEqual(first.evidenceRefs, [...evidenceRefs].sort());
  assert.equal(client.rows.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(client.released, true);
  assert.match(client.calls.find(call => call.sql.includes('FROM bb_runs r'))!.sql,
    /r\.owner_user_id=\$1 AND r\.project_id=\$2 AND r\.id=\$3 AND r\.input_revision=\$4 AND r\.input_hash=\$7/);
  assert.match(client.calls.find(call => call.sql.includes('FROM bb_parse_evidence e'))!.sql,
    /e\.owner_user_id=\$1 AND e\.project_id=\$2 AND e\.material_id=\$3 AND e\.material_version=\$4/);

  const replay = await appendIssuerBusinessProfile(deps, appendInput({ profile: { ...callerProfile, verificationStatus: 'rejected' } }));
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);
  assert.equal(client.rows.length, 1);
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ profile: profile({ lines: [
    { ...profile().lines[0]!, revenue: '301' }, ...profile().lines.slice(1),
  ] }) })), /ISSUER_PROFILE_IDEMPOTENCY_CONFLICT/);
});

test('does not accept fabricated review fields, foreign sources or unbound evidence; outbox failure rolls back', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ profile: { ...profile(), reviewStatus: 'reviewed' } })),
    /INVALID_ISSUER_ANNUAL_BUSINESS_PROFILE/);
  client.sourceExists = false;
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ requestId: 'missing-run' })), /ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND/);
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ requestId: 'wrong-input-hash', inputHash: 'b'.repeat(64) })), /ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND/);
  client.sourceExists = true;
  client.materialRole = 'historical';
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ requestId: 'wrong-source-role' })), /ISSUER_PROFILE_SOURCE_NOT_FINANCIAL/);
  client.materialRole = 'audit';
  client.knownEvidence.delete(evidenceRefs[2]!);
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ requestId: 'wrong-source-evidence' })), /ISSUER_PROFILE_EVIDENCE_NOT_IN_SOURCE_SNAPSHOT/);
  client.knownEvidence.add(evidenceRefs[2]!);
  client.failOutbox = true;
  await assert.rejects(appendIssuerBusinessProfile(deps, appendInput({ requestId: 'outbox-failure' })), /synthetic outbox failure/);
  assert.equal(client.rows.length, 0);
  assert.equal(client.outbox.length, 0);
});

test('pending profile read checks hash and generation loader never invents an authenticated reviewer', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  const stored = await appendIssuerBusinessProfile(deps, appendInput());
  const pool = deps.pool;
  // A test read adapter emulates the strict SQL scope join and exposes the inserted immutable row.
  pool.query = async (sql, values = []) => {
    assert.match(sql, /JOIN bb_runs r ON r\.owner_user_id=p\.owner_user_id/);
    return values[0] === owner && values[1] === project && values[2] === run && values[3] === 1 && values[4] === inputHash
      ? { rows: client.rows.slice(-1) } : { rows: [] };
  };
  const pending = await getPendingIssuerBusinessProfile(pool, scope);
  assert.equal(pending?.id, stored.id);
  assert.equal(pending?.profile.revenueBasis, 'operating_revenue', 'the original basis is retained as submitted');
  assert.equal(await loadReviewedIssuerAnnualProfile(pool, scope), null);
  assert.equal(await getPendingIssuerBusinessProfile(pool, { ...scope, ownerUserId: 'foreign-owner' }), null);
  const tampered = { ...client.rows[0]!, profile_sha256: 'f'.repeat(64) };
  pool.query = async () => ({ rows: [tampered] });
  await assert.rejects(getPendingIssuerBusinessProfile(pool, scope), /ISSUER_PROFILE_HASH_OR_STATUS_MISMATCH/);
});

const liveUrl = testDatabaseUrl;
test('PostgreSQL 16: input/run/material/evidence binding, append-only guard and pending-only storage', { skip: !liveUrl }, async () => {
  const pool = new Pool({ connectionString: liveUrl });
  const connection = await pool.connect();
  const savepoint = `issuer_profile_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const liveOwner = `issuer-owner-${suffix}`, liveProject = `issuer-project-${suffix}`, liveRun = `issuer-run-${suffix}`;
  const liveMaterial = `issuer-material-${suffix}`, uploadId = `issuer-upload-${suffix}`;
  const sourceHash = 'c'.repeat(64), parserHash = 'd'.repeat(64), evidenceId = `issuer-evidence-${suffix}`;
  const liveInputHash = 'b'.repeat(64), parserId = `issuer-parser-${suffix}`;
  try {
    await connection.query('BEGIN');
    await connection.query(`SAVEPOINT ${savepoint}`);
    await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic issuer profile','update')`, [liveProject, liveOwner]);
    await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'audit.pdf','application/pdf',10,$4,'audit',$5,now()+interval '1 hour','completed')`,
      [uploadId, liveOwner, liveProject, sourceHash, `synthetic/${suffix}/upload`]);
    await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'audit','audit.pdf','application/pdf',10,$5,$6,'parsed')`,
      [liveMaterial, liveOwner, liveProject, uploadId, sourceHash, `users/${liveOwner}/projects/${liveProject}/audit`]);
    await connection.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}',$4::jsonb,'[]')`, [liveProject, liveOwner, liveInputHash,
        JSON.stringify([{ material_id: liveMaterial, material_version: 1 }])]);
    await connection.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'preparing')`, [liveRun, liveOwner, liveProject, liveInputHash, `execute-${suffix}`, liveInputHash]);
    await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'parser-issuer-synthetic-1',$6,'{}','parsed','document-parse-response-v1',$7,1,$8::jsonb)`,
      [parserId, liveOwner, liveProject, liveMaterial, sourceHash, parserHash, 'e'.repeat(64), JSON.stringify({ schema_version: 'document-parse-response-v1',
        request_id: `${parserId}-request`, parser_version: 'parser-issuer-synthetic-1', status: 'parsed',
        material: { material_id: liveMaterial, material_version: 1, media_type: 'application/pdf', sha256: sourceHash },
        warnings: [], document: { page_count: 1 }, error: null })]);
    await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox','{"page":1}','synthetic revenue','synthetic','native_text','parser-issuer-synthetic-1',1,'[]','{}',$7,0)`,
      [liveOwner, liveProject, liveMaterial, parserId, evidenceId, sourceHash, 'f'.repeat(64)]);
    const proxy: IssuerBusinessProfileClient = {
      query: async (sql, values) => {
        if (sql === 'BEGIN') return connection.query(`SAVEPOINT ${savepoint}_repository`, values);
        if (sql === 'COMMIT') return connection.query(`RELEASE SAVEPOINT ${savepoint}_repository`, values);
        if (sql === 'ROLLBACK') return connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}_repository`, values);
        return connection.query(sql, values);
      }, release: () => undefined,
    };
    const liveDeps: IssuerBusinessProfileDependencies = { pool: { connect: async () => proxy, query: (sql, values) => connection.query(sql, values) },
      newId: () => `issuer-profile-${suffix}` };
    const liveProfile = profile({ sourceEvidence: [evidenceId], lines: [{ code: 'A', label: 'Synthetic A', originalLabel: '原始业务A', revenue: '100', rank: 1,
      evidence: [evidenceId], classificationEvidence: [evidenceId] }] });
    const saved = await appendIssuerBusinessProfile(liveDeps, { ownerUserId: liveOwner, projectId: liveProject, runId: liveRun,
      inputRevision: 1, inputHash: liveInputHash, requestId: `profile-${suffix}`, sourceMaterialId: liveMaterial, sourceMaterialVersion: 1, profile: liveProfile });
    assert.equal(saved.reviewStatus, 'pending_review');
    await assert.rejects(appendIssuerBusinessProfile(liveDeps, { ownerUserId: liveOwner, projectId: liveProject, runId: liveRun,
      inputRevision: 1, inputHash: 'f'.repeat(64), requestId: `profile-wrong-hash-${suffix}`, sourceMaterialId: liveMaterial,
      sourceMaterialVersion: 1, profile: liveProfile }), /ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND/);
    assert.equal(await loadReviewedIssuerAnnualProfile(liveDeps.pool, { ownerUserId: liveOwner, projectId: liveProject,
      runId: liveRun, inputRevision: 1, inputHash: liveInputHash }), null);
    await connection.query(`SAVEPOINT ${savepoint}_immutable`);
    await assert.rejects(connection.query(`UPDATE bb_issuer_business_profiles SET review_status='reviewed' WHERE id=$1`, [saved.id]), /immutable/);
    await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}_immutable`);
    await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    const rows = await connection.query(`SELECT count(*)::int AS count FROM bb_issuer_business_profiles WHERE owner_user_id=$1`, [liveOwner]);
    assert.equal(rows.rows[0]?.count, 0);
    await connection.query('ROLLBACK');
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch { /* preserve test failure */ }
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
});
