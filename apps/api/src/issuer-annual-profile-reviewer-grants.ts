import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reason = /^[a-z][a-z0-9_]{0,63}$/;

/** Privileged database maintenance only; no public route creates reviewer grants. */
export async function changeIssuerAnnualProfileReviewerGrant(pool: Pool, args: {
  action: 'grant' | 'revoke'; userId: string; actorId: string; reasonCode: string; basis: string;
  ownerUserId: string; projectId: string;
}): Promise<string> {
  if (![args.userId,args.actorId,args.ownerUserId,args.projectId].every(value => id.test(value)) || args.userId === args.actorId ||
      !reason.test(args.reasonCode) || !args.basis.trim() || args.basis.length > 2048) throw new Error('Invalid grant audit arguments');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admin = await client.query(`SELECT 1 FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner
      JOIN pg_roles actor ON actor.rolname=current_user WHERE c.oid='bb_issuer_annual_profile_reviewer_grants'::regclass
        AND (actor.rolsuper OR owner.rolname=current_user)`);
    if (!admin.rows[0]) throw new Error('Database table owner or superuser required');
    const users = await client.query("SELECT id FROM bb_users WHERE id=ANY($1::text[]) AND status='active'", [[args.userId,args.actorId]]);
    if (users.rows.length !== 2) throw new Error('Active reviewer and grant actor required');
    let grantId: string;
    if (args.action === 'grant') {
      const project = await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL', [args.ownerUserId,args.projectId]);
      if (project.rows.length !== 1) throw new Error('Active owner/project scope required');
      grantId = randomUUID();
      await client.query(`INSERT INTO bb_issuer_annual_profile_reviewer_grants
        (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_annual_profile_reviewer',$3,$4,$5,$6,$7)`,
      [grantId,args.userId,args.actorId,args.reasonCode,args.basis.trim(),args.ownerUserId,args.projectId]);
    } else {
      const revoked = await client.query(`UPDATE bb_issuer_annual_profile_reviewer_grants SET revoked_at=now(),revoked_by=$4,
        revocation_reason_code=$5,revocation_basis=$6 WHERE user_id=$1 AND scope_owner_user_id=$2 AND scope_project_id=$3
          AND revoked_at IS NULL RETURNING id`, [args.userId,args.ownerUserId,args.projectId,args.actorId,args.reasonCode,args.basis.trim()]);
      if (revoked.rows.length !== 1) throw new Error('Active scoped annual profile reviewer grant not found');
      grantId = String(revoked.rows[0]!.id);
    }
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'project',$3,$4,$5::jsonb)`, [randomUUID(),args.ownerUserId,args.projectId,
      args.action==='grant'?'issuer.annual_profile.reviewer_grant_created':'issuer.annual_profile.reviewer_grant_revoked',
      JSON.stringify({reviewer_user_id:args.userId,reviewer_grant_id:grantId,actor_user_id:args.actorId,reason_code:args.reasonCode})]);
    await client.query('COMMIT');
    return grantId;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action,userId,actorId,reasonCode,basis,ownerUserId,projectId] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !['grant','revoke'].includes(action ?? '') || !userId || !actorId || !reasonCode || !basis || !ownerUserId || !projectId)
    throw new Error('Usage: issuer-annual-profile-reviewer-grants grant|revoke USER_ID ACTOR_ID REASON_CODE BASIS OWNER_USER_ID PROJECT_ID (DATABASE_URL required)');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { process.stdout.write(`${await changeIssuerAnnualProfileReviewerGrant(pool,{action:action as 'grant'|'revoke',userId,actorId,reasonCode,basis,ownerUserId,projectId})}\n`); }
  finally { await pool.end(); }
}
