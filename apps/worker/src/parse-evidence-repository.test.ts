import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaterialParserDependencies } from './material-parser.js';
import {
  getParseSnapshot,
  parseAndPersistAuthorizedMaterial,
  persistParseSnapshot,
  type ParseEvidenceClient,
  type ParseEvidenceDependencies,
  type TrustedParseEvidenceContext,
} from './parse-evidence-repository.js';

const owner = 'owner-synthetic';
const project = 'project-synthetic';
const materialId = 'material-synthetic';
const materialBytes = Buffer.from('synthetic parse snapshot material\n');
const hash = createHash('sha256').update(materialBytes).digest('hex');
const context: TrustedParseEvidenceContext = {
  ownerUserId: owner, projectId: project, materialId, materialVersion: 1, requestId: 'job-synthetic-1',
};

function response(requestId = context.requestId, status: DocumentParseResponse['status'] = 'parsed', target = {
  materialId, materialVersion: 1, sha256: hash,
}): DocumentParseResponse {
  const records: DocumentParseResponse['records'] = status === 'failed' ? [] : [{
    record_id: 'record-synthetic-1', material_id: target.materialId, material_version: target.materialVersion, content_hash: target.sha256,
    locator_type: 'text_line', locator: { line: 1, stable_ref: 'text:l000001' },
    literal_quote: 'synthetic line one', context: '', extraction_method: 'native_text',
    extractor_version: 'parser-synthetic-1', confidence: null,
    uncertainty: status === 'needs_confirmation' ? ['synthetic uncertainty'] : [], formatting: {},
  }];
  return {
    schema_version: 'document-parse-response-v1', request_id: requestId, parser_version: 'parser-synthetic-1', status,
    material: { material_id: target.materialId, material_version: target.materialVersion, media_type: 'text/plain', sha256: target.sha256 },
    records, warnings: status === 'needs_confirmation' ? [{ code: 'NEEDS_CONFIRMATION', message: 'synthetic ambiguity' }] : [],
    document: status === 'failed' ? { page_count: null } : { page_count: null, encoding: 'utf-8' },
    error: status === 'failed' ? { code: 'SYNTHETIC_FAILURE', message: 'synthetic parser failure' } : null,
  };
}

type State = { snapshots: Record<string, unknown>[]; requests: Record<string, unknown>[]; evidence: Record<string, unknown>[]; outbox: Record<string, unknown>[] };
class MemoryPool implements ParseEvidenceClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly state: State = { snapshots: [], requests: [], evidence: [], outbox: [] };
  materialPresent = true;
  readonly materialSha = hash;
  materialMediaType = 'text/plain';
  failOutbox = false;
  private before: State | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.before = structuredClone(this.state); return { rows: [] }; }
    if (sql === 'COMMIT') { this.before = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.before) {
        this.state.snapshots.splice(0, this.state.snapshots.length, ...this.before.snapshots);
        this.state.requests.splice(0, this.state.requests.length, ...this.before.requests);
        this.state.evidence.splice(0, this.state.evidence.length, ...this.before.evidence);
        this.state.outbox.splice(0, this.state.outbox.length, ...this.before.outbox);
      }
      this.before = null; return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT media_type, sha256 FROM bb_material_versions')) {
      const valid = values[0] === owner && values[1] === project && values[2] === materialId && values[3] === 1;
      return { rows: valid && this.materialPresent ? [{ media_type: this.materialMediaType, sha256: this.materialSha }] : [] };
    }
    if (sql.includes('FROM bb_parse_snapshot_requests')) {
      return { rows: this.state.requests.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.request_id === values[4]) };
    }
    if (sql.includes('FROM bb_parse_snapshots')) {
      if (sql.includes('JOIN bb_material_versions') && !this.materialPresent) return { rows: [] };
      const rows = sql.includes('parser_version = $5')
        ? this.state.snapshots.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
          row.material_id === values[2] && row.material_version === values[3] && row.parser_version === values[4])
        : this.state.snapshots.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
          row.material_id === values[2] && row.material_version === values[3] && row.id === values[4]);
      return { rows };
    }
    if (sql.includes('FROM bb_parse_evidence')) {
      const rows = this.state.evidence.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.snapshot_id === values[4]);
      return { rows: rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) };
    }
    if (sql.startsWith('INSERT INTO bb_parse_snapshots')) {
      const row = {
        id: values[0], owner_user_id: values[1], project_id: values[2], material_id: values[3], material_version: values[4],
        content_sha256: values[5], parser_version: values[6], request_hash: values[7],
        request_options: JSON.parse(String(values[8])), response_status: values[9],
        response_schema_version: values[10], response_sha256: values[11], record_count: values[12],
        response_meta: JSON.parse(String(values[13])), created_at: new Date('2026-09-24T00:00:00Z'),
      };
      this.state.snapshots.push(row); return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_parse_evidence')) {
      this.state.evidence.push({ owner_user_id: values[0], project_id: values[1], material_id: values[2], material_version: values[3],
        snapshot_id: values[4], record_id: values[5], content_sha256: values[6], locator_type: values[7], locator: JSON.parse(String(values[8])),
        literal_quote: values[9], context: values[10], extraction_method: values[11], extractor_version: values[12], confidence: values[13],
        uncertainty: JSON.parse(String(values[14])), formatting: JSON.parse(String(values[15])), record_sha256: values[16], ordinal: values[17] });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO bb_parse_snapshot_requests')) {
      this.state.requests.push({ owner_user_id: values[0], project_id: values[1], material_id: values[2], material_version: values[3],
        request_id: values[4], request_hash: values[5], snapshot_id: values[6] }); return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.state.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_id: values[2], event_type: 'material.parse_completed',
        payload: JSON.parse(String(values[3])) }); return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  release(): void {}
}

function dependencies(pool: MemoryPool): ParseEvidenceDependencies {
  let id = 0;
  return { pool: { connect: async () => pool, query: (sql, values) => pool.query(sql, values) }, newId: () => `synthetic-id-${++id}` };
}

test('persists complete parsed evidence atomically and same material/version/parser retries reuse the first snapshot', async () => {
  const pool = new MemoryPool();
  const deps = dependencies(pool);
  const parseContext = { ...context, options: { max_pages: 5 } };
  const firstResponse = response();
  const first = await persistParseSnapshot(deps, parseContext, { mediaType: 'text/plain', sha256: hash }, firstResponse);
  const retry = await persistParseSnapshot(deps, { ...parseContext, requestId: 'job-synthetic-2' }, { mediaType: 'text/plain', sha256: hash },
    response('job-synthetic-2'));
  assert.equal(first.response.status, 'parsed');
  assert.equal(first.evidence[0]?.literal_quote, 'synthetic line one');
  assert.deepEqual(first.evidence[0]?.locator, { line: 1, stable_ref: 'text:l000001' });
  assert.equal(first.snapshotId, retry.snapshotId);
  assert.equal(first.requestOptions.max_pages, 5);
  assert.equal(retry.replayed, true);
  assert.equal(pool.state.snapshots.length, 1);
  assert.equal(pool.state.evidence.length, 1);
  assert.equal(pool.state.requests.length, 2);
  assert.equal(pool.state.outbox.length, 1);
  const storedMeta = pool.state.snapshots[0]!.response_meta as Record<string, unknown>;
  assert.equal(Object.hasOwn(storedMeta, 'records'), false, 'large record bodies live in bounded evidence rows');
  const requested = await getParseSnapshot(deps, context, first.snapshotId);
  assert.equal(requested?.response.status, 'parsed');
  assert.equal(requested?.response.records[0]?.literal_quote, 'synthetic line one');
  assert.equal(await getParseSnapshot(deps, { ...context, ownerUserId: 'foreign-owner' }, first.snapshotId), null);
  assert.equal(await getParseSnapshot(deps, { ...context, materialId: 'foreign-material' }, first.snapshotId), null);
  const scopedRead = pool.calls.find(call => call.sql.includes('FROM bb_parse_snapshots') && call.sql.includes('AND s.id = $5'))!.sql;
  assert.match(scopedRead, /s\.owner_user_id = \$1 AND s\.project_id = \$2 AND s\.material_id = \$3 AND s\.material_version = \$4 AND s\.id = \$5/);
  assert.match(scopedRead, /JOIN bb_material_versions[\s\S]*m\.deleted_at IS NULL/);
  pool.materialPresent = false;
  assert.equal(await getParseSnapshot(deps, context, first.snapshotId), null, 'deleted material source text is no longer readable');
});

test('failed and uncertain statuses persist explicitly and never become parsed', async () => {
  for (const state of ['needs_confirmation', 'failed'] as const) {
    const pool = new MemoryPool();
    const saved = await persistParseSnapshot(dependencies(pool), { ...context, requestId: `job-${state}` },
      { mediaType: 'text/plain', sha256: hash }, response(`job-${state}`, state));
    assert.equal(saved.response.status, state);
    assert.equal(pool.state.snapshots[0]?.response_status, state);
    assert.equal(pool.state.snapshots[0]?.record_count, state === 'failed' ? 0 : 1);
    assert.equal(pool.state.evidence.length, state === 'failed' ? 0 : 1);
  }
});

test('persist helper rejects a media type that disagrees with the owned material row', async () => {
  const pool = new MemoryPool();
  pool.materialMediaType = 'application/pdf';
  await assert.rejects(persistParseSnapshot(dependencies(pool), context,
    { mediaType: 'text/plain', sha256: hash }, response()), /PARSE_EVIDENCE_MATERIAL_NOT_AUTHORIZED/);
  assert.equal(pool.state.snapshots.length, 0);
  assert.equal(pool.state.outbox.length, 0);
});

test('same request ID with different options and same parser identity with changed content/options fail closed', async () => {
  const pool = new MemoryPool();
  const deps = dependencies(pool);
  await persistParseSnapshot(deps, context, { mediaType: 'text/plain', sha256: hash }, response());
  await assert.rejects(persistParseSnapshot(deps, { ...context, options: { max_pages: 3 } },
    { mediaType: 'text/plain', sha256: hash }, response()), /PARSE_REQUEST_IDEMPOTENCY_MISMATCH/);
  await assert.rejects(persistParseSnapshot(deps, { ...context, requestId: 'job-synthetic-new', options: { max_pages: 3 } },
    { mediaType: 'text/plain', sha256: hash }, response('job-synthetic-new')), /PARSE_SNAPSHOT_INPUT_MISMATCH/);
  assert.equal(pool.state.snapshots.length, 1);
  assert.equal(pool.state.requests.length, 1);
  assert.equal(pool.state.outbox.length, 1);
});

test('same input and parser version with a different output conflicts instead of hiding parser drift', async () => {
  const pool = new MemoryPool();
  const deps = dependencies(pool);
  await persistParseSnapshot(deps, context, { mediaType: 'text/plain', sha256: hash }, response());
  const altered = response();
  altered.records[0] = { ...altered.records[0]!, literal_quote: 'synthetic but different result' };
  await assert.rejects(persistParseSnapshot(deps, context, { mediaType: 'text/plain', sha256: hash }, altered),
    /PARSE_SNAPSHOT_RESULT_CONFLICT/);
  await assert.rejects(persistParseSnapshot(deps, { ...context, requestId: 'job-result-conflict' },
    { mediaType: 'text/plain', sha256: hash }, response('job-result-conflict', 'needs_confirmation')),
  /PARSE_SNAPSHOT_RESULT_CONFLICT/);
  assert.equal(pool.state.snapshots.length, 1);
  assert.equal(pool.state.evidence[0]?.literal_quote, 'synthetic line one');
  assert.equal(pool.state.requests.length, 1);
  assert.equal(pool.state.outbox.length, 1);
});

test('outbox failure rolls back snapshot, evidence, and request alias together', async () => {
  const pool = new MemoryPool();
  pool.failOutbox = true;
  await assert.rejects(persistParseSnapshot(dependencies(pool), context, { mediaType: 'text/plain', sha256: hash }, response()),
    /PARSE_SNAPSHOT_PERSIST_FAILED/);
  assert.deepEqual(pool.state, { snapshots: [], requests: [], evidence: [], outbox: [] });
});

test('authorized parse composition binds the owned Blob SHA, persists anchors, and rejects another owner before bytes', async () => {
  const evidencePool = new MemoryPool();
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-parse-evidence-composition-'));
  let blobReads = 0;
  let parserCalls = 0;
  const storedMaterial = {
    owner_user_id: owner, project_id: project, id: materialId, version: 1, media_type: 'text/plain',
    byte_size: materialBytes.byteLength, sha256: hash, object_key: `users/${owner}/${project}/${materialId}/v1`, role: 'audit',
  };
  const materialDependencies: MaterialParserDependencies = {
    pool: {
      async query(sql, values = []) {
        assert.match(sql, /owner_user_id\s*=\s*\$1[\s\S]*project_id\s*=\s*\$2[\s\S]*id\s*=\s*\$3[\s\S]*version\s*=\s*\$4/);
        const matches = values[0] === owner && values[1] === project && values[2] === materialId && values[3] === 1;
        return { rows: matches ? [storedMaterial] : [] };
      },
    },
    blobs: { async getPrivate(key) { blobReads += 1; assert.equal(key, storedMaterial.object_key); return materialBytes; } },
    tempRoot,
    parser: async (request: DocumentParseRequest) => {
      parserCalls += 1;
      assert.equal(request.material.sha256, hash);
      assert.equal(request.material.material_id, materialId);
      assert.equal(request.material.material_version, 1);
      return response(request.request_id, 'parsed');
    },
  };
  try {
    const result = await parseAndPersistAuthorizedMaterial(materialDependencies, dependencies(evidencePool), {
      ownerUserId: owner, projectId: project, materialId, version: 1, requestId: 'composed-job-synthetic',
    });
    assert.equal(result.response.status, 'parsed');
    assert.equal(result.evidence[0]?.literal_quote, 'synthetic line one');
    assert.equal(evidencePool.state.snapshots[0]?.content_sha256, hash);
    assert.equal(evidencePool.state.outbox.length, 1);
    assert.equal(blobReads, 1);
    assert.equal(parserCalls, 1);
    await assert.rejects(parseAndPersistAuthorizedMaterial(materialDependencies, dependencies(evidencePool), {
      ownerUserId: 'owner-foreign', projectId: project, materialId, version: 1, requestId: 'foreign-job-synthetic',
    }), /NOT_FOUND/);
    assert.equal(blobReads, 1, 'foreign owner is rejected before accessing private bytes');
    assert.equal(parserCalls, 1);
    assert.equal(evidencePool.state.snapshots.length, 1);
    assert.equal(evidencePool.state.outbox.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const liveUrl = process.env.PARSE_EVIDENCE_TEST_DATABASE_URL;
test('PostgreSQL 16: immutable snapshots, request aliases, access scope and transaction rollback', { skip: !liveUrl }, async () => {
  const pool = new Pool({ connectionString: liveUrl });
  const client = await pool.connect();
  const savepoint = `parse_evidence_${process.pid}`;
  try {
    await client.query('BEGIN');
    await client.query(`SAVEPOINT ${savepoint}`);
    const suffix = Math.random().toString(36).slice(2);
    const liveOwner = `parse-owner-${suffix}`;
    const liveProject = `parse-project-${suffix}`;
    const liveMaterial = `parse-material-${suffix}`;
    const uploadId = `parse-upload-${suffix}`;
    const objectKey = `users/${liveOwner}/projects/${liveProject}/parse-test-${suffix}`;
    await client.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic parse project','update')`, [liveProject, liveOwner]);
    await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.txt','text/plain',$4,$5,'audit', $6,now() + interval '1 hour','completed')`,
    [uploadId, liveOwner, liveProject, materialBytes.byteLength, hash, `${objectKey}/upload`]);
    await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'audit','synthetic.txt','text/plain',$5,$6,$7,'persisted')`,
    [liveMaterial, liveOwner, liveProject, uploadId, materialBytes.byteLength, hash, objectKey]);
    const liveDeps: ParseEvidenceDependencies = {
      pool: {
        connect: async () => ({
          query: async (sql, values = []) => {
            if (sql === 'BEGIN') return client.query(`SAVEPOINT ${savepoint}_inner`, values);
            if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${savepoint}_inner`, values);
            if (sql === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${savepoint}_inner`, values);
            return client.query(sql, values);
          },
          release() {},
        }),
        query: (sql, values) => client.query(sql, values),
      },
      newId: () => `parse-outbox-${suffix}`,
    };
    const liveContext = { ownerUserId: liveOwner, projectId: liveProject, materialId: liveMaterial, materialVersion: 1, requestId: `parse-job-${suffix}` };
    const liveTarget = { materialId: liveMaterial, materialVersion: 1, sha256: hash };
    const first = await persistParseSnapshot(liveDeps, liveContext, { mediaType: 'text/plain', sha256: hash }, response(liveContext.requestId, 'parsed', liveTarget));
    const second = await persistParseSnapshot(liveDeps, { ...liveContext, requestId: `parse-retry-${suffix}` },
      { mediaType: 'text/plain', sha256: hash }, response(`parse-retry-${suffix}`, 'parsed', liveTarget));
    assert.equal(second.snapshotId, first.snapshotId);
    assert.equal(second.replayed, true);
    assert.equal((await getParseSnapshot(liveDeps, liveContext, first.snapshotId))?.evidence[0]?.literal_quote, 'synthetic line one');
    assert.equal(await getParseSnapshot(liveDeps, { ...liveContext, ownerUserId: `${liveOwner}-other` }, first.snapshotId), null);
    await client.query(`SAVEPOINT ${savepoint}_immutable`);
    await assert.rejects(client.query(`UPDATE bb_parse_snapshots SET response_status='failed' WHERE id=$1`, [first.snapshotId]));
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}_immutable`);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    for (const table of ['bb_parse_snapshots', 'bb_parse_snapshot_requests', 'bb_parse_evidence']) {
      const count = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_user_id=$1 AND project_id=$2`, [liveOwner, liveProject]);
      assert.equal(count.rows[0]?.n, 0, `${table} synthetic rows are rolled back by the outer transaction`);
    }
    const outbox = await client.query(`SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2`, [liveOwner, first.snapshotId]);
    assert.equal(outbox.rows[0]?.n, 0);
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve test failure */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
