import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, digest } from './data.js';
import { createServer } from './server.js';
import { PDF, pdfSample } from './upload-safety.samples.js';

const origin = 'http://bondbuddy.test';
const connection = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;

test('source-profile PATCH appends an owner-scoped asserted profile with verified anchors and atomic audit/outbox',
  { skip: !connection || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    let active = 'synthetic-profile-owner';
    const app = createServer({ pool, blobs: azureBlobs(blobConnection!), principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin });
    const send = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
      app.inject({ method: method as never, url, headers: { origin, ...extra }, payload: payload as never });
    try {
      await pool.query('TRUNCATE bb_project_events,bb_artifact_download_grants,bb_outbox,bb_run_events,bb_artifact_versions,bb_word_delivery_evidence,bb_runs,bb_material_versions,bb_uploads,bb_input_revisions,bb_projects RESTART IDENTITY CASCADE');
      const created = await send('POST', '/api/v1/projects', { name: 'Synthetic source profile', kind: 'update', issuer_name: null, market: 'sse', offering: 'private' });
      assert.equal(created.statusCode, 201, created.body);
      const project = created.json().project_id as string;

      const bytes = pdfSample({ tag: 'source-profile-correction' });
      const sha = digest(bytes);
      const upload = await send('POST', `/api/v1/projects/${project}/materials/uploads`, {
        filename: 'synthetic-historical.pdf', media_type: PDF, byte_size: bytes.length, sha256: sha, role: 'historical',
      });
      assert.equal(upload.statusCode, 201, upload.body);
      assert.equal((await send('PUT', upload.json().upload_url, bytes, { 'content-type': 'application/octet-stream' })).statusCode, 204);
      const saved = await send('POST', `/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`, {
        byte_size: bytes.length, sha256: sha,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const materialId = saved.json().material_id as string;

      const profile = {
        material_id: materialId, material_version: 1, profile_version: 1, state: 'needs_confirmation',
        source_market: { value: 'sse', raw_value: '上交所', provenance: { material_id: materialId, material_version: 1,
          method: 'native_text', extractor_version: 'historical-native-recognition-v2/parser-synthetic-1', evidence_refs: ['anchor-market'] }, uncertainty: [], status: 'recognized' },
        source_offering: { value: 'private', raw_value: '私募', provenance: { material_id: materialId, material_version: 1,
          method: 'native_text', extractor_version: 'historical-native-recognition-v2/parser-synthetic-1', evidence_refs: ['anchor-offering'] }, uncertainty: [], status: 'recognized' },
        reporting_periods: [{ start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', raw_value: '2024 年度',
          provenance: { material_id: materialId, material_version: 1, method: 'native_text', extractor_version: 'historical-native-recognition-v2/parser-synthetic-1', evidence_refs: ['anchor-period'] }, uncertainty: [], status: 'recognized' }],
        latest_reporting_cutoff: { value: '2024-12-31', raw_value: '2024 年度', provenance: { material_id: materialId, material_version: 1,
          method: 'native_text', extractor_version: 'historical-native-recognition-v2/parser-synthetic-1', evidence_refs: ['anchor-period'] }, uncertainty: [], status: 'recognized' },
      };
      const contentHash = (await pool.query('SELECT sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1', [active, project, materialId])).rows[0].sha256.trim();
      const snapshotId = 'synthetic-source-parse';
      const responseMeta = { schema_version: 'document-parse-response-v1', request_id: 'synthetic-source-parse-request', status: 'needs_confirmation', parser_version: 'parser-synthetic-1',
        material: { material_id: materialId, material_version: 1, sha256: contentHash }, warnings: [], document: {}, error: null };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta) VALUES($1,$2,$3,$4,1,$5,'parser-synthetic-1',$6,'needs_confirmation','document-parse-response-v1',$7,3,$8::jsonb)`,
        [snapshotId, active, project, materialId, contentHash, createHash('sha256').update('request').digest('hex'), createHash('sha256').update('response').digest('hex'), JSON.stringify(responseMeta)]);
      for (const [recordId, quote] of [['anchor-market', '上交所'], ['anchor-offering', '普通私募公司债'], ['anchor-period', '2024年度报告']] as const) {
        await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,
          literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox','{"page":1}', $7,'synthetic evidence','native_text','parser-synthetic-1',0.9,'[]','{}',$8,$9)`,
          [active, project, materialId, snapshotId, recordId, contentHash, quote, createHash('sha256').update(recordId).digest('hex'), ['anchor-market','anchor-offering','anchor-period'].indexOf(recordId)]);
      }
      await pool.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
        VALUES($1,$2,$3,1,1,'synthetic-profile-seed',$4,'recognition',$5::jsonb)`,
        [active, project, materialId, createHash('sha256').update('seed').digest('hex'), JSON.stringify(profile)]);

      const baseUrl = `/api/v1/projects/${project}/materials/${materialId}/source-profile`;
      const patch = { profile_version: 1, source_market: 'szse', reason: 'synthetic user correction', evidence_refs: ['anchor-market'] };
      const absentMatch = await send('PATCH', baseUrl, patch);
      assert.equal(absentMatch.statusCode, 422);
      const mismatchedMatch = await send('PATCH', baseUrl, { ...patch, profile_version: 2 }, { 'if-match': '1' });
      assert.equal(mismatchedMatch.statusCode, 409);
      active = 'synthetic-profile-foreign';
      const foreign = await send('PATCH', baseUrl, patch, { 'if-match': '1' });
      assert.equal(foreign.statusCode, 404);
      active = 'synthetic-profile-owner';
      const forged = await send('PATCH', baseUrl, { ...patch, evidence_refs: ['not-an-anchor'] }, { 'if-match': '1' });
      assert.equal(forged.statusCode, 422);

      const corrected = await send('PATCH', baseUrl, patch, { 'if-match': '1' });
      assert.equal(corrected.statusCode, 200, corrected.body);
      const dto = corrected.json();
      assert.equal(dto.profile_version, 2);
      assert.equal(dto.state, 'needs_confirmation');
      assert.equal(dto.source_market.status, 'user_asserted');
      assert.equal(dto.source_market.provenance.method, 'user_correction');
      assert.ok(dto.source_market.uncertainty.length > 0);
      const replayConflict = await send('PATCH', baseUrl, patch, { 'if-match': '1' });
      assert.equal(replayConflict.statusCode, 409);
      assert.equal(replayConflict.json().code, 'INPUT_REVISION_CONFLICT');

      const rows = await pool.query(`SELECT write_kind,actor_id,correction_reason,correction_evidence_refs,recognition
        FROM bb_historical_profiles WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 ORDER BY profile_version`, [active, project, materialId]);
      assert.equal(rows.rows.length, 2);
      assert.deepEqual(rows.rows[1].correction_evidence_refs, ['anchor-market']);
      assert.equal(rows.rows[1].actor_id, active);
      assert.equal(rows.rows[1].recognition.source_market.status, 'user_asserted');
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='historical_profile' AND aggregate_id=$1 AND event_type='historical_profile.updated'", [materialId])).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_operations WHERE operation_kind='source_profile_correction' AND status='submitted' AND owner_user_id=$1", [active])).rows[0].n, 1);
      assert.ok((await pool.query("SELECT count(*)::int n FROM bb_operations WHERE operation_kind='source_profile_correction' AND status='rejected' AND owner_user_id=$1", [active])).rows[0].n >= 1);
    } finally {
      await app.close();
      await pool.end();
    }
  });
