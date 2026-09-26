import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reason = /^[a-z][a-z0-9_]{0,63}$/;

/** Direct database maintenance only. Never exposed through the public API. */
export async function changeIssuerReviewerGrant(pool: Pool, args: {
  action: 'grant' | 'revoke'; userId: string; actorId: string; reasonCode: string; basis: string;
}) {
  if (!id.test(args.userId) || !id.test(args.actorId) || args.userId === args.actorId ||
      !reason.test(args.reasonCode) || !args.basis.trim() || args.basis.length > 2048) throw new Error('Invalid grant audit arguments');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admin = await client.query(`SELECT 1 FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner
      JOIN pg_roles actor ON actor.rolname=current_user
      WHERE c.oid='bb_issuer_identity_reviewer_grants'::regclass
        AND (actor.rolsuper OR owner.rolname=current_user)`);
    if (!admin.rows[0]) throw new Error('Database table owner or superuser required');
    const users = await client.query("SELECT id FROM bb_users WHERE id=ANY($1::text[]) AND status='active'", [[args.userId,args.actorId]]);
    if (users.rows.length !== 2) throw new Error('Active reviewer and grant actor required');
    let grantId: string;
    if (args.action === 'grant') {
      grantId = randomUUID();
      await client.query(`INSERT INTO bb_issuer_identity_reviewer_grants
        (id,user_id,role,granted_by,reason_code,authorization_basis)
        VALUES($1,$2,'issuer_identity_reviewer',$3,$4,$5)`,
      [grantId,args.userId,args.actorId,args.reasonCode,args.basis.trim()]);
    } else {
      const updated = await client.query(`UPDATE bb_issuer_identity_reviewer_grants
        SET revoked_at=now(),revoked_by=$2,revocation_reason_code=$3,revocation_basis=$4
        WHERE user_id=$1 AND role='issuer_identity_reviewer' AND revoked_at IS NULL RETURNING id`,
      [args.userId,args.actorId,args.reasonCode,args.basis.trim()]);
      if (updated.rows.length !== 1) throw new Error('Active reviewer grant not found');
      grantId=String(updated.rows[0].id);
    }
    await client.query('COMMIT');
    return grantId;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action,userId,actorId,reasonCode,basis] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !['grant','revoke'].includes(action ?? '') || !userId || !actorId || !reasonCode || !basis)
    throw new Error('Usage: issuer-reviewer-grants grant|revoke USER_ID ACTOR_ID REASON_CODE BASIS (DATABASE_URL required)');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try { process.stdout.write(`${await changeIssuerReviewerGrant(pool,{action:action as 'grant'|'revoke',userId,actorId,reasonCode,basis})}\n`); }
  finally { await pool.end(); }
}
