import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { runDocumentParser } from './document-parser.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { isolatedTestDatabase } from './test-database.js';

type AuthorizedManifest = { cases: Array<{ case_id: string; files: Array<{
  file_id: string; path: string; original_filename: string; upload_role: string; media_type: string; bytes: number; sha256: string;
  evidence: Array<{ locator: string; quote: string }>;
}> }> };

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestRoot = join(sourceRoot, 'tests/samples/2026-09-25');
const pythonExecutable = process.env.BB_PYTHON?.trim() || join(sourceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const optedIn = process.env.BB_RUN_AUTHORIZED_RQ_UPLOAD_PARSE === '1';
const testDatabaseUrl = optedIn ? await isolatedTestDatabase('AUTHORIZED_RQ_UPLOAD_PARSE_TEST_DATABASE_URL') : undefined;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// The original path and quote are sent over stdin, not argv. stdout is deliberately boolean-only.
const OOXML_CHECK = String.raw`
import json, sys, zipfile, xml.etree.ElementTree as ET
payload = json.load(sys.stdin)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with zipfile.ZipFile(payload['path']) as archive:
    root = ET.fromstring(archive.read('word/document.xml'))
def resolve(anchor):
    current = root.find('w:body', ns)
    for part in anchor['path']:
        if 'paragraph' in part:
            nodes = [node for node in current if node.tag == '{%s}p' % ns['w']]
            current = nodes[part['paragraph'] - 1]
        elif 'table' in part:
            tables = [node for node in current if node.tag == '{%s}tbl' % ns['w']]
            table = tables[part['table'] - 1]
            rows = [node for node in table if node.tag == '{%s}tr' % ns['w']]
            cells = [node for node in rows[part['row'] - 1] if node.tag == '{%s}tc' % ns['w']]
            current = cells[part['column'] - 1]
    text = ''.join(node.text or '' for node in current.iter('{%s}t' % ns['w']))
    return anchor['quote'] in text
def source_xpath_matches(anchor):
    number = int(anchor['source_xpath'].rsplit('[', 1)[1][:-1])
    nodes = list(root.iter('{%s}p' % ns['w']))
    item = nodes[number - 1]
    return anchor['quote'] in ''.join(node.text or '' for node in item.iter('{%s}t' % ns['w']))
print(json.dumps({
    'quote_found_at_parser_locators': [resolve(anchor) for anchor in payload['anchors']],
    'quote_found_at_manifest_xpaths': [source_xpath_matches(anchor) for anchor in payload['anchors']],
}))
`;

test('authorized rq-202506 DOCX crosses public upload, private Blob, durable Python parse and source anchor checks', {
  skip: !optedIn ? 'set BB_RUN_AUTHORIZED_RQ_UPLOAD_PARSE=1 to run the authorized upload/parser integration'
    : !testDatabaseUrl ? 'set AUTHORIZED_RQ_UPLOAD_PARSE_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
      : !blobConnection ? 'set BB_TEST_AZURITE_CONNECTION_STRING for a disposable Azurite instance'
        : false,
}, async () => {
  assert.ok(testDatabaseUrl && blobConnection);
  assert.ok(existsSync(pythonExecutable), 'the configured Python parser interpreter must exist');
  const manifest = JSON.parse(await readFile(join(manifestRoot, 'manifest.json'), 'utf8')) as AuthorizedManifest;
  const sample = manifest.cases.find(item => item.case_id === 'rq-202506');
  assert.ok(sample, 'rq-202506 must be registered');
  const file = sample.files.find(item => item.file_id === 'rq-202506-01');
  assert.ok(file, 'the authorized historical DOCX must be manifest registered');
  assert.deepEqual([file.upload_role, file.media_type, file.bytes, file.sha256], [
    'historical', DOCX, 925141, 'd19e8dca15ed3bc6c1288523263a951eb682ee488363f027d37c951957f2a182',
  ]);
  const bytes = await readFile(join(manifestRoot, file.path));
  assert.equal(bytes.byteLength, file.bytes, 'authorized bytes must match manifest size');
  assert.equal(sha256(bytes), file.sha256, 'authorized bytes must match manifest SHA-256');
  const knownP4 = file.evidence.find(anchor => anchor.locator === 'word/document.xml//w:p[4]');
  const knownP65 = file.evidence.find(anchor => anchor.locator === 'word/document.xml//w:p[65]');
  const knownP249 = file.evidence.find(anchor => anchor.locator === 'word/document.xml//w:p[249]');
  assert.ok(knownP4 && knownP65 && knownP249, 'the three registered OOXML anchors must be present');

  const pool = new Pool({ connectionString: testDatabaseUrl });
  const owner = `authorized-upload-${randomUUID()}`;
  const foreignOwner = `foreign-upload-${randomUUID()}`;
  let activeOwner = owner;
  const suffix = randomUUID().replaceAll('-', '');
  const container = `bb-rq-upload-${suffix}`;
  const blobs = azureBlobs(blobConnection, container);
  const app = createServer({ pool, blobs, allowedOrigin: origin,
    principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({
    method: method as never, url, payload: payload as never,
    headers: { origin, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
  });
  try {
    const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    assert.ok(Number(version.rows[0]!.server_version_num) >= 160000 && Number(version.rows[0]!.server_version_num) < 170000,
      'this regression requires PostgreSQL 16');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)', [
      owner, `u${suffix.slice(0, 28)}`, foreignOwner, `f${suffix.slice(0, 28)}`,
    ]);

    const created = await send('POST', '/api/v1/projects', {
      name: 'Authorized upload parse regression', kind: 'update', issuer_name: null, market: null, offering: null,
    });
    assert.equal(created.statusCode, 201, 'owner can create a project');
    const projectId = created.json().project_id as string;
    const declaration = { byte_size: file.bytes, sha256: file.sha256 };
    const started = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      ...declaration, filename: file.original_filename, role: 'historical', media_type: file.media_type,
    });
    assert.equal(started.statusCode, 201, 'owner can start upload');
    const session = started.json() as { upload_id: string; upload_url: string };
    const put = await send('PUT', session.upload_url, bytes);
    assert.equal(put.statusCode, 204, 'public byte upload completes');
    const completed = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`, declaration);
    assert.equal(completed.statusCode, 200, 'public upload completion persists the material');
    const materialId = completed.json().material_id as string;

    const persisted = await pool.query<{ object_key: string; sha256: string; byte_size: number; project_id: string }>(
      `SELECT object_key,sha256,byte_size,project_id FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1`, [owner, projectId, materialId]);
    assert.equal(persisted.rowCount, 1);
    assert.deepEqual([persisted.rows[0]!.sha256.trim(), Number(persisted.rows[0]!.byte_size), persisted.rows[0]!.project_id],
      [file.sha256, file.bytes, projectId]);
    const privateObject = await blobs.getIfExistsBounded(persisted.rows[0]!.object_key, file.bytes);
    assert.ok(privateObject, 'completed upload bytes must be in private Azurite Blob');
    assert.deepEqual([privateObject.byteLength, sha256(privateObject)], [file.bytes, file.sha256]);

    const queued = await pool.query<{ id: string; state: string; parser_version: string; material_sha256: string }>(
      `SELECT id,state,parser_version,material_sha256 FROM bb_jobs
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND job_type='parse'`, [owner, projectId, materialId]);
    assert.equal(queued.rowCount, 1, 'upload completion must enqueue exactly one durable parse job');
    const job = queued.rows[0]!;
    assert.equal(job.state, 'queued');
    assert.equal(job.parser_version, documentParserVersion());
    assert.equal(job.material_sha256.trim(), file.sha256);

    const parser = (request: Parameters<typeof runDocumentParser>[0]) => runDocumentParser(request, {
      pythonExecutable, repoRoot: sourceRoot,
    });
    const outcome = await runMaterialParseOnce({
      pool, leaseSeconds: 300,
      material: { pool, blobs: {
        getPrivate: key => blobs.getIfExists(key),
        readToFile: (key, path, max) => blobs.readToFile!(key, path, max),
      }, parser },
    });
    assert.equal(outcome, 'succeeded', 'the real Python parser should persist its durable parse evidence');

    const parsed = await pool.query<{ state: string; parser_version: string; material_sha256: string; checkpoint: Record<string, any> }>(
      'SELECT state,parser_version,material_sha256,checkpoint FROM bb_jobs WHERE id=$1 AND owner_user_id=$2', [job.id, owner]);
    assert.equal(parsed.rowCount, 1);
    assert.equal(parsed.rows[0]!.state, 'succeeded');
    assert.equal(parsed.rows[0]!.parser_version, documentParserVersion());
    assert.equal(parsed.rows[0]!.material_sha256.trim(), file.sha256);
    const snapshotId = parsed.rows[0]!.checkpoint.stages.parse_evidence.snapshot_id as string;
    assert.ok(snapshotId);
    const snapshot = await pool.query<{ content_sha256: string; response_status: string; response_meta: { status: string }; record_count: number }>(
      `SELECT content_sha256,response_status,response_meta,record_count FROM bb_parse_snapshots WHERE id=$1 AND owner_user_id=$2
        AND project_id=$3 AND material_id=$4 AND parser_version=$5`,
      [snapshotId, owner, projectId, materialId, documentParserVersion()]);
    assert.equal(snapshot.rowCount, 1);
    assert.equal(snapshot.rows[0]!.content_sha256.trim(), file.sha256);
    assert.ok(['parsed', 'needs_confirmation'].includes(snapshot.rows[0]!.response_status));
    assert.equal(snapshot.rows[0]!.response_meta.status, snapshot.rows[0]!.response_status);

    const evidence = await pool.query<{ ordinal: number; locator: Record<string, unknown>; literal_quote: string }>(
      `SELECT ordinal,locator,literal_quote FROM bb_parse_evidence WHERE snapshot_id=$1 AND owner_user_id=$2
        AND project_id=$3 AND material_id=$4 ORDER BY ordinal`,
      [snapshotId, owner, projectId, materialId]);
    const evidenceCount = evidence.rows.length;
    assert.equal(snapshot.rows[0]!.record_count, 9970, 'the authorized DOCX currently has the documented full parser record count');
    assert.equal(snapshot.rows[0]!.record_count, evidenceCount, 'snapshot record count must equal persisted evidence count');
    assert.ok(evidenceCount > 0);
    assert.deepEqual([evidence.rows[0]!.ordinal, evidence.rows.at(-1)!.ordinal], [0, evidenceCount - 1]);
    assert.ok(evidence.rows.every((row, index) => row.ordinal === index), 'evidence ordinals must be complete and contiguous');
    const atPath = (part: Record<string, unknown>) => evidence.rows.filter(row =>
      Array.isArray(row.locator.path) && (row.locator.path as Array<Record<string, unknown>>).some(item =>
        Object.entries(part).every(([key, value]) => item[key] === value)));
    const p4 = atPath({ paragraph: 4 });
    // Manifest `//w:p[n]` counts OOXML descendants; parser paragraph indexes are
    // body-block-local. Bind each manifest quote to persisted evidence, then test both locators.
    const p65 = evidence.rows.filter(row => row.literal_quote === knownP65.quote);
    const tableCell = atPath({ table: 2, row: 28, column: 3 });
    assert.equal(p4.length, 1, 'paragraph 4 must have exactly one persisted evidence record');
    assert.equal(p65.length, 1, 'the registered paragraph-65 quote must have exactly one persisted evidence record');
    assert.equal(tableCell.length, 1, 'table 2 row 28 cell 3 must have exactly one persisted evidence record');
    assert.equal(p4[0]!.literal_quote, knownP4.quote);
    assert.equal(tableCell[0]!.literal_quote, knownP249.quote);
    const checked = spawnSync(pythonExecutable, ['-c', OOXML_CHECK], {
      cwd: sourceRoot, encoding: 'utf8', maxBuffer: 16 * 1024,
      input: JSON.stringify({ path: join(manifestRoot, file.path), anchors: [p4[0]!, p65[0]!, tableCell[0]!].map(row => ({
        path: row.locator.path, quote: row.literal_quote,
        source_xpath: row.literal_quote === knownP65.quote ? knownP65.locator : row.literal_quote === knownP249.quote ? knownP249.locator : knownP4.locator,
      })) }),
    });
    assert.equal(checked.status, 0, 'independent OOXML source check must complete');
    assert.deepEqual(JSON.parse(checked.stdout), {
      quote_found_at_parser_locators: [true, true, true], quote_found_at_manifest_xpaths: [true, true, true],
    }, 'persisted quotes must resolve at parser locators and registered original OOXML xpaths');

    activeOwner = foreignOwner;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}`)).statusCode, 404, 'foreign account cannot read the project');
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`)).statusCode, 404,
      'foreign account cannot read the parse job');
    activeOwner = owner;
    const visibleJob = await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`);
    assert.equal(visibleJob.statusCode, 200);
    assert.equal(visibleJob.json().parser_version, documentParserVersion());
    assert.equal(visibleJob.json().material_id, materialId);
  } finally {
    activeOwner = owner;
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection).getContainerClient(container).deleteIfExists();
  }
});
