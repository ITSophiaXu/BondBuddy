import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { runParseSnapshotAudit } from './parse-snapshot-audit.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('PARSE_SNAPSHOT_AUDIT_TEST_DATABASE_URL');
const DOCX_MEDIA = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PARSER_VERSION = 'parse-audit-synthetic-parser-1';

type SyntheticMaterial = {
  id: string;
  version: number;
  uploadId: string;
  sha256: string;
  mediaType: string;
  jobId: string;
  snapshotId: string;
  requestId: string;
  status: 'parsed' | 'needs_confirmation';
  rows: Array<{
    recordId: string;
    locatorType: string;
    locator: Record<string, unknown>;
    quote: string;
    uncertainty: string[];
    formatting: Record<string, unknown>;
  }>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('PostgreSQL 16 audits synthetic parse jobs through the read-only query path', {
  skip: !testDatabaseUrl && 'set PARSE_SNAPSHOT_AUDIT_TEST_DATABASE_URL (or BB_TEST_DATABASE_URL) to a migrated PostgreSQL 16 template',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID();
  const owner = `parse-audit-synthetic-owner-${suffix}`;
  const project = `parse-audit-synthetic-project-${suffix}`;
  const sourceBytes = 'Synthetic DOCX bytes shared by distinct material bindings';
  const sourceSha = sha256(sourceBytes);
  const xlsxSha = sha256('Synthetic XLSX bytes');
  const privateQuote = `Synthetic audit private marker ${suffix}`;
  const privateContext = `Synthetic audit private context ${suffix}`;
  const privateFormulaValue = `Synthetic cached formula ${suffix}`;
  const objectPrefix = `users/${owner}/projects/${project}`;

  const docxRows = [
    { locator: { path: [{ paragraph: 4 }], stable_ref: 'synthetic:p4' }, quote: `${privateQuote} paragraph four` },
    { locator: { path: [{ paragraph: 65 }], stable_ref: 'synthetic:p65' }, quote: `${privateQuote} paragraph sixty-five` },
    { locator: { path: [{ paragraph: 249 }, { table: 2, row: 28, column: 3 }], stable_ref: 'synthetic:cell' }, quote: `${privateQuote} table cell` },
  ];

  const makeMaterial = (name: string, mediaType: string, sourceHash: string, status: SyntheticMaterial['status'], rows: SyntheticMaterial['rows']): SyntheticMaterial => ({
    id: `parse-audit-material-${name}-${suffix}`,
    version: 1,
    uploadId: `parse-audit-upload-${name}-${suffix}`,
    sha256: sourceHash,
    mediaType,
    jobId: `parse-audit-job-${name}-${suffix}`,
    snapshotId: `parse-audit-snapshot-${name}-${suffix}`,
    requestId: `parse-audit-request-${name}-${suffix}`,
    status,
    rows,
  });

  const copiedDocxRows = () => docxRows.map((row, index) => ({
    recordId: `synthetic-record-${index + 1}`,
    locatorType: 'docx_block',
    locator: row.locator,
    quote: row.quote,
    uncertainty: [],
    formatting: {},
  }));
  const docxA = makeMaterial('docx-a', DOCX_MEDIA, sourceSha, 'parsed', copiedDocxRows());
  const docxB = makeMaterial('docx-b', DOCX_MEDIA, sourceSha, 'parsed', copiedDocxRows());
  const anchor = makeMaterial('anchor', DOCX_MEDIA, sourceSha, 'parsed', copiedDocxRows());
  // A valid successful parse job whose source differs, used to verify fail-closed anchor handling.
  const wrongAnchor = makeMaterial('wrong-anchor', DOCX_MEDIA, sha256('Different synthetic DOCX source'), 'parsed', copiedDocxRows());
  const xlsx = makeMaterial('xlsx', XLSX_MEDIA, xlsxSha, 'needs_confirmation', [{
    recordId: 'synthetic-xlsx-record-1', locatorType: 'xlsx_cell', locator: { sheet: 'Synthetic', cell: 'A1' },
    quote: privateQuote, uncertainty: ['formula_cached_result_unverified'], formatting: { cached_formula_result: privateFormulaValue },
  }]);
  const materials = [docxA, docxB, anchor, wrongAnchor, xlsx];

  const makeTargets = (anchorJobId: string) => JSON.stringify({
    docx_a_job_id: docxA.jobId,
    docx_b_job_id: docxB.jobId,
    anchor_docx_job_id: anchorJobId,
    xlsx_job_id: xlsx.jobId,
  });

  try {
    await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)',
      [project, owner, `Synthetic parse audit ${suffix}`, 'update']);

    for (const material of materials) {
      const byteSize = material.mediaType === XLSX_MEDIA ? 20 : sourceBytes.length;
      const objectKey = `${objectPrefix}/${material.id}/v${material.version}`;
      await pool.query(`INSERT INTO bb_uploads
        (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'audit',$8,now()+interval '1 hour','completed')`,
      [material.uploadId, owner, project, `synthetic-${material.id}.${material.mediaType === XLSX_MEDIA ? 'xlsx' : 'docx'}`,
        material.mediaType, byteSize, material.sha256, `${objectKey}/upload`]);
      await pool.query(`INSERT INTO bb_material_versions
        (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,$2,$3,$4,$5,'audit',$6,$7,$8,$9,$10,'parsed')`,
      [material.id, material.version, owner, project, material.uploadId, `synthetic-${material.id}`, material.mediaType,
        byteSize, material.sha256, objectKey]);

      const responseMeta = {
        schema_version: 'document-parse-response-v1', request_id: material.requestId, parser_version: PARSER_VERSION,
        status: material.status,
        material: { material_id: material.id, material_version: material.version, media_type: material.mediaType, sha256: material.sha256 },
        warnings: material.mediaType === XLSX_MEDIA ? [{ code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'synthetic test warning' }] : [],
        document: material.mediaType === XLSX_MEDIA ? { page_count: null, cached_formula_results: 1 } : { page_count: null },
        error: null,
      };
      await pool.query(`INSERT INTO bb_parse_snapshots
        (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,
         response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,$9,'document-parse-response-v1',$10,$11,$12::jsonb)`,
      [material.snapshotId, owner, project, material.id, material.version, material.sha256, PARSER_VERSION,
        sha256(`request:${material.requestId}`), material.status, sha256(`response:${material.requestId}`), material.rows.length, JSON.stringify(responseMeta)]);

      for (const [ordinal, row] of material.rows.entries()) {
        await pool.query(`INSERT INTO bb_parse_evidence
          (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,
           literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'native_text',$12,NULL,$13::jsonb,$14::jsonb,$15,$16)`,
        [owner, project, material.id, material.version, material.snapshotId, row.recordId, material.sha256, row.locatorType,
          JSON.stringify(row.locator), row.quote, privateContext, PARSER_VERSION, JSON.stringify(row.uncertainty),
          JSON.stringify(row.formatting), sha256(`record:${material.requestId}:${ordinal}`), ordinal]);
      }

      await pool.query(`INSERT INTO bb_jobs
        (id,owner_user_id,run_id,job_type,subtype,state,project_id,material_id,material_version,material_sha256,
         parser_version,trace_id,max_attempts,result)
        VALUES($1,$2,NULL,'parse','material_parse','succeeded',$3,$4,$5,$6,$7,$8,3,'{}'::jsonb)`,
      [material.jobId, owner, project, material.id, material.version, material.sha256, PARSER_VERSION, `synthetic-trace-${material.jobId}`]);
    }

    const before = await pool.query(`SELECT
      (SELECT count(*)::int FROM bb_projects WHERE id=$1 AND owner_user_id=$2) AS projects,
      (SELECT count(*)::int FROM bb_uploads WHERE owner_user_id=$2 AND project_id=$1) AS uploads,
      (SELECT count(*)::int FROM bb_material_versions WHERE owner_user_id=$2 AND project_id=$1) AS materials,
      (SELECT count(*)::int FROM bb_jobs WHERE owner_user_id=$2 AND project_id=$1 AND job_type='parse') AS jobs,
      (SELECT count(*)::int FROM bb_parse_snapshots WHERE owner_user_id=$2 AND project_id=$1) AS snapshots,
      (SELECT count(*)::int FROM bb_parse_evidence WHERE owner_user_id=$2 AND project_id=$1) AS evidence`, [project, owner]);

    const report = await runParseSnapshotAudit(testDatabaseUrl, makeTargets(anchor.jobId));
    assert.equal(report.database_access, 'read_only_transaction');
    assert.equal(report.audit_status, 'reported_not_source_verified');
    const docxReport = report.docx_jobs as { a: Record<string, unknown>; b: Record<string, unknown>; comparison: Record<string, unknown> };
    assert.equal(docxReport.comparison.status, 'comparable');
    assert.equal(docxReport.comparison.ordered_content_hashes_equal, true);
    assert.notEqual(docxReport.a.ordered_records_sha256, docxReport.b.ordered_records_sha256,
      'full-record digest retains the distinct material binding');
    assert.equal(docxReport.a.ordered_content_sha256, docxReport.b.ordered_content_sha256,
      'normalized content digest compares equivalent source content across material bindings');
    const anchorMetric = report.rq_202506_01_anchor_locator_presence as {
      source_quote_independent_check: string;
      locators: Record<string, { count: number; unique: boolean }>;
    };
    assert.equal(anchorMetric.source_quote_independent_check, 'not_performed');
    assert.deepEqual(anchorMetric.locators.p4, { count: 1, unique: true });
    assert.deepEqual(anchorMetric.locators.p65, { count: 1, unique: true });
    assert.deepEqual(anchorMetric.locators.p249_table2_row28_cell3, { count: 1, unique: true });
    const xlsxMetric = report.xlsx as Record<string, unknown>;
    assert.equal(xlsxMetric.cached_formula_results_unverified_count, 1);
    assert.equal(xlsxMetric.cached_formula_result_record_count, 1);
    assert.equal(xlsxMetric.cached_formula_unverified_status, 'consistent_needs_confirmation');

    const wrongBindingReport = await runParseSnapshotAudit(testDatabaseUrl, makeTargets(wrongAnchor.jobId));
    assert.equal(wrongBindingReport.audit_status, 'failed_anchor_binding');
    assert.equal(wrongBindingReport.anchor_source_binding_status, 'mismatch');
    assert.deepEqual(wrongBindingReport.rq_202506_01_anchor_locator_presence, {
      source_quote_independent_check: 'not_performed', locator_check: 'skipped_source_binding_mismatch',
    }, 'wrong source binding must suppress anchor locator claims');

    for (const reportValue of [JSON.stringify(report), JSON.stringify(wrongBindingReport)]) {
      for (const privateValue of [owner, project, ...materials.flatMap((item) => [item.id, item.jobId, item.snapshotId]),
        privateQuote, privateContext, privateFormulaValue, objectPrefix]) {
        assert.equal(reportValue.includes(privateValue), false, `audit output must not disclose ${privateValue}`);
      }
    }

    const after = await pool.query(`SELECT
      (SELECT count(*)::int FROM bb_projects WHERE id=$1 AND owner_user_id=$2) AS projects,
      (SELECT count(*)::int FROM bb_uploads WHERE owner_user_id=$2 AND project_id=$1) AS uploads,
      (SELECT count(*)::int FROM bb_material_versions WHERE owner_user_id=$2 AND project_id=$1) AS materials,
      (SELECT count(*)::int FROM bb_jobs WHERE owner_user_id=$2 AND project_id=$1 AND job_type='parse') AS jobs,
      (SELECT count(*)::int FROM bb_parse_snapshots WHERE owner_user_id=$2 AND project_id=$1) AS snapshots,
      (SELECT count(*)::int FROM bb_parse_evidence WHERE owner_user_id=$2 AND project_id=$1) AS evidence`, [project, owner]);
    assert.deepEqual(after.rows[0], before.rows[0], 'audit execution must leave all fixture tables unchanged');
  } finally {
    await pool.end();
  }
});
