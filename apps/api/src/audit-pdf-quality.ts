import type { PoolClient } from 'pg';
import { PDF_QUALITY_JOB_VERSIONS, PDF_QUALITY_STAGE, AUDIT_PDF_QUALITY_REQUIRED, AUDIT_PDF_INCOMPLETE_MESSAGE, auditPdfQualityState, auditPdfQualityMessage, type SourceMaterialPin } from '@bondbuddy/contracts';
import { Problem } from './data.js';

/** Check every active uploaded audit PDF: omitting a bad file from a hand-crafted request cannot bypass the UI.
 * Callers already hold the project lock and verify immutable selected input pins. */
export async function assertAuditPdfQuality(client: Pick<PoolClient, 'query'>, owner: string, projectId: string,
  materials: readonly SourceMaterialPin[]) {
  const rows = (await client.query([
    'SELECT m.id,m.filename,j.checkpoint,j.state FROM bb_material_versions m LEFT JOIN LATERAL (SELECT checkpoint,state',
    'FROM bb_jobs q WHERE q.owner_user_id=m.owner_user_id AND q.project_id=m.project_id',
    'AND q.material_id=m.id AND q.material_version=m.version AND q.material_sha256=m.sha256',
    "AND q.job_type='parse' AND q.subtype='material_parse' AND split_part(q.parser_version, ':retry:', 1)=ANY($3::text[])",
    'ORDER BY q.created_at DESC,q.id DESC LIMIT 1) j ON true',
    "WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.deleted_at IS NULL AND NOT m.internal_template AND m.role='audit' AND m.media_type='application/pdf'",
    "AND (m.version=(SELECT max(v.version) FROM bb_material_versions v WHERE v.id=m.id AND v.owner_user_id=m.owner_user_id AND v.project_id=m.project_id AND v.deleted_at IS NULL)",
    "OR EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS pin(material_id text,material_version int) WHERE pin.material_id=m.id AND pin.material_version=m.version))",
    'ORDER BY m.persisted_at,m.id',
  ].join(' '), [owner, projectId, PDF_QUALITY_JOB_VERSIONS, JSON.stringify(materials)])).rows;
  for (const row of rows) {
    const quality = row.checkpoint?.stages?.[PDF_QUALITY_STAGE];
    const message = auditPdfQualityState(quality) === 'pending' && ['failed','cancelled','paused','succeeded'].includes(row.state) ? AUDIT_PDF_INCOMPLETE_MESSAGE : auditPdfQualityMessage(quality);
    if (!message) continue;
    const pages = Array.isArray(quality?.blocking_pages) ? quality.blocking_pages.slice(0, 8).join('、') : '';
    const detail = row.filename + (pages ? '（PDF 第 ' + pages + ' 页）' : '') + '：' + message;
    throw Object.assign(new Problem(422, 'INPUT_REQUIRED', detail), {inputIssues: [
      {field: 'materials.' + row.id, code: AUDIT_PDF_QUALITY_REQUIRED, message: detail},
    ]});
  }
}
