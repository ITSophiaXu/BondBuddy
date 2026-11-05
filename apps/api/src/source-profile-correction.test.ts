import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { azureBlobs, digest, uid, type PrivateBlobs } from './data.js';
import { createServer } from './server.js';
import { PDF, pdfSample, pngSample } from './upload-safety.samples.js';
import { readOcr, storeOcr } from './ocr.js';

// Retained PDFs remain editable; they cannot be created through the new Word-only upload route.
async function savedLegacyPdf(pool:Pool,blobs:PrivateBlobs,owner:string,project:string,filename:string,bytes:Buffer){
  const id=uid(),key=`users/${owner}/projects/${project}/uploads/${id}`,sha=digest(bytes);
  await blobs.put(key,bytes,PDF);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,'historical',$8,now(),'completed')`,[id,owner,project,filename,PDF,bytes.length,sha,key]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$1,'historical',$4,$5,$6,$7,$8,'persisted')`,[id,owner,project,filename,PDF,bytes.length,sha,key]);
  return id;
}

const origin = 'http://bondbuddy.test';
const connection = process.env.BB_TEST_DATABASE_URL;
const isolatedConnection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;

test('source-profile PATCH appends an owner-scoped asserted profile with verified anchors and atomic audit/outbox',
  { skip: !connection || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: isolatedConnection });
    let active = 'synthetic-profile-owner';
    const blobs=azureBlobs(blobConnection!);
    const app = createServer({ pool, blobs, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin });
    const send = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
      app.inject({ method: method as never, url, headers: { origin, ...extra }, payload: payload as never });
    try {
      const created = await send('POST', '/api/v1/projects', { name: 'Synthetic source profile', kind: 'update', issuer_name: null, market: 'sse', offering: 'private' });
      assert.equal(created.statusCode, 201, created.body);
      const project = created.json().project_id as string;

      const bytes = pdfSample({ tag: 'source-profile-correction' });
      const materialId = await savedLegacyPdf(pool,blobs,active,project,'synthetic-historical.pdf',bytes);

      const profile = {
        material_id: materialId, material_version: 1, profile_version: 1, state: 'needs_confirmation',
        source_market: { value: 'sse', raw_value: '上交所', provenance: { material_id: materialId, material_version: 1,
          method: 'native_text', extractor_version: 'historical-native-recognition-v3/parser-synthetic-1', evidence_refs: ['anchor-market'] }, uncertainty: [], status: 'recognized' },
        source_offering: { value: 'private', raw_value: '私募', provenance: { material_id: materialId, material_version: 1,
          method: 'native_text', extractor_version: 'historical-native-recognition-v3/parser-synthetic-1', evidence_refs: ['anchor-offering'] }, uncertainty: [], status: 'recognized' },
        reporting_periods: [{ start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', raw_value: '2024 年度',
          provenance: { material_id: materialId, material_version: 1, method: 'native_text', extractor_version: 'historical-native-recognition-v3/parser-synthetic-1', evidence_refs: ['anchor-period'] }, uncertainty: [], status: 'recognized' }],
        latest_reporting_cutoff: { value: '2024-12-31', raw_value: '2024 年度', provenance: { material_id: materialId, material_version: 1,
          method: 'native_text', extractor_version: 'historical-native-recognition-v3/parser-synthetic-1', evidence_refs: ['anchor-period'] }, uncertainty: [], status: 'recognized' },
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

test('source-profile correction accepts OCR identities and fails closed on invalid or mixed extractor identities',
  { skip: !connection || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: isolatedConnection });
    const blobs = azureBlobs(blobConnection!);
    const owner = 'synthetic-profile-identities-owner';
    const origin = 'http://bondbuddy.identity.test';
    const app = createServer({ pool, blobs, principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: origin });
    const send = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
      app.inject({ method: method as never, url, headers: { origin, ...extra }, payload: payload as never });

    const insertProfile = async (projectId: string, materialId: string, versions: string[]) => {
      const field = (extractorVersion: string) => ({ value: null, raw_value: null,
        provenance: { material_id: materialId, material_version: 1, method: 'native_text', extractor_version: extractorVersion, evidence_refs: [] },
        uncertainty: ['synthetic identity test'], status: 'needs_confirmation' });
      const recognition = { material_id: materialId, material_version: 1, profile_version: 1, state: 'needs_confirmation',
        source_market: field(versions[0]!), source_offering: field(versions[1] ?? versions[0]!), reporting_periods: [],
        latest_reporting_cutoff: field(versions[2] ?? versions[0]!) };
      await pool.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
        VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,
      [owner, projectId, materialId, `identity-${materialId}`, 'a'.repeat(64), JSON.stringify(recognition)]);
    };

    try {
      const created = await send('POST', '/api/v1/projects', { name: 'Synthetic identity checks', kind: 'update', issuer_name: null, market: 'sse', offering: 'private' });
      assert.equal(created.statusCode, 201, created.body);
      const projectId = created.json().project_id as string;
      const base = `/api/v1/projects/${projectId}/materials`;
      const uploadHistoricalPdf = (filename:string) => savedLegacyPdf(pool,blobs,owner,projectId,filename,pdfSample({tag:filename}));
      const correct = async (materialId: string) => send('PATCH', `${base}/${materialId}/source-profile`,
        { profile_version: 1, source_market: 'szse', reason: 'synthetic identity test', evidence_refs: [] }, { 'if-match': '1' });

      const ocrMaterialId = await uploadHistoricalPdf('synthetic-ocr-identity.pdf');
      const ocrMaterial = await pool.query('SELECT sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1', [owner, projectId, ocrMaterialId]);
      const png = pngSample;
      const pngHash = digest(png);
      const requestId = 'synthetic-ocr-source-preflight';
      const raw = { schema_version: 'ocr-response-v1', request_id: requestId, processor_version: 'synthetic-ocr-v1', engine_version: 'synthetic-only',
        language: 'eng', language_data_sha256: { eng: 'a'.repeat(64) }, purpose: 'source_preflight', status: 'needs_confirmation',
        material: { material_id: ocrMaterialId, material_version: 1, media_type: PDF, sha256: ocrMaterial.rows[0].sha256.trim() }, page_count: 1, coverage: 'complete',
        pages: [{ page: 1, width: png.readUInt32BE(16), height: png.readUInt32BE(20), rotation_clockwise: 0, coordinate_system: 'rendered_pixels_top_left', image_sha256: pngHash,
          image_base64: png.toString('base64'), warnings: ['synthetic_only'] }],
        records: [{ record_id: 'ocr-anchor', page: 1, bbox: [0, 0, 1, 1], text: 'synthetic OCR text', confidence: 0.4,
          numeric: { kind: 'unparsed', decimal: null, unit: null }, cell: null, uncertainty: ['synthetic_only'], eligible_for_manuscript: false }], warnings: ['synthetic_only'], error: null, eligible_for_manuscript: false };
      const snapshotId = await storeOcr(pool, blobs, { owner, projectId, materialId: ocrMaterialId, version: 1, requestId, purpose: 'source_preflight' }, raw);
      const review = await readOcr(pool, blobs, owner, projectId, ocrMaterialId);
      const ocrVersion = `historical-ocr-recognition-v2:${snapshotId}:${review.result_sha256}`;
      const ocrField = (value: string | null) => ({ value, raw_value: null,
        provenance: { material_id: ocrMaterialId, material_version: 1, method: 'ocr', extractor_version: ocrVersion, evidence_refs: [] },
        uncertainty: ['synthetic OCR identity test'], status: 'needs_confirmation' });
      const ocrRecognition = { material_id: ocrMaterialId, material_version: 1, profile_version: 1, state: 'needs_confirmation',
        source_market: ocrField(null), source_offering: ocrField(null), reporting_periods: [], latest_reporting_cutoff: ocrField(null) };
      await pool.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
        VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,
      [owner, projectId, ocrMaterialId, 'ocr-recognition', 'b'.repeat(64), JSON.stringify(ocrRecognition)]);
      assert.ok(ocrVersion.startsWith(`historical-ocr-recognition-v2:${snapshotId}:`));
      const ocrCorrection = await correct(ocrMaterialId);
      assert.equal(ocrCorrection.statusCode, 200, ocrCorrection.body);

      const nativeInvalid = await uploadHistoricalPdf('synthetic-invalid-native.pdf');
      await insertProfile(projectId, nativeInvalid, ['historical-native-recognition-v4/parser-synthetic-1']);
      assert.equal((await correct(nativeInvalid)).statusCode, 503, 'unsupported native algorithm version is unavailable');

      const nativeMixed = await uploadHistoricalPdf('synthetic-mixed-native.pdf');
      await insertProfile(projectId, nativeMixed, ['historical-native-recognition-v3/parser-synthetic-1', 'historical-native-recognition-v2/parser-synthetic-1']);
      assert.equal((await correct(nativeMixed)).statusCode, 503, 'mixed native algorithm identities are unavailable');

      const ocrInvalid = await uploadHistoricalPdf('synthetic-invalid-ocr.pdf');
      await insertProfile(projectId, ocrInvalid, [`historical-ocr-recognition-v3:snapshot:${'c'.repeat(64)}`]);
      assert.equal((await correct(ocrInvalid)).statusCode, 503, 'unsupported OCR identity is unavailable');

      const ocrMixed = await uploadHistoricalPdf('synthetic-mixed-ocr.pdf');
      await insertProfile(projectId, ocrMixed, [
        `historical-ocr-recognition-v2:snapshot-a:${'d'.repeat(64)}`,
        `historical-ocr-recognition-v2:snapshot-b:${'e'.repeat(64)}`,
      ]);
      assert.equal((await correct(ocrMixed)).statusCode, 409, 'mixed OCR snapshots are rejected as stale profile input');
    } finally {
      await app.close();
      await pool.end();
    }
  });
