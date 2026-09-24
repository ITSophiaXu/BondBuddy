import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { schemas } from '@bondbuddy/contracts';
import { digest, Problem, transaction, uid, unavailable } from './data.js';

export interface SmsTransport { send(phoneE164: string, code: string): Promise<void> }
export type AuthConfig = { pool: Pool; allowedOrigin?: string; otpKey?: string; termsVersion?: string; sms?: SmsTransport };
const randomToken = () => randomBytes(32).toString('base64url');
const accessMinutes = 15, refreshDays = 30;
const cookie = (name: string, value: string, age: number, httpOnly = true) => `${name}=${value}; Path=/; Secure; SameSite=Strict; ${httpOnly ? 'HttpOnly; ' : ''}Max-Age=${age}`;
const clearCookies = () => [cookie('bb_session','',0),cookie('bb_refresh','',0),cookie('bb_csrf','',0,false)];
function cookies(request: FastifyRequest): Record<string,string> {
  const result: Record<string,string> = {};
  for (const pair of (request.headers.cookie ?? '').split(';')) {
    const at = pair.indexOf('='); if(at > 0) result[pair.slice(0,at).trim()] = pair.slice(at+1).trim();
  }
  return result;
}
function same(a: string, b: string) {
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}
function phone(raw: string): string {
  const compact=raw.trim().replace(/[\s()-]/g,'');
  const value=/^1[3-9][0-9]{9}$/.test(compact) ? `+86${compact}` : compact;
  if(!/^\+861[3-9][0-9]{9}$/.test(value)) throw new Problem(422,'VALIDATION_FAILED','Unsupported phone format');
  return value;
}
function origin(request: FastifyRequest, allowed?: string) {
  if(!allowed || request.headers.origin!==allowed) throw new Problem(403,'CSRF_DENIED','Origin check failed');
}
function json(request: FastifyRequest) {
  if(!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Problem(403,'CSRF_DENIED','JSON request required');
}
function csrf(request: FastifyRequest, value: string) {
  const submitted=request.headers['x-bb-csrf'];
  const c=cookies(request).bb_csrf;
  if(typeof submitted!=='string' || !c || !same(c,submitted) || !same(digest(submitted),value.trim())) throw new Problem(403,'CSRF_DENIED','CSRF check failed');
}
function issueCookies(reply: FastifyReply, access: string, refresh: string, csrfToken: string, refreshExpiry: Date) {
  const refreshAge=Math.max(0,Math.floor((refreshExpiry.getTime()-Date.now())/1000));
  reply.header('set-cookie',[cookie('bb_session',access,accessMinutes*60),cookie('bb_refresh',refresh,refreshAge),cookie('bb_csrf',csrfToken,refreshAge,false)]);
  reply.header('cache-control','no-store');
}
export async function principal(request: FastifyRequest, config: AuthConfig) {
  const token=cookies(request).bb_session;
  if(!token) return null;
  const q=await config.pool.query("SELECT s.user_id,s.csrf_hash FROM bb_auth_sessions s JOIN bb_users u ON u.id=s.user_id WHERE s.access_hash=$1 AND s.access_expires_at>now() AND s.refresh_expires_at>now() AND s.revoked_at IS NULL AND u.status='active'",[digest(token)]);
  const row=q.rows[0]; if(!row)return null;
  let csrfVerified=false;
  if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
    try { csrf(request,row.csrf_hash); csrfVerified=true; } catch { /* owner checks and reports the denial */ }
  }
  return {userId:row.user_id as string,csrfVerified};
}
export function installAuth(app: FastifyInstance, config: AuthConfig) {
  const db=config.pool;
  app.post('/api/v1/auth/sms/challenges',{schema:{body:schemas.SmsChallengeRequest}},async(request,reply)=>{
    origin(request,config.allowedOrigin);json(request);
    if(!config.sms || !config.otpKey || !config.termsVersion)throw unavailable();
    const p=phone((request.body as {phone:string}).phone);
    const result=await transaction(db,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sms:${p}`]);
      const q=await client.query('SELECT issued_at FROM bb_auth_challenges WHERE phone_e164=$1 ORDER BY issued_at DESC LIMIT 5',[p]);
      const now=Date.now(), latest=q.rows[0]?.issued_at ? new Date(q.rows[0].issued_at).getTime() : 0;
      if(now-latest<60_000 || q.rows.filter(r=>now-new Date(r.issued_at).getTime()<3_600_000).length>=5) throw new Problem(429,'RATE_LIMITED','Please wait before requesting another code');
      await client.query('UPDATE bb_auth_challenges SET invalidated_at=now() WHERE phone_e164=$1 AND consumed_at IS NULL AND invalidated_at IS NULL',[p]);
      const id=uid(), code=String(randomInt(1_000_000)).padStart(6,'0');
      const codeHash=createHmac('sha256',config.otpKey!).update(`${id}:${code}`).digest('hex');
      const expires=new Date(now+300_000),retry=new Date(now+60_000);
      await client.query('INSERT INTO bb_auth_challenges(id,phone_e164,code_hash,expires_at) VALUES($1,$2,$3,$4)',[id,p,codeHash,expires]);
      try { await config.sms!.send(p,code); }
      catch { throw new Problem(503,'DATA_UNAVAILABLE','SMS delivery unavailable'); }
      return {challenge_id:id,expires_at:expires.toISOString(),retry_at:retry.toISOString()};
    });
    return reply.code(202).header('cache-control','no-store').send(result);
  });
  app.post('/api/v1/auth/sms/verify',{schema:{body:schemas.SmsVerifyRequest}},async(request,reply)=>{
    origin(request,config.allowedOrigin);json(request);
    if(!config.sms || !config.otpKey || !config.termsVersion)throw unavailable();
    const b=request.body as {challenge_id:string;code:string;accepted_terms_version:string};
    if(b.accepted_terms_version!==config.termsVersion)throw new Problem(422,'AGREEMENT_REQUIRED','Current agreement version required');
    if(!/^[0-9]{6}$/.test(b.code))throw new Problem(422,'VALIDATION_FAILED','Invalid code format');
    const result=await transaction(db,async client=>{
      const q=await client.query('SELECT * FROM bb_auth_challenges WHERE id=$1 FOR UPDATE',[b.challenge_id]);const ch=q.rows[0];
      if(!ch || ch.consumed_at || ch.invalidated_at || ch.attempts>=5 || new Date(ch.expires_at).getTime()<=Date.now())throw new Problem(401,'CHALLENGE_INVALID','Code invalid or expired');
      const expected=createHmac('sha256',config.otpKey!).update(`${b.challenge_id}:${b.code}`).digest('hex');
      if(!same(expected,ch.code_hash.trim())) {
        await client.query('UPDATE bb_auth_challenges SET attempts=attempts+1,invalidated_at=CASE WHEN attempts+1>=5 THEN now() ELSE NULL END WHERE id=$1',[b.challenge_id]);
        return null;
      }
      await client.query('UPDATE bb_auth_challenges SET consumed_at=now() WHERE id=$1',[b.challenge_id]);
      const user=await client.query("INSERT INTO bb_users(id,phone_e164) VALUES($1,$2) ON CONFLICT(phone_e164) DO UPDATE SET phone_e164=EXCLUDED.phone_e164 RETURNING id,status",[uid(),ch.phone_e164]);
      if(user.rows[0].status!=='active')throw new Problem(401,'UNAUTHENTICATED','Account unavailable');
      const userId=user.rows[0].id as string;
      await client.query('INSERT INTO bb_agreement_acceptances(user_id,terms_version,challenge_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[userId,b.accepted_terms_version,b.challenge_id]);
      const eventId=uid();
      const registered=await client.query('INSERT INTO bb_registration_events(user_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',[userId,eventId]);
      if(registered.rows[0])await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[eventId,userId,'user',userId,'user.registered',{user_id:userId,registration_event_id:eventId}]);
      const access=randomToken(),refresh=randomToken(),csrfToken=randomToken();
      const accessExpiry=new Date(Date.now()+accessMinutes*60_000),refreshExpiry=new Date(Date.now()+refreshDays*86_400_000);
      await client.query('INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),userId,digest(access),digest(refresh),digest(csrfToken),accessExpiry,refreshExpiry]);
      return {userId,access,refresh,csrfToken,accessExpiry,refreshExpiry};
    });
    if(!result)throw new Problem(401,'CHALLENGE_INVALID','Code invalid or expired');
    issueCookies(reply,result.access,result.refresh,result.csrfToken,result.refreshExpiry);
    return {user_id:result.userId,expires_at:result.accessExpiry.toISOString(),session_status:'active'};
  });
  app.post('/api/v1/auth/refresh',async(request,reply)=>{
    origin(request,config.allowedOrigin);
    const token=cookies(request).bb_refresh;if(!token)throw new Problem(401,'UNAUTHENTICATED','Session required');
    const result=await transaction(db,async client=>{
      const q=await client.query("SELECT s.* FROM bb_auth_sessions s JOIN bb_users u ON u.id=s.user_id WHERE s.refresh_hash=$1 AND s.refresh_expires_at>now() AND s.revoked_at IS NULL AND u.status='active' FOR UPDATE OF s",[digest(token)]);
      const s=q.rows[0];if(!s)throw new Problem(401,'UNAUTHENTICATED','Session required');csrf(request,s.csrf_hash);
      const access=randomToken(),refresh=randomToken(),csrfToken=randomToken(),accessExpiry=new Date(Date.now()+accessMinutes*60_000);
      await client.query('UPDATE bb_auth_sessions SET access_hash=$2,refresh_hash=$3,csrf_hash=$4,access_expires_at=$5 WHERE id=$1',[s.id,digest(access),digest(refresh),digest(csrfToken),accessExpiry]);
      return {userId:s.user_id as string,access,refresh,csrfToken,accessExpiry,refreshExpiry:new Date(s.refresh_expires_at)};
    });
    issueCookies(reply,result.access,result.refresh,result.csrfToken,result.refreshExpiry);
    return {user_id:result.userId,expires_at:result.accessExpiry.toISOString(),session_status:'active'};
  });
  app.post('/api/v1/auth/logout',async(request,reply)=>{
    origin(request,config.allowedOrigin);
    const c=cookies(request),token=c.bb_refresh;if(!token)throw new Problem(401,'UNAUTHENTICATED','Session required');
    await transaction(db,async client=>{
      const q=await client.query('SELECT id,csrf_hash FROM bb_auth_sessions WHERE refresh_hash=$1 AND revoked_at IS NULL FOR UPDATE',[digest(token)]);
      if(!q.rows[0])throw new Problem(401,'UNAUTHENTICATED','Session required');csrf(request,q.rows[0].csrf_hash);
      await client.query('UPDATE bb_auth_sessions SET revoked_at=now() WHERE id=$1',[q.rows[0].id]);
    });
    return reply.code(204).header('set-cookie',clearCookies()).header('cache-control','no-store').send();
  });
  app.get('/api/v1/me',async request=>{
    const p=await principal(request,config);if(!p)throw new Problem(401,'UNAUTHENTICATED','Session required');
    return {user_id:p.userId,session_status:'active'};
  });
}
