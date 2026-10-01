import type { Pool, PoolClient } from 'pg';
import { date, digest, missing, Problem, uid, type PrivateBlobs, transaction } from './data.js';
import { audit, SCRUB_VERSION, scrubSecrets } from './log-ops.js';
import { saveSnapshotRef } from './observability.js';
import { assertTestChannelReadable } from './non-production-test.js';

export type SubmissionInput = {
  owner: string; projectId: string; runId?: string; kind: 'run_execute' | 'project_message';
  messageId?: string; submissionRequestId?: string; body: string; inputRevision?: number; inputHash?: string;
  materialVersions: { material_id: string; material_version: number }[];
};

// Commit an intent before Blob IO so a crash is recoverable by the existing orphan sweep.
export async function prepareUserSubmission(pool: Pool, blobs: PrivateBlobs, body: string) {
  const scrubbed = scrubSecrets(body);
  const bytes = Buffer.from(scrubbed, 'utf8');
  const id = uid();
  return {
    async write(owner: string, projectId: string) {
      const key = `users/${owner}/projects/${projectId}/snapshots/${id}`;
      await pool.query('INSERT INTO bb_prompt_blob_intents(id,owner_user_id,project_id,object_key) VALUES($1,$2,$3,$4)', [id,owner,projectId,key]);
      await blobs.put(key, bytes, 'text/plain; charset=utf-8');
      return {
        async register(client: PoolClient, input: Omit<SubmissionInput,'body'|'owner'|'projectId'>) {
          await client.query('SELECT id FROM bb_prompt_blob_intents WHERE id=$1 FOR UPDATE', [id]);
          // The snapshot's historical version namespace is project-wide.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${owner}:${projectId}:user_submission`]);
          const previous = (await client.query('SELECT id,version FROM bb_user_submission_versions WHERE owner_user_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1', [owner,projectId])).rows[0];
          const latestSnapshot = (await client.query("SELECT COALESCE(max(version),0) AS version FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='user_prompt'", [owner,projectId])).rows[0];
          const version = Math.max(Number(previous?.version ?? 0), Number(latestSnapshot.version)) + 1;
          const priorMessage = input.messageId ? (await client.query("SELECT id,message_version FROM bb_user_submission_versions WHERE owner_user_id=$1 AND project_id=$2 AND message_id=$3 AND submission_kind='project_message' ORDER BY message_version DESC LIMIT 1",[owner,projectId,input.messageId])).rows[0] : null;
          const messageVersion = input.messageId ? Number(priorMessage?.message_version ?? 0)+1 : null;
          if (input.runId) {
            const run = (await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3', [owner,projectId,input.runId])).rowCount;
            if (!run) throw missing();
          }
          const snapshotId = await saveSnapshotRef(pool,{owner,projectId,runId:input.runId,kind:'user_prompt',version,objectKey:key,sha256:digest(bytes),redactionVersion:SCRUB_VERSION,inputRevision:input.inputRevision,inputHash:input.inputHash,blobs},client);
          const submissionId = uid();
          const row = (await client.query(`INSERT INTO bb_user_submission_versions
            (id,owner_user_id,project_id,run_id,snapshot_id,submission_kind,message_id,submission_request_id,message_version,version,previous_submission_id,revises_submission_id,content_sha256,input_revision,input_hash,material_versions)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING created_at`,
            [submissionId,owner,projectId,input.runId??null,snapshotId,input.kind,input.messageId??null,input.submissionRequestId??null,messageVersion,version,previous?.id??null,priorMessage?.id??null,digest(bytes),input.inputRevision??null,input.inputHash??null,JSON.stringify(input.materialVersions)])).rows[0];
          await client.query('UPDATE bb_prompt_blob_intents SET registered_at=now() WHERE id=$1',[id]);
          return {submissionId,snapshotId,version,messageVersion,revisesSubmissionId:priorMessage?.id??null,contentSha256:digest(bytes),createdAt:row.created_at};
        },
        async discard() {
          await transaction(pool,async client=>{
            const intent=(await client.query('SELECT * FROM bb_prompt_blob_intents WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if (!intent || intent.registered_at || intent.cleared_at) return;
            if ((await client.query('SELECT 1 FROM bb_snapshot_refs WHERE object_key=$1',[key])).rowCount) {
              await client.query('UPDATE bb_prompt_blob_intents SET registered_at=now() WHERE id=$1',[id]);
              return;
            }
            await blobs.delete(key);
            await client.query('UPDATE bb_prompt_blob_intents SET cleared_at=now() WHERE id=$1',[id]);
          });
        }
      };
    }
  };
}

export async function verifiedMaterialVersions(client: PoolClient, owner: string, projectId: string, refs: { material_id: string; material_version: number }[]) {
  for (const ref of refs) {
    const found = await client.query('SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL', [owner,projectId,ref.material_id,ref.material_version]);
    if (!found.rowCount) throw missing();
  }
  return refs;
}

/** Prompt-viewer-only index; plaintext still leaves solely through the existing audited view. */
export async function adminUserSubmissionVersions(pool: Pool, actorId: string, jobId: string, reasonCode: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw missing();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) throw new Problem(422,'VALIDATION_FAILED','reason_code is required');
  return transaction(pool,async client=>{
    const job=(await client.query(`SELECT j.id,j.owner_user_id,j.run_id,j.channel,r.channel run_channel,COALESCE(j.project_id,r.project_id) project_id
      FROM bb_jobs j LEFT JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
      JOIN bb_users u ON u.id=j.owner_user_id AND u.status='active'
      JOIN bb_projects p ON p.id=COALESCE(j.project_id,r.project_id) AND p.owner_user_id=j.owner_user_id AND p.deleted_at IS NULL
      WHERE j.id=$1`,[jobId])).rows[0];
    if(!job)throw missing();
    assertTestChannelReadable(job.run_channel??job.channel);
    const rows=(await client.query(`SELECT v.*,t.id tombstone FROM bb_user_submission_versions v
      LEFT JOIN bb_log_content_tombstones t ON t.content_kind='prompt_snapshot' AND t.content_id=v.snapshot_id
      WHERE v.owner_user_id=$1 AND v.project_id=$2 AND v.run_id=$3 ORDER BY v.version`,[job.owner_user_id,job.project_id,job.run_id])).rows;
    const auditId=await audit(client,{actorId,role:'prompt_viewer',owner:job.owner_user_id,purpose:'user_submission_list',filter:{jobId},target:jobId,reason:reasonCode});
    return {job_id:jobId,audit_id:auditId,items:rows.map(s=>({submission_id:s.id,snapshot_id:s.snapshot_id,kind:s.submission_kind,message_id:s.message_id,message_version:s.message_version,version:s.version,previous_submission_id:s.previous_submission_id,content_sha256:s.content_sha256.trim(),input_revision:s.input_revision,input_hash:s.input_hash?.trim()??null,material_versions:s.material_versions,content_state:s.tombstone?'purged' as const:'available' as const,created_at:date(s.created_at)}))};
  });
}
