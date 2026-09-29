import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { missing, Problem } from './data.js';

export const testChannelEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.BB_DEPLOYMENT_TIER === 'preprod' && env.BB_NON_PRODUCTION_TEST_CHANNEL === 'enabled';

/** Test run metadata is unavailable whenever this deployment cannot serve test artifacts. */
export function assertTestChannelReadable(channel: string | null | undefined) {
  if (channel === 'non_production_test' && !testChannelEnabled()) throw missing();
}

export type TestGrantScope = { grantId: string; userId: string; projectId: string; inputRevision: number; inputHash: string };

/** Server-owned, time-bounded admission for a preproduction working draft. */
export async function autoWorkingDraftGrant(db: PoolClient, scope: Omit<TestGrantScope, 'grantId'>,
  manifest: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!testChannelEnabled(env) || !manifest || typeof manifest !== 'object' || manifest.kind !== 'update' || manifest.market !== 'sse' ||
      manifest.offering !== 'private') return null;
  const until = env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT;
  const expires = until ? new Date(until).getTime() : NaN;
  const hashes = [env.BB_PREPROD_WORKING_DRAFT_SAMPLE_MANIFEST_SHA256,
    env.BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH, env.BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH];
  const stage=env.BB_PREPROD_WORKING_DRAFT_STAGE, asOf=env.BB_PREPROD_WORKING_DRAFT_AS_OF;
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 7 * 86_400_000 ||
      hashes.some(value => !value || !/^[a-f0-9]{64}$/.test(value)) ||
      !['registration','issuance'].includes(stage ?? '') || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
      !Number.isFinite(Date.parse(`${asOf}T00:00:00Z`)) ||
      new Date(`${asOf}T00:00:00Z`).toISOString().slice(0,10)!==asOf) return null;
  // Serialize admission of this exact immutable input. A revoked or expired
  // grant is deliberately not replaced by an ordinary browser retry.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`working-draft:${scope.userId}:${scope.projectId}:${scope.inputRevision}:${scope.inputHash}`]);
  const existing = await db.query(`SELECT grant_id,revoked_at,expires_at FROM bb_non_production_test_grants
    WHERE user_id=$1 AND project_id=$2 AND input_revision=$3 AND input_hash=$4
      AND granted_by='preprod_service' ORDER BY created_at LIMIT 1`,
  [scope.userId, scope.projectId, scope.inputRevision, scope.inputHash]);
  if (existing.rows[0]) return existing.rows[0].revoked_at ||
    new Date(existing.rows[0].expires_at).getTime() <= Date.now() ? null : existing.rows[0].grant_id;
  const grantId = randomUUID();
  await db.query(`INSERT INTO bb_non_production_test_grants
    (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,
     rule_pack_hash,granted_by,reason,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'preprod_service',$9,$10)`,
  [grantId,scope.userId,scope.projectId,scope.inputRevision,scope.inputHash,...hashes,
    `controlled_working_draft:${stage}:${asOf}`,until]);
  await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'test_grant',$3,'test_grant.created',$4)`,
  [randomUUID(),scope.userId,grantId,{grant_id:grantId,project_id:scope.projectId,
    input_revision:scope.inputRevision,granted_by:'preprod_service'}]);
  return grantId;
}

/** Every submit, claim and external-call gate uses this exact current grant check. */
export async function assertTestGrant(db: Pool | PoolClient, scope: TestGrantScope) {
  if (!testChannelEnabled()) throw new Problem(403, 'TEST_CHANNEL_DISABLED', 'Test channel is disabled');
  const q = await db.query(`SELECT user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at,revoked_at
    FROM bb_non_production_test_grants WHERE grant_id=$1`, [scope.grantId]);
  const grant = q.rows[0];
  if (!grant || grant.user_id !== scope.userId) throw new Problem(404, 'TEST_GRANT_INVALID', 'Test grant not found');
  if (grant.revoked_at) throw new Problem(409, 'TEST_GRANT_REVOKED', 'Test grant was revoked');
  if (new Date(grant.expires_at).getTime() <= Date.now()) throw new Problem(409, 'TEST_GRANT_EXPIRED', 'Test grant expired');
  if (grant.project_id !== scope.projectId || Number(grant.input_revision) !== scope.inputRevision ||
      grant.input_hash.trim() !== scope.inputHash.trim())
    throw new Problem(409, 'TEST_GRANT_MISMATCH', 'Test grant does not match the input');
  return grant;
}
