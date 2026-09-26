import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

type JsonObject = Record<string, unknown>;

export interface AuditEvidenceRow {
  record_id: string;
  locator_type: string;
  locator: unknown;
  literal_quote: string;
  context: string;
  extraction_method: string;
  extractor_version: string;
  confidence: string | number | null;
  uncertainty: unknown;
  formatting: unknown;
  ordinal: number;
}

export interface AuditSnapshotRow {
  owner_user_id: string;
  project_id: string;
  material_id: string;
  material_version: number;
  media_type: string;
  content_sha256: string;
  parser_version: string;
  response_status: string;
  response_sha256: string;
  record_count: number;
  response_meta: unknown;
}

export interface ParseSnapshotMetric {
  parse_status: string;
  parser_version: string;
  record_count: number;
  stored_response_sha256: string;
  ordered_records_sha256: string;
  ordered_content_sha256: string;
}

export interface DocxAnchorMetric {
  source_quote_independent_check: 'not_performed';
  locators: {
    p4: { count: number; unique: boolean };
    p65: { count: number; unique: boolean };
    p249_table2_row28_cell3: { count: number; unique: boolean };
  };
}

export interface XlsxMetric extends ParseSnapshotMetric {
  cached_formula_results_unverified_count: number;
  cached_formula_result_record_count: number;
  cached_formula_unverified_status: 'consistent_needs_confirmation' | 'inconsistent';
}

const DOCX_MEDIA = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isObject(value) ? value : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function numericConfidence(value: AuditEvidenceRow['confidence']): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('AUDIT_INVALID_EVIDENCE');
  return parsed;
}

function restoredRecord(snapshot: AuditSnapshotRow, row: AuditEvidenceRow): JsonObject {
  return {
    record_id: row.record_id,
    material_id: snapshot.material_id,
    material_version: Number(snapshot.material_version),
    content_hash: snapshot.content_sha256.trim().toLowerCase(),
    locator_type: row.locator_type,
    locator: asJson(row.locator),
    literal_quote: row.literal_quote,
    context: row.context,
    extraction_method: row.extraction_method,
    extractor_version: row.extractor_version,
    confidence: numericConfidence(row.confidence),
    uncertainty: asJson(row.uncertainty),
    formatting: asJson(row.formatting),
  };
}

function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Error('AUDIT_INVALID_EVIDENCE'); }
}

export function orderedRecordsSha256(snapshot: AuditSnapshotRow, evidence: AuditEvidenceRow[]): string {
  const ordered = [...evidence].sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  return sha256(canonical(ordered.map((row) => restoredRecord(snapshot, row))));
}

export function orderedContentSha256(snapshot: AuditSnapshotRow, evidence: AuditEvidenceRow[]): string {
  const ordered = [...evidence].sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  const records = ordered.map((row) => {
    const { material_id: _materialId, material_version: _materialVersion, content_hash: _contentHash, ...content } = restoredRecord(snapshot, row);
    return content;
  });
  return sha256(canonical(records));
}

export type DocxComparisonMetric =
  | { status: 'trivial_same_job_replay' }
  | { status: 'not_comparable'; reason: 'source_sha256_mismatch' | 'parser_version_mismatch' }
  | { status: 'comparable'; ordered_content_hashes_equal: boolean };

export function compareDocxSnapshots(
  jobIdA: string,
  snapshotA: AuditSnapshotRow,
  evidenceA: AuditEvidenceRow[],
  jobIdB: string,
  snapshotB: AuditSnapshotRow,
  evidenceB: AuditEvidenceRow[],
): DocxComparisonMetric {
  if (jobIdA === jobIdB) return { status: 'trivial_same_job_replay' };
  if (snapshotA.content_sha256.trim().toLowerCase() !== snapshotB.content_sha256.trim().toLowerCase()) {
    return { status: 'not_comparable', reason: 'source_sha256_mismatch' };
  }
  if (snapshotA.parser_version !== snapshotB.parser_version) {
    return { status: 'not_comparable', reason: 'parser_version_mismatch' };
  }
  return {
    status: 'comparable',
    ordered_content_hashes_equal: orderedContentSha256(snapshotA, evidenceA) === orderedContentSha256(snapshotB, evidenceB),
  };
}

export function anchorSnapshotMatchesDocxPair(anchor: AuditSnapshotRow, docxA: AuditSnapshotRow, docxB: AuditSnapshotRow): boolean {
  const sourceSha = anchor.content_sha256.trim().toLowerCase();
  return sourceSha === docxA.content_sha256.trim().toLowerCase() && sourceSha === docxB.content_sha256.trim().toLowerCase() &&
    anchor.parser_version === docxA.parser_version && anchor.parser_version === docxB.parser_version;
}

export function snapshotMetric(snapshot: AuditSnapshotRow, evidence: AuditEvidenceRow[]): ParseSnapshotMetric {
  if (!SHA256.test(snapshot.response_sha256.trim().toLowerCase()) ||
      Number(snapshot.record_count) !== evidence.length ||
      evidence.some((row, index) => Number(row.ordinal) !== index)) {
    throw new Error('AUDIT_SNAPSHOT_INTEGRITY_MISMATCH');
  }
  return {
    parse_status: snapshot.response_status,
    parser_version: snapshot.parser_version,
    record_count: evidence.length,
    stored_response_sha256: snapshot.response_sha256.trim().toLowerCase(),
    ordered_records_sha256: orderedRecordsSha256(snapshot, evidence),
    ordered_content_sha256: orderedContentSha256(snapshot, evidence),
  };
}

function pathParts(locator: unknown): JsonObject[] {
  if (!isObject(locator) || !Array.isArray(locator.path)) return [];
  return locator.path.filter(isObject);
}

export function docxAnchorMetric(evidence: AuditEvidenceRow[]): DocxAnchorMetric {
  const docx = evidence.filter((row) => row.locator_type === 'docx_block');
  const countForParagraph = (paragraph: number) => docx.filter((row) =>
    pathParts(row.locator).some((part) => part.paragraph === paragraph)).length;
  const p249Cell = docx.filter((row) => {
    const parts = pathParts(row.locator);
    // The parser's native cell locator is the stable identity for this table
    // paragraph. Original OOXML p[249] correspondence needs the separate source check.
    return parts.some((part) => part.table === 2 && part.row === 28 && part.column === 3);
  }).length;
  const p4 = countForParagraph(4);
  const p65 = countForParagraph(65);
  return {
    source_quote_independent_check: 'not_performed',
    locators: {
      p4: { count: p4, unique: p4 === 1 },
      p65: { count: p65, unique: p65 === 1 },
      p249_table2_row28_cell3: { count: p249Cell, unique: p249Cell === 1 },
    },
  };
}

export function xlsxMetric(snapshot: AuditSnapshotRow, evidence: AuditEvidenceRow[]): XlsxMetric {
  const base = snapshotMetric(snapshot, evidence);
  const meta = asObject(snapshot.response_meta);
  const document = isObject(meta?.document) ? meta.document : null;
  const warnings = Array.isArray(meta?.warnings) ? meta.warnings : [];
  const declared = Number(document?.cached_formula_results);
  if (!Number.isSafeInteger(declared) || declared < 0) throw new Error('AUDIT_XLSX_METADATA_UNAVAILABLE');
  const cachedRows = evidence.filter((row) => {
    const formatting = asObject(row.formatting);
    return Object.hasOwn(formatting ?? {}, 'cached_formula_result');
  });
  const verifiedMarkers = cachedRows.filter((row) => Array.isArray(asJson(row.uncertainty)) &&
    (asJson(row.uncertainty) as unknown[]).includes('formula_cached_result_unverified')).length;
  const hasWarning = warnings.some((warning) => isObject(warning) && warning.code === 'XLSX_FORMULA_CACHE_UNVERIFIED');
  const consistent = declared === cachedRows.length && cachedRows.length === verifiedMarkers &&
    (declared === 0 || (snapshot.response_status === 'needs_confirmation' && hasWarning));
  return {
    ...base,
    cached_formula_results_unverified_count: declared,
    cached_formula_result_record_count: verifiedMarkers,
    cached_formula_unverified_status: consistent ? 'consistent_needs_confirmation' : 'inconsistent',
  };
}

function validateJobId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error('AUDIT_INVALID_CONFIGURATION');
  return value;
}

async function readSnapshot(client: PoolClient, jobId: string, expectedMediaType: string): Promise<{ snapshot: AuditSnapshotRow; evidence: AuditEvidenceRow[] }> {
  const job = await client.query(
    `SELECT j.owner_user_id,j.project_id,j.material_id,j.material_version,j.material_sha256,j.parser_version,j.state AS job_state,
            m.media_type,s.content_sha256,s.response_status,s.response_sha256,s.record_count,s.response_meta,s.parser_version AS snapshot_parser_version
       FROM bb_jobs j
       JOIN bb_material_versions m ON m.owner_user_id=j.owner_user_id AND m.project_id=j.project_id
        AND m.id=j.material_id AND m.version=j.material_version
       JOIN bb_parse_snapshots s ON s.owner_user_id=j.owner_user_id AND s.project_id=j.project_id
        AND s.material_id=j.material_id AND s.material_version=j.material_version AND s.parser_version=j.parser_version
        AND lower(btrim(s.content_sha256::text))=lower(btrim(j.material_sha256::text))
      WHERE j.id=$1 AND j.job_type='parse' AND j.subtype='material_parse'`, [jobId]);
  if (job.rows.length !== 1) throw new Error('AUDIT_PARSE_JOB_OR_SNAPSHOT_NOT_FOUND');
  const row = job.rows[0]!;
  if (row.job_state !== 'succeeded' || row.media_type !== expectedMediaType || row.parser_version !== row.snapshot_parser_version ||
      !['parsed', 'needs_confirmation'].includes(String(row.response_status))) throw new Error('AUDIT_PARSE_JOB_NOT_AUDITABLE');
  const snapshot: AuditSnapshotRow = {
    owner_user_id: String(row.owner_user_id), project_id: String(row.project_id), material_id: String(row.material_id),
    material_version: Number(row.material_version), media_type: String(row.media_type), content_sha256: String(row.content_sha256),
    parser_version: String(row.parser_version), response_status: String(row.response_status),
    response_sha256: String(row.response_sha256), record_count: Number(row.record_count), response_meta: row.response_meta,
  };
  const result = await client.query(
    `SELECT record_id,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,ordinal
       FROM bb_parse_evidence
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
        AND snapshot_id=(SELECT id FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3
          AND material_version=$4 AND parser_version=$5)
      ORDER BY ordinal`,
    [snapshot.owner_user_id, snapshot.project_id, snapshot.material_id, snapshot.material_version, snapshot.parser_version]);
  return { snapshot, evidence: result.rows as AuditEvidenceRow[] };
}

interface Targets {
  docx_a_job_id: string;
  docx_b_job_id: string;
  anchor_docx_job_id: string;
  xlsx_job_id: string;
}

function parseTargets(raw: string | undefined): Targets {
  if (!raw) throw new Error('AUDIT_CONFIGURATION_REQUIRED');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('AUDIT_INVALID_CONFIGURATION'); }
  if (!isObject(parsed)) throw new Error('AUDIT_INVALID_CONFIGURATION');
  return {
    docx_a_job_id: validateJobId(parsed.docx_a_job_id),
    docx_b_job_id: validateJobId(parsed.docx_b_job_id),
    anchor_docx_job_id: validateJobId(parsed.anchor_docx_job_id),
    xlsx_job_id: validateJobId(parsed.xlsx_job_id),
  };
}

export async function runParseSnapshotAudit(databaseUrl: string | undefined, targetsValue: string | undefined): Promise<Record<string, unknown>> {
  if (!databaseUrl) throw new Error('AUDIT_DATABASE_URL_REQUIRED');
  const targets = parseTargets(targetsValue);
  if (targets.docx_a_job_id === targets.docx_b_job_id) throw new Error('AUDIT_DISTINCT_DOCX_JOB_IDS_REQUIRED');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'bondbuddy-parse-snapshot-audit' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const [docxA, docxB, anchors, xlsx] = await Promise.all([
      readSnapshot(client, targets.docx_a_job_id, DOCX_MEDIA),
      readSnapshot(client, targets.docx_b_job_id, DOCX_MEDIA),
      readSnapshot(client, targets.anchor_docx_job_id, DOCX_MEDIA),
      readSnapshot(client, targets.xlsx_job_id, XLSX_MEDIA),
    ]);
    const anchorBindingMatches = anchorSnapshotMatchesDocxPair(anchors.snapshot, docxA.snapshot, docxB.snapshot);
    const docxComparison = compareDocxSnapshots(targets.docx_a_job_id, docxA.snapshot, docxA.evidence,
      targets.docx_b_job_id, docxB.snapshot, docxB.evidence);
    const result = {
      schema_version: 'parse-snapshot-audit-v1',
      database_access: 'read_only_transaction',
      audit_status: anchorBindingMatches ? 'reported_not_source_verified' : 'failed_anchor_binding',
      docx_jobs: {
        a: snapshotMetric(docxA.snapshot, docxA.evidence),
        b: snapshotMetric(docxB.snapshot, docxB.evidence),
        comparison: docxComparison,
      },
      anchor_source_binding_status: anchorBindingMatches ? 'matches_docx_pair' : 'mismatch',
      rq_202506_01_anchor_locator_presence: anchorBindingMatches
        ? docxAnchorMetric(anchors.evidence)
        : { source_quote_independent_check: 'not_performed', locator_check: 'skipped_source_binding_mismatch' },
      xlsx: xlsxMetric(xlsx.snapshot, xlsx.evidence),
    };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain the original audit failure */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runParseSnapshotAudit(process.env.BB_PARSE_AUDIT_DATABASE_URL, process.env.BB_PARSE_AUDIT_TARGETS_JSON)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.audit_status === 'failed_anchor_binding') process.exitCode = 1;
    })
    .catch((error: unknown) => {
      const code = error instanceof Error && /^AUDIT_[A-Z0-9_]+$/.test(error.message) ? ` (${error.message})` : '';
      process.stderr.write(`parse snapshot audit failed${code}; inspect the redacted audit configuration\n`);
      process.exitCode = 1;
    });
}
