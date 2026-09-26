import type { Pool } from 'pg';
import { transaction } from './data.js';
/** Called by the existing scheduled deletion lifecycle. Keep only bounded recovery metadata. */
export async function purgeAccountRecovery(pool:Pool,owner?:string) {
  return transaction(pool,async c=>{
    const channels=await c.query("UPDATE bb_recovery_channels SET state='revoked',contact=NULL,code_hash=NULL,code_expires_at=NULL WHERE state='pending' AND expires_at<=clock_timestamp() AND ($1::text IS NULL OR user_id=$1)",[owner??null]);
    await c.query("UPDATE bb_recovery_channels SET code_hash=NULL,code_expires_at=NULL WHERE code_expires_at<=clock_timestamp() AND ($1::text IS NULL OR user_id=$1)",[owner??null]);
    const tickets=await c.query("UPDATE bb_recovery_tickets SET state='closed',token_hash=NULL,token_expires_at=NULL WHERE state IN ('open','issued') AND expires_at<=clock_timestamp() AND ($1::text IS NULL OR user_id=$1)",[owner??null]);
    await c.query("DELETE FROM bb_recovery_tickets WHERE state IN ('closed','completed') AND requested_at<clock_timestamp()-interval '180 days' AND ($1::text IS NULL OR user_id=$1)",[owner??null]);
    await c.query("DELETE FROM bb_recovery_channels b WHERE b.state='revoked' AND b.requested_at<clock_timestamp()-interval '180 days' AND NOT EXISTS(SELECT 1 FROM bb_recovery_tickets t WHERE t.binding_id=b.id) AND ($1::text IS NULL OR b.user_id=$1)",[owner??null]);
    if(!owner)await c.query("DELETE FROM bb_recovery_limits WHERE started_at<clock_timestamp()-interval '1 day'");
    return {expiredChannels:channels.rowCount??0,expiredTickets:tickets.rowCount??0};
  });
}
