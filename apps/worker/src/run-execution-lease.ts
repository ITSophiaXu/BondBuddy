import type {PoolClient} from 'pg';
import {assertRunExecution} from '@bondbuddy/api/run-execution';
import type {StageContext} from './run-pipeline.js';

/** Independent worker writes use the queue's run -> job -> execution-check order. */
export async function lockStageRunExecution(client:PoolClient,ctx:Pick<StageContext,'run'|'lease'>){
  if(ctx.lease.runId!==ctx.run.id||ctx.lease.owner!==ctx.run.owner_user_id)return null;
  const run=(await client.query(`SELECT r.* FROM bb_runs r WHERE r.id=$1 AND r.owner_user_id=$2 FOR UPDATE`,[ctx.lease.runId,ctx.lease.owner])).rows[0];
  if(!run)return null;
  const job=(await client.query(`SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3
    AND state='running' AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[ctx.lease.jobId,ctx.lease.owner,ctx.lease.runId,ctx.lease.token])).rows[0];
  if(!job)return null;
  await assertRunExecution(client,run,ctx.lease);
  if(run.state!=='running'||run.project_id!==ctx.run.project_id||run.input_revision!==ctx.run.input_revision||String(run.input_hash).trim()!==ctx.run.input_hash.trim())return null;
  return run;
}
