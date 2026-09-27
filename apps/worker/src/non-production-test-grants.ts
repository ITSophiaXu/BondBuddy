import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { testChannelEnabled } from '@bondbuddy/api/non-production-test';

const hash = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9_-]{1,128}$/;
const usage = 'usage: create <user_id> <project_id> <revision> <input_hash> <manifest_sha256> <taxonomy_hash> <rule_pack_hash> <granted_by> <expires_at> <reason> | revoke <grant_id> <revoked_by> <reason> | list <user_id>';

export async function runGrantCommand(pool: Pool, args: string[]) {
  if (!testChannelEnabled()) throw new Error('test channel is disabled');
  const [command, ...rest] = args;
  if (command === 'create' && rest.length === 10) {
    const [user, project, revisionText, inputHash, manifestHash, taxonomyHash, packHash, grantedBy, expiresText, reason] = rest;
    const revision = Number(revisionText), expires = new Date(expiresText!);
    if (![user,project,grantedBy].every(value => id.test(value!)) ||
        ![inputHash,manifestHash,taxonomyHash,packHash].every(value => hash.test(value!)) ||
        !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now() ||
        !reason || reason.length > 500) throw new Error('invalid grant fields');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const input = await client.query(`SELECT input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 FOR SHARE`,[user,project,revision]);
      if (!input.rows[0] || input.rows[0].input_hash.trim() !== inputHash) throw new Error('input scope mismatch');
      const grantId = randomUUID();
      await client.query(`INSERT INTO bb_non_production_test_grants
        (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [grantId,user,project,revision,inputHash,manifestHash,taxonomyHash,packHash,grantedBy,reason,expires]);
      await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'test_grant',$3,'test_grant.created',$4)`,
        [randomUUID(),user,grantId,{grant_id:grantId,project_id:project,input_revision:revision,granted_by:grantedBy}]);
      await client.query('COMMIT');
      return {grant_id:grantId};
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (command === 'revoke' && rest.length === 3) {
    const [grantId, by, reason] = rest;
    if (!id.test(grantId!) || !id.test(by!) || !reason || reason.length > 500) throw new Error('invalid revoke fields');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const grant = await client.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by=$2,revoked_reason=$3
        WHERE grant_id=$1 AND revoked_at IS NULL RETURNING user_id`,[grantId,by,reason]);
      if (!grant.rows[0]) throw new Error('active grant not found');
      await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'test_grant',$3,'test_grant.revoked',$4)`,
        [randomUUID(),grant.rows[0].user_id,grantId,{grant_id:grantId,revoked_by:by,reason}]);
      await client.query('COMMIT');
      return {grant_id:grantId,revoked:true};
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (command === 'list' && rest.length === 1 && id.test(rest[0]!)) {
    const q=await pool.query(`SELECT grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,
      taxonomy_hash,rule_pack_hash,granted_by,reason,created_at,expires_at,revoked_at,revoked_by,revoked_reason
      FROM bb_non_production_test_grants WHERE user_id=$1 ORDER BY created_at DESC`,[rest[0]]);
    return q.rows;
  }
  throw new Error(usage);
}

if (process.argv[1]?.endsWith('/non-production-test-grants.js')) {
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  runGrantCommand(pool,process.argv.slice(2)).then(result=>{
    process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'grant command failed'}\n`);process.exitCode=1;})
    .finally(()=>pool.end());
}
