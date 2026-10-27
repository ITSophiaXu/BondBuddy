import type { Pool } from 'pg';
import { Problem } from './data.js';
import type { RunExecutionIdentity } from './run-execution.js';

export type ArtifactExecutionRef = {
  id: string; version: number; owner_user_id: string; run_id: string;
  project_id?: string; media_type?: string; sha256?: string; object_key?: string;
};
const unavailable = () => new Problem(503, 'DATA_UNAVAILABLE', 'Artifact execution identity is unavailable');
const hash = (value: unknown): string | null => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value.trim()) ? value.trim() : null;

/** An artifact business version belongs to one immutable execution; never infer the latest input. */
export async function assertArtifactExecution(db: Pick<Pool, 'query'>, artifact: ArtifactExecutionRef,
  expected?: RunExecutionIdentity): Promise<RunExecutionIdentity & { projectId: string }> {
  if (!artifact || !artifact.id || !artifact.owner_user_id || !artifact.run_id
    || !Number.isSafeInteger(artifact.version) || artifact.version < 1) throw unavailable();
  const rows = (await db.query(`SELECT b.*,a.media_type AS artifact_media_type,a.sha256 AS artifact_sha256,
      a.object_key AS artifact_object_key,r.input_revision AS run_input_revision,r.input_hash AS run_input_hash,
      r.channel AS run_channel,successor.id AS successor_authorization_id
    FROM bb_artifact_execution_bindings b
    JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
      AND a.id=b.artifact_id AND a.version=b.artifact_version
    JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.project_id=b.project_id AND r.id=b.run_id
    JOIN bb_run_execution_versions e ON e.owner_user_id=b.owner_user_id AND e.project_id=b.project_id AND e.run_id=b.run_id
      AND e.execution_version=b.execution_version AND e.input_revision=b.input_revision AND e.input_hash=b.input_hash
    LEFT JOIN bb_run_test_successor_authorizations successor ON successor.owner_user_id=e.owner_user_id
      AND successor.project_id=e.project_id AND successor.run_id=e.run_id
      AND successor.execution_version=e.execution_version AND successor.input_revision=e.input_revision AND successor.input_hash=e.input_hash
      AND successor.source_execution_version=1 AND successor.source_input_revision=r.input_revision AND successor.source_input_hash=r.input_hash
    WHERE b.owner_user_id=$1 AND b.run_id=$2 AND b.artifact_id=$3 AND b.artifact_version=$4`,
  [artifact.owner_user_id,artifact.run_id,artifact.id,artifact.version])).rows;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.owner_user_id !== artifact.owner_user_id || row.run_id !== artifact.run_id
    || row.artifact_id !== artifact.id || row.artifact_version !== artifact.version
    || typeof row.project_id !== 'string' || !row.project_id
    || !Number.isSafeInteger(row.input_revision) || row.input_revision < 1
    || !Number.isSafeInteger(row.run_input_revision) || row.run_input_revision < 1
    || !hash(row.input_hash) || !hash(row.run_input_hash)
    || !(row.execution_version === 1 && row.input_revision === row.run_input_revision
      && hash(row.input_hash) === hash(row.run_input_hash)
      || row.execution_version === 2 && row.run_channel === 'non_production_test'
        && row.input_revision !== row.run_input_revision
        && typeof row.successor_authorization_id === 'string' && row.successor_authorization_id.length > 0)) throw unavailable();
  for (const [field, stored] of [['project_id',row.project_id],['media_type',row.artifact_media_type],
    ['object_key',row.artifact_object_key]] as const) {
    if (Object.hasOwn(artifact,field) && (typeof artifact[field] !== 'string' || !artifact[field] || artifact[field] !== stored)) throw unavailable();
  }
  if (Object.hasOwn(artifact,'sha256') && (!hash(artifact.sha256) || hash(artifact.sha256) !== hash(row.artifact_sha256))) throw unavailable();
  const identity = { executionVersion: row.execution_version, inputRevision: row.input_revision, inputHash: hash(row.input_hash)! };
  if (expected && (expected.executionVersion !== identity.executionVersion || expected.inputRevision !== identity.inputRevision
    || expected.inputHash !== identity.inputHash)) throw unavailable();
  return { ...identity, projectId: row.project_id };
}
