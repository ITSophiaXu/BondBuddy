import type { Pool, PoolClient } from 'pg';
import { Problem, run } from './data.js';
import { assertTestGrant, testChannelEnabled } from './non-production-test.js';
import { assertRunExecution, type RunExecutionIdentity } from './run-execution.js';

export type RunExecutionTestGrantScope = RunExecutionIdentity & {
  owner: string; projectId: string; runId: string;
};
export type RunExecutionTestGrant = {
  grantId: string; authorizationId: string | null;
  grant: Awaited<ReturnType<typeof assertTestGrant>>;
};
const mismatch = () => new Problem(409, 'TEST_GRANT_MISMATCH', 'Test grant does not authorize the active execution input');

/** Resolve current test permission from durable execution authority. The run's
 * immutable grant remains the original request's grant after a successor starts.
 * This live check belongs before new work and delivery, not result journaling. */
export async function assertRunExecutionTestGrant(db: Pool | PoolClient,
  scope: RunExecutionTestGrantScope): Promise<RunExecutionTestGrant> {
  if (!testChannelEnabled()) throw new Problem(403, 'TEST_CHANNEL_DISABLED', 'Test channel is disabled');
  if (![scope.owner, scope.projectId, scope.runId].every(value => typeof value === 'string' && value.length > 0)
    || ![1, 2].includes(scope.executionVersion) || !Number.isSafeInteger(scope.inputRevision) || scope.inputRevision < 1
    || typeof scope.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(scope.inputHash)) throw mismatch();
  const rawRun = await run(db, scope.owner, scope.runId);
  if (rawRun.owner_user_id !== scope.owner || rawRun.project_id !== scope.projectId || rawRun.id !== scope.runId
    || rawRun.channel !== 'non_production_test' || typeof rawRun.test_grant_id !== 'string' || !rawRun.test_grant_id)
    throw mismatch();
  const execution = await assertRunExecution(db, rawRun, scope);
  let grantId: string = rawRun.test_grant_id, authorizationId: string | null = null;
  if (execution.executionVersion === 2) {
    const receipts = (await db.query(`SELECT a.id,a.test_grant_id FROM bb_run_test_successor_authorizations a
      WHERE a.owner_user_id=$1 AND a.project_id=$2 AND a.run_id=$3
        AND a.execution_version=$4 AND a.input_revision=$5 AND a.input_hash=$6
        AND a.source_execution_version=1 AND a.source_input_revision=$7 AND a.source_input_hash=$8`,
    [scope.owner, scope.projectId, scope.runId, execution.executionVersion, execution.inputRevision, execution.inputHash,
      rawRun.input_revision, rawRun.input_hash.trim()])).rows;
    const receipt = receipts[0];
    if (receipts.length !== 1 || typeof receipt.id !== 'string' || !receipt.id
      || typeof receipt.test_grant_id !== 'string' || !receipt.test_grant_id) throw mismatch();
    authorizationId = receipt.id; grantId = receipt.test_grant_id;
  }
  const grant = await assertTestGrant(db, { grantId, userId: scope.owner, projectId: scope.projectId,
    inputRevision: execution.inputRevision, inputHash: execution.inputHash });
  return { grantId, authorizationId, grant };
}
