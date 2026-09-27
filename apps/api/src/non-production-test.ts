import type { Pool, PoolClient } from 'pg';
import { Problem } from './data.js';

export const testChannelEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.BB_DEPLOYMENT_TIER === 'preprod' && env.BB_NON_PRODUCTION_TEST_CHANNEL === 'enabled';

export type TestGrantScope = { grantId: string; userId: string; projectId: string; inputRevision: number; inputHash: string };

/** Every submit, claim and external-call gate uses this exact current grant check. */
export async function assertTestGrant(db: Pool | PoolClient, scope: TestGrantScope) {
  if (!testChannelEnabled()) throw new Problem(403, 'TEST_CHANNEL_DISABLED', 'Test channel is disabled');
  const q = await db.query(`SELECT user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,expires_at,revoked_at
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
