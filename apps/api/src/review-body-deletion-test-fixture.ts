// Synthetic private review bodies only. Shared by the behavior and migration
// upgrade tests; all immutable/source/bridge guards remain enabled.
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { isReviewReport, type ReviewEditorSnapshot, type ReviewReport } from '@bondbuddy/contracts';
import { digest, uid, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';

export const reviewBodyTables = ['bb_review_editors', 'bb_review_execution_editors',
  'bb_review_reports', 'bb_review_execution_reports'] as const;
export type ReviewBodyTable = typeof reviewBodyTables[number];
type Db = Pool | PoolClient;

export async function createReviewBodyFixture(pool: Pool, options: { bodies?: boolean; owner?: string } = {}) {
  const owner = options.owner ?? uid(), projectId = uid(), runId = uid(), jobId = uid();
  const reportId = uid(), materialId = uid(), uploadId = uid(), lotId = uid();
  if (!options.owner) await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',
    [owner, 'review_body_' + uid().replaceAll('-', '').slice(0, 18)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic review body lifecycle','review')", [projectId, owner]);
  const bytes = Buffer.from('Synthetic review body source'), sourceHash = digest(bytes);
  await pool.query('INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) '
    + "VALUES($1,$2,$3,'synthetic-source.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')",
  [uploadId, owner, projectId, bytes.length, sourceHash, 'users/' + owner + '/uploads/' + uploadId]);
  await pool.query('INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) '
    + "VALUES($1,1,$2,$3,$4,'other','synthetic-source.pdf','application/pdf',$5,$6,$7,'persisted')",
  [materialId, owner, projectId, uploadId, bytes.length, sourceHash, 'users/' + owner + '/projects/' + projectId + '/materials/' + materialId]);
  const pin = { material_id: materialId, material_version: 1, sha256: sourceHash };
  const input = { source_material_ref: pin, material_versions: [pin], requirements: ['Synthetic private review instruction'], as_of: null };
  const origin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
  const manifest = { draft_revision: 1, project_kind: 'review', materials: [{ ...pin, role: 'other' }], review: {
    version: 'review_v1', operation: 'full_review', version_number: 1, report_id: reportId, source_report_id: null,
    source_report_sha256: null, finding_ids: [], input, origin, file_delivery: { version: 'review-correction-v2', knowledge: [] }
  } };
  const hash = inputManifestHash(manifest);
  await pool.query('INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) '
    + "VALUES($1,1,$2,1,$3,$4,$5,'[]')", [projectId, owner, hash, manifest, JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
  await pool.query('INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage) '
    + "VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','word_delivery')", [runId, owner, projectId, hash, uid()]);
  await pool.query('INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint) '
    + "VALUES($1,$2,$3,'review','synthetic-body-lifecycle','running','word_delivery',$4)",
  [jobId, owner, runId, { synthetic: 'Private checkpoint retained by this four-table slice' }]);
  await pool.query('INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot) '
    + "VALUES($1,$2,$3,1,'full_review',$4)", [runId, owner, projectId, { input, origin, finding_ids: [], input_version: 1 }]);
  await pool.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
  await pool.query('INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,frozen) '
    + "VALUES($1,$2,'existing_grant',$1,10000,8750,250)", [lotId, owner]);
  await pool.query('INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason) '
    + "VALUES($1,$2,$1,'grant',10000,$3,'synthetic-test','Synthetic nonempty ledger retained during body deletion')", [uid(), owner, lotId]);
  const snapshot: ReviewEditorSnapshot = { version: 'review-editor-v1', source_filename: 'synthetic-source.pdf', source_sha256: sourceHash,
    source_format: 'pdf', warnings: ['Synthetic editor private warning'], paragraphs: [{ id: 'p1', text: 'Synthetic private paragraph' }],
    issues: [{ id: 'i1', decision: 'suggested', manual_text: '', category: 'synthetic', title: 'Synthetic private correction',
      original: 'Synthetic private paragraph', replacement: 'Synthetic private replacement', reason: 'Synthetic private reason',
      evidence: 'Synthetic private evidence', missing: '', uncertain: false, paragraph_id: 'p1', applied: true, limitation: '' }] };
  const report: ReviewReport = { report_id: reportId, project_id: projectId, run_id: runId, input_revision: 1, version: 1,
    source_material: pin, scope: { mode: 'full_review', finding_ids: [] }, findings: [], coverage: [],
    limitations: ['Synthetic report private limitation'], created_at: new Date().toISOString() };
  assert.ok(isReviewReport(report));
  // Explicit submillisecond time proves that receipts do not roundtrip through JS Date.
  const createdSql = "date_trunc('milliseconds',clock_timestamp())+interval '0.001123 seconds'";
  const insertEditor = (db: Db = pool) => db.query('INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256,created_at) '
    + 'VALUES($1,$2,$3,$4,$5,' + createdSql + ')', [owner, projectId, runId, snapshot, inputManifestHash(snapshot)]);
  const insertReport = (db: Db = pool) => db.query('INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report,created_at) '
    + 'VALUES($1,$2,$3,$4,1,$5,$6,' + createdSql + ')', [reportId, owner, projectId, runId, inputManifestHash(report), report]);
  const rows = async (db: Db = pool) => {
    const all: Record<string, any[]> = {};
    for (const table of reviewBodyTables) all[table] = (await db.query('SELECT to_jsonb(b) AS body FROM ' + table
      + ' b WHERE owner_user_id=$1 AND project_id=$2 ORDER BY run_id', [owner, projectId])).rows.map(row => row.body);
    return all;
  };
  const history = async () => {
    const all: Record<string, any[]> = {};
    for (const table of ['bb_input_revisions', 'bb_run_execution_versions', 'bb_run_execution_heads', 'bb_runs', 'bb_jobs',
      'bb_review_executions', 'bb_review_execution_snapshots', 'bb_credit_accounts', 'bb_credit_lots', 'bb_credit_events']) {
      all[table] = (await pool.query('SELECT to_jsonb(b) AS body FROM ' + table + ' b WHERE owner_user_id=$1 ORDER BY to_jsonb(b)::text', [owner])).rows.map(row => row.body);
    }
    return all;
  };
  if (options.bodies !== false) { await insertEditor(); await insertReport(); }
  await pool.query("UPDATE bb_jobs SET state='cancelled',stage='cancelled' WHERE id=$1", [jobId]);
  await pool.query("UPDATE bb_runs SET state='cancelled',stage='cancelled' WHERE id=$1", [runId]);
  const deleteProject = (days = 8, db: Db = pool) => db.query("UPDATE bb_projects SET deleted_at=clock_timestamp()-($2::numeric*interval '1 day') WHERE id=$1", [projectId, days]);
  const receipts = async () => (await pool.query('SELECT to_jsonb(t) AS receipt FROM bb_review_body_purges t WHERE owner_user_id=$1 AND project_id=$2 ORDER BY body_kind,run_id', [owner, projectId])).rows.map(row => row.receipt);
  return { pool, owner, projectId, runId, jobId, reportId, hash, snapshot, report, insertEditor, insertReport, rows, history, deleteProject, receipts };
}

export const noReviewBodyBlobs: PrivateBlobs = {
  put: async () => { throw new Error('SQL body fixture must not write Blob content'); },
  get: async () => { throw new Error('SQL body fixture must not read Blob content'); },
  getIfExists: async () => null, getIfExistsBounded: async () => null, exists: async () => false,
  delete: async () => { throw new Error('SQL body fixture must not delete Blob content'); }
};

