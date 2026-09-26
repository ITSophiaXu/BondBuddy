import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { Static } from '@sinclair/typebox';
import { schemas, RECOVERY_POLICY as policy, RECOVERY_ROLE, RECOVERY_EVENT_TYPES } from '@bondbuddy/contracts';
import { checkPassword, clearCookies, json, origin, passwordOptions, passwordValid, session, type AuthConfig } from './auth.js';
import { date, digest, missing, Problem, transaction, uid } from './data.js';

type Input<K extends keyof typeof schemas> = Static<(typeof schemas)[K]>;
const invalid = () => new Problem(400,'CHALLENGE_INVALID','Authorization is invalid or expired');
const stale = () => new Problem(409,'INPUT_REVISION_CONFLICT','Recovery request changed; start again');
const pid = (r:FastifyRequest,key:string) => (r.params as Record<string,string>)[key];
const secret = () => randomBytes(32).toString('base64url');
const event = (c:PoolClient,user:string,type:typeof RECOVERY_EVENT_TYPES[number],ref:string,actor=user) => c.query(
  "INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'user',$2,$3,$4)",
  [uid(),user,type,{recovery_ref:ref,actor_id:actor}]);
const mask = (text:string) => text.length>4 ? `${text.slice(0,2)}***${text.slice(-2)}` : '***';
const invalidIds = (value:string) => !/^[A-Za-z0-9_-]{1,128}$/.test(value);

export function installAccountRecovery(app:FastifyInstance,config:AuthConfig) {
  const db=config.pool;
  async function ready() {
    if(!config.supportContact)return false;
    return !!(await db.query("SELECT 1 FROM bb_operator_grants g JOIN bb_users u ON u.id=g.user_id WHERE g.role=$1 AND g.revoked_at IS NULL AND u.status='active' LIMIT 1",[RECOVERY_ROLE])).rowCount;
  }
  async function requireReady() {if(!await ready())throw new Problem(503,'CAPABILITY_NOT_READY','Recovery support is not configured');}
  // Recovery budgets never increment login/password failure counters or lock a user's account.
  async function rate(keys:Array<[string,number]>) {
    const allowed=await transaction(db,async c=>{
      for(const [key,max] of keys){
        const q=await c.query(`INSERT INTO bb_recovery_limits(key_hash,started_at,attempts) VALUES($1,clock_timestamp(),1)
          ON CONFLICT(key_hash) DO UPDATE SET started_at=CASE WHEN bb_recovery_limits.started_at<clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE bb_recovery_limits.started_at END,
          attempts=CASE WHEN bb_recovery_limits.started_at<clock_timestamp()-interval '15 minutes' THEN 1 ELSE bb_recovery_limits.attempts+1 END RETURNING attempts`,[digest(key)]);
        if(q.rows[0].attempts>max)return false;
      }return true;
    });
    if(!allowed)throw new Problem(429,'RATE_LIMITED','Please wait before trying again');
  }
  async function lockUser(c:PoolClient,id:string) {
    await c.query("SELECT id FROM bb_users WHERE id=$1 AND status='active' FOR UPDATE",[id]);
    const q=await c.query("SELECT u.id,u.username,c.password_hash FROM bb_users u JOIN bb_password_credentials c ON c.user_id=u.id WHERE u.id=$1 AND u.status='active'",[id]);
    if(!q.rows[0]?.username)throw missing();return q.rows[0];
  }
  async function validSession(c:PoolClient,user:string,id:string) {
    if(!(await c.query('SELECT 1 FROM bb_auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND access_expires_at>clock_timestamp() AND refresh_expires_at>clock_timestamp() FOR SHARE',[id,user])).rowCount)
      throw new Problem(401,'UNAUTHENTICATED','Session required');
  }
  async function grant(c:PoolClient,actor:string) {
    if(!(await c.query("SELECT g.id FROM bb_operator_grants g JOIN bb_users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.role=$2 AND g.revoked_at IS NULL AND u.status='active' FOR SHARE OF g",[actor,RECOVERY_ROLE])).rowCount)throw missing();
  }
  async function account(user:string) {
    const q=await db.query("SELECT * FROM bb_recovery_channels WHERE user_id=$1 AND (state='verified' OR (state='pending' AND expires_at>clock_timestamp())) ORDER BY requested_at DESC",[user]);
    const dto=(r:any)=>r ? {binding_id:r.id,kind:r.kind,contact_masked:mask(r.contact),verified_at:r.verified_at?date(r.verified_at):null,
      expires_at:r.state==='pending'?date(r.code_expires_at??r.expires_at):null,code_issued:!!r.code_hash}:null;
    const eligible=!!(await db.query('SELECT 1 FROM bb_password_credentials WHERE user_id=$1',[user])).rowCount;
    return {enabled:eligible && await ready(),support_operator:!!(await db.query('SELECT 1 FROM bb_operator_grants WHERE user_id=$1 AND role=$2 AND revoked_at IS NULL',[user,RECOVERY_ROLE])).rowCount,
      current:dto(q.rows.find(r=>r.state==='verified')),pending:dto(q.rows.find(r=>r.state==='pending'))};
  }
  function response<K extends keyof typeof schemas>(key:K){return {200:schemas[key]};}
  const publicJson=(r:FastifyRequest)=>{origin(r,config.allowedOrigin);json(r);};
  app.addHook('onSend',async(request,reply,payload)=>{
    if(request.routeOptions.url?.includes('recovery'))reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
    return payload;
  });
  app.get('/api/v1/auth/recovery/info',{schema:{response:response('RecoveryInfoResponse')}},async()=>({enabled:await ready(),support_contact:config.supportContact??null,link_minutes:policy.linkMinutes}));
  app.get('/api/v1/account/recovery',{schema:{response:response('RecoveryAccountResponse')}},async r=>account((await session(r,config)).userId));
  app.post('/api/v1/account/recovery/bindings',{schema:{body:schemas.RecoveryBindingRequest,response:response('RecoveryBindingResponse')}},async r=>{
    const p=await session(r,config,true);await requireReady();
    const b=r.body as Input<'RecoveryBindingRequest'>;
    const contact=b.contact.trim();
    if(contact.length<3 || (b.kind==='email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)))throw new Problem(422,'VALIDATION_FAILED','Check the contact address');
    await rate([[`bind:${p.userId}`,10]]);
    const result=await transaction(db,async c=>{
      const u=await lockUser(c,p.userId);await validSession(c,p.userId,p.sessionId);
      if(await checkPassword(c,u.username,b.current_password,r.ip)!==p.userId)return null;
      await c.query("UPDATE bb_recovery_channels SET state='revoked',contact=NULL,code_hash=NULL WHERE user_id=$1 AND state='pending'",[p.userId]);
      const id=uid();const q=await c.query(`INSERT INTO bb_recovery_channels(id,user_id,kind,contact,state,credential_digest,expires_at)
        VALUES($1,$2,$3,$4,'pending',$5,clock_timestamp()+$6*interval '1 hour') RETURNING expires_at`,[id,p.userId,b.kind,contact,digest(u.password_hash),policy.bindingRequestHours]);
      await event(c,p.userId,'recovery.binding_requested',id);
      return {binding_id:id,status:'pending' as const,expires_at:date(q.rows[0].expires_at)};
    });
    if(!result)throw new Problem(403,'PASSWORD_INVALID','Current password is incorrect');return result;
  });
  app.post('/api/v1/account/recovery/bindings/:binding_id/confirm',{schema:{body:schemas.RecoveryConfirmRequest,response:response('RecoveryAccountResponse')}},async r=>{
    const p=await session(r,config,true);await requireReady();const id=pid(r,'binding_id');
    await rate([[`confirm:${p.userId}:${id}`,5]]);
    const ok=await transaction(db,async c=>{
      const u=await lockUser(c,p.userId);await validSession(c,p.userId,p.sessionId);
      const q=await c.query("SELECT * FROM bb_recovery_channels WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>clock_timestamp() AND code_expires_at>clock_timestamp() FOR UPDATE",[id,p.userId]);
      const b=q.rows[0];if(!b)throw invalid();
      if(b.credential_digest.trim()!==digest(u.password_hash) || b.code_hash?.trim()!==digest((r.body as Input<'RecoveryConfirmRequest'>).code)){
        await event(c,p.userId,'recovery.binding_rejected',id);return false;
      }
      await c.query("UPDATE bb_recovery_channels SET state='revoked',contact=NULL,code_hash=NULL WHERE user_id=$1 AND state='verified'",[p.userId]);
      await c.query("UPDATE bb_recovery_channels SET state='verified',verified_at=clock_timestamp(),code_hash=NULL,code_expires_at=NULL WHERE id=$1",[id]);
      await c.query("UPDATE bb_recovery_tickets SET state='closed',token_hash=NULL WHERE (user_id=$1 OR subject_hash=$2) AND state IN ('open','issued')",[p.userId,digest(u.username)]);
      await event(c,p.userId,'recovery.binding_confirmed',id);return true;
    });
    if(!ok)throw invalid();return account(p.userId);
  });
  app.post('/api/v1/auth/recovery/requests',{schema:{body:schemas.RecoveryTicketRequest,response:response('RecoveryTicketResponse')}},async r=>{
    publicJson(r);await requireReady();const name=(r.body as Input<'RecoveryTicketRequest'>).username.toLowerCase();
    await rate([[`request-source:${r.ip}`,30],[`request-name:${name}`,10]]);
    const id=await transaction(db,async c=>{
      // Same deduplication path for known, unknown and unbound accounts: no existence oracle.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`recovery:${name}`]);
      await c.query("SELECT id FROM bb_users WHERE username=$1 AND status='active' FOR UPDATE",[name]);
      const subject=digest(name);
      await c.query("UPDATE bb_recovery_tickets SET state='closed',token_hash=NULL WHERE subject_hash=$1 AND state IN ('open','issued') AND expires_at<=clock_timestamp()",[subject]);
      const old=await c.query("SELECT id FROM bb_recovery_tickets WHERE subject_hash=$1 AND state IN ('open','issued')",[subject]);
      if(old.rows[0])return old.rows[0].id;
      const q=await c.query(`SELECT u.id,c.password_hash,b.id AS binding FROM bb_users u
        JOIN bb_password_credentials c ON c.user_id=u.id LEFT JOIN bb_recovery_channels b ON b.user_id=u.id AND b.state='verified'
        WHERE u.username=$1 AND u.status='active'`,[name]);
      const u=q.rows[0],id=uid();
      await c.query(`INSERT INTO bb_recovery_tickets(id,subject_hash,user_id,binding_id,credential_digest,state,requested_at,expires_at)
        VALUES($1,$2,$3,$4,$5,'open',clock_timestamp(),clock_timestamp()+$6*interval '1 hour')`,[id,subject,u?.id??null,u?.binding??null,u?digest(u.password_hash):null,policy.ticketHours]);
      if(u)await event(c,u.id,'recovery.ticket_created',id);return id;
    });
    return {ticket_id:id,status:'received'};
  });
  // Operators only receive records by an exact user-supplied reference, never a public account search.
  async function supportBinding(r:FastifyRequest,issue:boolean) {
    const p=await session(r,config,issue);const id=pid(r,'binding_id');if(invalidIds(id))throw missing();
    if(issue)await rate([[`operator-code:${p.userId}:${id}`,5]]);
    return transaction(db,async c=>{
      await grant(c,p.userId);
      const found=await c.query('SELECT user_id FROM bb_recovery_channels WHERE id=$1',[id]);if(!found.rows[0])throw missing();
      const u=await lockUser(c,found.rows[0].user_id);
      const q=await c.query("SELECT * FROM bb_recovery_channels WHERE id=$1 AND state='pending' AND expires_at>clock_timestamp() FOR UPDATE",[id]);
      const b=q.rows[0];if(!b || b.credential_digest.trim()!==digest(u.password_hash))throw missing();
      await event(c,u.id,issue?'recovery.binding_code_issued':'recovery.binding_viewed',id,p.userId);
      if(!issue)return {binding_id:id,username:u.username,kind:b.kind,contact:b.contact,requested_at:date(b.requested_at)};
      const code=randomBytes(9).toString('base64url');
      const changed=await c.query("UPDATE bb_recovery_channels SET code_hash=$2,code_expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 minute') WHERE id=$1 RETURNING code_expires_at",[id,digest(code),policy.linkMinutes]);
      return {code,contact:b.contact,kind:b.kind,expires_at:date(changed.rows[0].code_expires_at)};
    });
  }
  app.get('/api/v1/admin/account-recovery/bindings/:binding_id',{schema:{response:response('RecoverySupportBindingResponse')}},r=>supportBinding(r,false));
  app.post('/api/v1/admin/account-recovery/bindings/:binding_id/code',{schema:{response:response('RecoverySupportCodeResponse')}},async r=>{await requireReady();return supportBinding(r,true);});
  async function supportTicket(r:FastifyRequest,issue:boolean) {
    const p=await session(r,config,issue);const id=pid(r,'ticket_id');if(invalidIds(id))throw missing();
    if(issue)await rate([[`operator-link:${p.userId}:${id}`,5]]);
    return transaction(db,async c=>{
      await grant(c,p.userId);
      const found=await c.query('SELECT user_id FROM bb_recovery_tickets WHERE id=$1',[id]);if(!found.rows[0]?.user_id)throw missing();
      const u=await lockUser(c,found.rows[0].user_id);
      const q=await c.query(`SELECT t.*,b.kind,b.contact,b.verified_at FROM bb_recovery_tickets t
        JOIN bb_recovery_channels b ON b.id=t.binding_id AND b.user_id=t.user_id AND b.state='verified'
        WHERE t.id=$1 AND t.state IN ('open','issued','completed') AND (t.expires_at>clock_timestamp() OR t.state='completed')
        AND b.verified_at<=t.requested_at FOR UPDATE OF t`,[id]);
      const t=q.rows[0];if(!t || (t.state!=='completed' && t.credential_digest.trim()!==digest(u.password_hash)))throw missing();
      if(!issue){await event(c,u.id,'recovery.ticket_viewed',id,p.userId);return {ticket_id:id,username:u.username,binding_id:t.binding_id,kind:t.kind,contact:t.contact,verified_at:date(t.verified_at),requested_at:date(t.requested_at),status:t.state};}
      const b=r.body as Input<'RecoveryIssueRequest'>;
      if(t.state==='completed' || b.binding_id!==t.binding_id || !b.confirmed_original_channel)throw stale();
      const token=secret();
      const result=await c.query(`UPDATE bb_recovery_tickets SET state='issued',token_hash=$2,issued_by=$3,confirmed_at=clock_timestamp(),
        token_expires_at=LEAST(expires_at,clock_timestamp()+$4*interval '1 minute') WHERE id=$1 RETURNING token_expires_at`,[id,digest(token),p.userId,policy.linkMinutes]);
      await event(c,u.id,'recovery.link_issued',id,p.userId);
      return {reset_path:`/#/reset/${token}`,expires_at:date(result.rows[0].token_expires_at)};
    });
  }
  app.get('/api/v1/admin/account-recovery/tickets/:ticket_id',{schema:{response:response('RecoverySupportTicketResponse')}},r=>supportTicket(r,false));
  app.post('/api/v1/admin/account-recovery/tickets/:ticket_id/issue',{schema:{body:schemas.RecoveryIssueRequest,response:response('RecoveryLinkResponse')}},async r=>{await requireReady();return supportTicket(r,true);});
  app.post('/api/v1/auth/recovery/reset',{schema:{body:schemas.RecoveryResetRequest,response:response('RecoveryResetResponse')}},async(r,reply)=>{
    publicJson(r);await requireReady();const b=r.body as Input<'RecoveryResetRequest'>;
    if(!passwordValid(b.new_password))throw new Problem(422,'VALIDATION_FAILED','Password must be 12–128 characters');
    await rate([[`reset-source:${r.ip}`,30],[`reset-token:${digest(b.token)}`,5]]);
    const result=await transaction(db,async c=>{
      const found=await c.query('SELECT user_id FROM bb_recovery_tickets WHERE token_hash=$1',[digest(b.token)]);if(!found.rows[0]?.user_id)throw invalid();
      let u;try{u=await lockUser(c,found.rows[0].user_id);}catch{throw invalid();}
      const q=await c.query(`SELECT t.* FROM bb_recovery_tickets t JOIN bb_recovery_channels b ON b.id=t.binding_id AND b.user_id=t.user_id AND b.state='verified'
        WHERE t.token_hash=$1 AND t.state='issued' AND t.token_expires_at>clock_timestamp() AND t.expires_at>clock_timestamp()
        AND b.verified_at<=t.requested_at FOR UPDATE OF t`,[digest(b.token)]);
      const t=q.rows[0];if(!t || t.credential_digest.trim()!==digest(u.password_hash))throw invalid();
      // A withdrawn support grant invalidates its outstanding links as well.
      if(!(await c.query("SELECT g.id FROM bb_operator_grants g JOIN bb_users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.role=$2 AND g.revoked_at IS NULL AND u.status='active' FOR SHARE OF g",[t.issued_by,RECOVERY_ROLE])).rowCount)throw invalid();
      const hash=await argon2.hash(b.new_password,passwordOptions);
      await c.query("UPDATE bb_recovery_tickets SET state='completed',completed_at=clock_timestamp(),token_hash=NULL,token_expires_at=NULL WHERE id=$1",[t.id]);
      await c.query('UPDATE bb_password_credentials SET password_hash=$2,updated_at=clock_timestamp() WHERE user_id=$1',[u.id,hash]);
      const revoked=await c.query("UPDATE bb_auth_sessions SET revoked_at=clock_timestamp(),revoked_reason='password_changed' WHERE user_id=$1 AND revoked_at IS NULL",[u.id]);
      await event(c,u.id,'recovery.password_reset',t.id,t.issued_by);
      return {status:'password_reset',sessions_revoked:revoked.rowCount??0};
    });
    return reply.header('set-cookie',clearCookies()).send(result);
  });
}
