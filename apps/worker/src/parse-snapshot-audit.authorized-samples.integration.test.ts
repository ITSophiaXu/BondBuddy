import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';
import { documentParserVersion, enqueueMaterialParse } from '@bondbuddy/api/material-jobs';
import { runDocumentParser } from './document-parser.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { runParseSnapshotAudit } from './parse-snapshot-audit.js';
import { isolatedTestDatabase } from './test-database.js';

type ManifestFile = {
  file_id: string;
  path: string;
  upload_role: string;
  media_type: string;
  sha256: string;
  bytes: number;
};
type ManifestCase = { case_id: string; files: ManifestFile[] };
type Manifest = { cases: ManifestCase[] };

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestRoot = join(sourceRoot, 'tests/samples/2026-09-25');
const localPython = join(
  sourceRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const pythonExecutable =
  process.env.BB_PYTHON?.trim() ||
  (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const optedIn = process.env.BB_RUN_AUTHORIZED_PARSE_SNAPSHOT_AUDIT === '1';
const testDatabaseUrl = optedIn
  ? await isolatedTestDatabase('AUTHORIZED_PARSE_SNAPSHOT_AUDIT_TEST_DATABASE_URL')
  : undefined;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function registeredFile(sample: ManifestCase, role: string): ManifestFile {
  const file = sample.files.find((entry) => entry.upload_role === role);
  assert.ok(file, `${sample.case_id}: manifest must register ${role}`);
  return file;
}

async function verifiedBytes(file: ManifestFile): Promise<Buffer> {
  const bytes = await readFile(join(manifestRoot, file.path));
  assert.equal(
    bytes.byteLength,
    file.bytes,
    `${file.path}: size must match the authorized manifest`,
  );
  assert.equal(
    sha256(bytes),
    file.sha256,
    `${file.path}: SHA-256 must match the authorized manifest`,
  );
  return bytes;
}

test(
  'authorized rq-202506 DOCX and rq-202509 XLSX durable parse snapshots pass the read-only PostgreSQL audit',
  {
    skip: !optedIn
      ? 'set BB_RUN_AUTHORIZED_PARSE_SNAPSHOT_AUDIT=1 to run authorized sample parsing against PostgreSQL 16'
      : !testDatabaseUrl
        ? 'set AUTHORIZED_PARSE_SNAPSHOT_AUDIT_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
        : false,
  },
  async () => {
    assert.ok(testDatabaseUrl);
    const manifest = JSON.parse(
      await readFile(join(manifestRoot, 'manifest.json'), 'utf8'),
    ) as Manifest;
    const docxCase = manifest.cases.find((entry) => entry.case_id === 'rq-202506');
    const xlsxCase = manifest.cases.find((entry) => entry.case_id === 'rq-202509');
    assert.ok(docxCase, 'rq-202506 must be registered');
    assert.ok(xlsxCase, 'rq-202509 must be registered');
    const docxFile = registeredFile(docxCase, 'historical');
    const xlsxFile = registeredFile(xlsxCase, 'interimFinancial');
    assert.deepEqual(
      [docxFile.file_id, docxFile.bytes, docxFile.sha256],
      ['rq-202506-01', 925141, 'd19e8dca15ed3bc6c1288523263a951eb682ee488363f027d37c951957f2a182'],
    );
    assert.deepEqual(
      [xlsxFile.file_id, xlsxFile.bytes, xlsxFile.sha256],
      ['rq-202509-02', 424900, 'c11db9a211c7e8c21efc5aab6a8e503b3817aa78f3d184cfe5d077b0a32826c2'],
    );
    assert.equal(docxFile.media_type, DOCX);
    assert.equal(xlsxFile.media_type, XLSX);
    const [docxBytes, xlsxBytes] = await Promise.all([
      verifiedBytes(docxFile),
      verifiedBytes(xlsxFile),
    ]);

    const pool = new Pool({ connectionString: testDatabaseUrl });
    const suffix = randomUUID();
    const owner = `authorized-audit-owner-${suffix}`;
    const blobBytes = new Map<string, Buffer>();
    const parser = (request: Parameters<typeof runDocumentParser>[0]) =>
      runDocumentParser(request, {
        pythonExecutable,
        repoRoot: sourceRoot,
      });

    async function uploadAndParse(input: {
      caseId: string;
      file: ManifestFile;
      bytes: Buffer;
      role: string;
      label: string;
    }) {
      const projectId = randomUUID();
      const materialId = randomUUID();
      const uploadId = randomUUID();
      const objectKey = `authorized-parse-audit/${suffix}/${input.label}/${materialId}/v1`;
      blobBytes.set(objectKey, input.bytes);

      const client = await pool.connect();
      let jobId = '';
      try {
        await client.query('BEGIN');
        await client.query(
          "INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,'update')",
          [projectId, owner, `Authorized parse audit ${input.caseId} ${input.label}`],
        );
        await client.query(
          `INSERT INTO bb_uploads
        (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 day','completed',$7,$6)`,
          [
            uploadId,
            owner,
            projectId,
            input.file.path.split('/').at(-1),
            input.file.media_type,
            input.file.bytes,
            input.file.sha256,
            input.role,
            `${objectKey}/upload`,
          ],
        );
        await client.query(
          `INSERT INTO bb_material_versions
        (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted')`,
          [
            materialId,
            owner,
            projectId,
            uploadId,
            input.role,
            input.file.path.split('/').at(-1),
            input.file.media_type,
            input.file.bytes,
            input.file.sha256,
            objectKey,
          ],
        );
        const queued = await enqueueMaterialParse(client, {
          owner,
          projectId,
          materialId,
          materialVersion: 1,
          sha256: input.file.sha256,
          traceId: `authorized-parse-audit-${suffix}-${input.label}`,
          parserVersion: documentParserVersion(),
        });
        assert.equal(
          queued.created,
          true,
          `${input.label}: each separate material scope must enqueue its own job`,
        );
        jobId = queued.jobId;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const outcome = await runMaterialParseOnce({
        pool,
        leaseSeconds: 300,
        material: {
          pool,
          blobs: { getPrivate: async (key) => blobBytes.get(key) ?? null },
          parser,
        },
      });
      const job = await pool.query(
        'SELECT state,error_code,stage,checkpoint,parser_version,material_sha256,material_id FROM bb_jobs WHERE id=$1 AND owner_user_id=$2',
        [jobId, owner],
      );
      assert.equal(job.rows.length, 1);
      const errors = await pool.query(
        'SELECT code FROM bb_observability_errors WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1',
        [jobId],
      );
      assert.equal(
        outcome,
        'succeeded',
        `${input.label}: durable parse returned ${outcome}, job ended ${job.rows[0]!.state}/${job.rows[0]!.stage} (${job.rows[0]!.error_code ?? errors.rows[0]?.code ?? 'no_error_code'})`,
      );
      assert.equal(job.rows[0]!.state, 'succeeded');
      assert.equal(job.rows[0]!.parser_version, documentParserVersion());
      assert.equal(job.rows[0]!.material_sha256.trim(), input.file.sha256);
      return { jobId, projectId, materialId, uploadId };
    }

    try {
      const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
      assert.ok(
        Number(version.rows[0]!.server_version_num) >= 160000 &&
          Number(version.rows[0]!.server_version_num) < 170000,
        'this integration regression requires PostgreSQL 16',
      );
      const ownerName = `u${suffix.replaceAll('-', '').slice(0, 30)}`;
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, ownerName]);

      // Identical authorized bytes are uploaded into distinct project/material bindings. This
      // exercises legitimate per-material dedupe while producing two immutable parse jobs.
      const docxA = await uploadAndParse({
        caseId: 'rq-202506',
        file: docxFile,
        bytes: docxBytes,
        role: 'historical',
        label: 'docx-a',
      });
      const docxB = await uploadAndParse({
        caseId: 'rq-202506',
        file: docxFile,
        bytes: docxBytes,
        role: 'historical',
        label: 'docx-b',
      });
      const xlsx = await uploadAndParse({
        caseId: 'rq-202509',
        file: xlsxFile,
        bytes: xlsxBytes,
        role: 'interimFinancial',
        label: 'xlsx',
      });
      assert.notEqual(docxA.jobId, docxB.jobId);
      assert.notEqual(docxA.projectId, docxB.projectId);
      assert.notEqual(docxA.materialId, docxB.materialId);
      const bindings = await pool.query(
        `SELECT count(*)::int AS jobs,
      count(DISTINCT project_id)::int AS projects,count(DISTINCT material_id)::int AS materials,
      count(DISTINCT material_sha256)::int AS source_hashes,count(DISTINCT parser_version)::int AS parser_versions,
      min(material_sha256) AS source_sha,min(parser_version) AS parser_version
      FROM bb_jobs WHERE id=ANY($1::text[]) AND owner_user_id=$2 AND job_type='parse'`,
        [[docxA.jobId, docxB.jobId], owner],
      );
      assert.deepEqual(bindings.rows[0], {
        jobs: 2,
        projects: 2,
        materials: 2,
        source_hashes: 1,
        parser_versions: 1,
        source_sha: docxFile.sha256,
        parser_version: documentParserVersion(),
      });
      await assert.rejects(
        pool.query('UPDATE bb_jobs SET material_sha256=$2 WHERE id=$1', [
          docxA.jobId,
          'f'.repeat(64),
        ]),
        /immutable/,
        'durable source/parser job identity must be immutable',
      );

      const targets = JSON.stringify({
        docx_a_job_id: docxA.jobId,
        docx_b_job_id: docxB.jobId,
        anchor_docx_job_id: docxA.jobId,
        xlsx_job_id: xlsx.jobId,
      });
      const projectIds = [docxA.projectId, docxB.projectId, xlsx.projectId];
      const counts = async () =>
        (
          await pool.query(
            `SELECT
      (SELECT count(*)::int FROM bb_projects WHERE id=ANY($1::text[])) AS projects,
      (SELECT count(*)::int FROM bb_uploads WHERE project_id=ANY($1::text[])) AS uploads,
      (SELECT count(*)::int FROM bb_material_versions WHERE project_id=ANY($1::text[])) AS materials,
      (SELECT count(*)::int FROM bb_jobs WHERE project_id=ANY($1::text[]) AND job_type='parse') AS jobs,
      (SELECT count(*)::int FROM bb_parse_snapshots WHERE project_id=ANY($1::text[])) AS snapshots,
      (SELECT count(*)::int FROM bb_parse_evidence WHERE project_id=ANY($1::text[])) AS evidence`,
            [projectIds],
          )
        ).rows[0];
      const before = await counts();

      const report = await runParseSnapshotAudit(testDatabaseUrl, targets);
      assert.equal(report.database_access, 'read_only_transaction');
      assert.equal(report.audit_status, 'reported_not_source_verified');
      const docxReport = report.docx_jobs as {
        a: { record_count: number; parser_version: string; ordered_content_sha256: string };
        b: { record_count: number; parser_version: string; ordered_content_sha256: string };
        comparison: { status: string; ordered_content_hashes_equal?: boolean };
      };
      assert.equal(docxReport.a.record_count, 9970);
      assert.equal(docxReport.b.record_count, 9970);
      assert.equal(docxReport.a.parser_version, documentParserVersion());
      assert.equal(docxReport.b.parser_version, documentParserVersion());
      assert.equal(docxReport.comparison.status, 'comparable');
      assert.equal(docxReport.comparison.ordered_content_hashes_equal, true);
      assert.equal(docxReport.a.ordered_content_sha256, docxReport.b.ordered_content_sha256);
      const anchors = report.rq_202506_01_anchor_locator_presence as {
        source_quote_independent_check: string;
        locators: Record<string, { count: number; unique: boolean }>;
      };
      assert.equal(anchors.source_quote_independent_check, 'not_performed');
      assert.deepEqual(anchors.locators.p4, { count: 1, unique: true });
      assert.deepEqual(anchors.locators.p65, { count: 1, unique: true });
      assert.deepEqual(anchors.locators.p249_table2_row28_cell3, { count: 1, unique: true });
      const xlsxMetric = report.xlsx as {
        record_count: number;
        cached_formula_results_unverified_count: number;
        cached_formula_result_record_count: number;
        cached_formula_unverified_status: string;
        parse_status: string;
      };
      assert.equal(xlsxMetric.record_count, 22014);
      assert.equal(xlsxMetric.cached_formula_results_unverified_count, 3821);
      assert.equal(xlsxMetric.cached_formula_result_record_count, 3821);
      assert.equal(xlsxMetric.cached_formula_unverified_status, 'consistent_needs_confirmation');
      assert.equal(xlsxMetric.parse_status, 'needs_confirmation');

      const serialized = JSON.stringify(report);
      const privateRows = await pool.query(
        `SELECT j.id AS job_id,s.id AS snapshot_id,e.record_id,e.literal_quote
      FROM bb_jobs j JOIN bb_parse_snapshots s ON s.owner_user_id=j.owner_user_id AND s.project_id=j.project_id
        AND s.material_id=j.material_id AND s.material_version=j.material_version AND s.parser_version=j.parser_version
      JOIN bb_parse_evidence e ON e.snapshot_id=s.id
      WHERE j.id=ANY($1::text[]) ORDER BY e.ordinal LIMIT 3`,
        [[docxA.jobId, docxB.jobId, xlsx.jobId]],
      );
      const privateIds = [
        owner,
        ...projectIds,
        docxA.materialId,
        docxB.materialId,
        xlsx.materialId,
        docxA.uploadId,
        docxB.uploadId,
        xlsx.uploadId,
        docxA.jobId,
        docxB.jobId,
        xlsx.jobId,
        ...privateRows.rows.flatMap((row) => [
          String(row.job_id),
          String(row.snapshot_id),
          String(row.record_id),
        ]),
      ];
      for (const privateId of privateIds)
        assert.equal(
          serialized.includes(privateId),
          false,
          'audit output must not expose scoped IDs',
        );
      for (const row of privateRows.rows) {
        assert.ok(String(row.literal_quote).length > 0);
        assert.equal(
          serialized.includes(String(row.literal_quote)),
          false,
          'audit output must not expose source text',
        );
      }
      assert.deepEqual(
        await counts(),
        before,
        'the read-only audit must not change persisted row counts',
      );
    } finally {
      blobBytes.clear();
      await pool.end();
    }
  },
);
