import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { schemas } from '@bondbuddy/contracts';
import { digest, Problem, transaction, uid, unavailable } from './data.js';

export type AuthConfig = { pool: Pool; allowedOrigin?: string; termsVersion?: string };
const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummyHash = argon2.hash(randomBytes(32), passwordOptions);
const loginError = () => new Problem(401,'UNAUTHENTICATED','Invalid username or password');
function username(raw: string) {
  const value=raw.toLowerCase();
  if(!/^[a-z][a-z0-9_]{2,31}$/.test(value)) throw new Problem(422,'VALIDATION_FAILED','Username must be 3–32 ASCII letters, digits or underscores and start with a letter');
  return value;
}
function passwordValid(value: string) {
  return typeof value==='string' && value.length>=12 && value.length<=128 && Buffer.byteLength(value,'utf8')<=512 && !/[\u0000-\u001f\u007f]/.test(value);
}
const limitKey=(value:string)=>createHash('sha256').update(value).digest('hex');
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
  async function newSession(client: import('pg').PoolClient, userId: string) {
    const access=randomToken(),refresh=randomToken(),csrfToken=randomToken();
    const accessExpiry=new Date(Date.now()+accessMinutes*60_000),refreshExpiry=new Date(Date.now()+refreshDays*86_400_000);
    await client.query('INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),userId,digest(access),digest(refresh),digest(csrfToken),accessExpiry,refreshExpiry]);
    return {userId,access,refresh,csrfToken,accessExpiry,refreshExpiry};
  }
  app.post('/api/v1/auth/register',{schema:{body:schemas.RegisterRequest}},async(request,reply)=>{
    origin(request,config.allowedOrigin);json(request);
    if(!config.termsVersion)throw unavailable();
    const b=request.body as {username:string;password:string;accepted_terms_version:string};
    const name=username(b.username);
    if(!passwordValid(b.password))throw new Problem(422,'VALIDATION_FAILED','Password must be 12–128 characters without control characters');
    if(b.accepted_terms_version!==config.termsVersion)throw new Problem(422,'AGREEMENT_REQUIRED','Current agreement version required');
    const hash=await argon2.hash(b.password,passwordOptions);
    const result=await transaction(db,async client=>{
      const userId=uid(), eventId=uid();
      const inserted=await client.query('INSERT INTO bb_users(id,username) VALUES($1,$2) ON CONFLICT(username) DO NOTHING RETURNING id',[userId,name]);
      if(!inserted.rowCount)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Username unavailable');
      await client.query('INSERT INTO bb_password_credentials(user_id,password_hash) VALUES($1,$2)',[userId,hash]);
      await client.query('INSERT INTO bb_registration_events(user_id,event_id) VALUES($1,$2)',[userId,eventId]);
      await client.query('INSERT INTO bb_agreement_acceptances(user_id,terms_version,registration_event_id) VALUES($1,$2,$3)',[userId,b.accepted_terms_version,eventId]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[eventId,userId,'user',userId,'user.registered',{user_id:userId,registration_event_id:eventId}]);
      return newSession(client,userId);
    });
    issueCookies(reply,result.access,result.refresh,result.csrfToken,result.refreshExpiry);
    return reply.code(201).send({user_id:result.userId,expires_at:result.accessExpiry.toISOString(),session_status:'active'});
  });
  app.post('/api/v1/auth/login',{schema:{body:schemas.LoginRequest}},async(request,reply)=>{
    origin(request,config.allowedOrigin);json(request);
    const b=request.body as {username:string;password:string};
    const name=username(b.username);
    if(Buffer.byteLength(b.password,'utf8')>512)throw loginError();
    const source=request.ip; // Fastify's trusted remote address; never trust an arbitrary forwarded header.
    const accountKey=limitKey(`account:${name}`), pairKey=limitKey(`pair:${name}:${source}`);
    const result=await transaction(db,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`login:${name}`]);
      const keys=[['account',accountKey,10],['account_source',pairKey,5]] as const;
      for(const [scope,key,maximum] of keys) {
        const limit=await client.query('SELECT failures,window_started_at FROM bb_password_login_limits WHERE scope=$1 AND key_hash=$2',[scope,key]);
        if(limit.rows[0] && Date.now()-new Date(limit.rows[0].window_started_at).getTime()<15*60_000 && limit.rows[0].failures>=maximum)
          throw new Problem(429,'RATE_LIMITED','Please wait before trying again');
      }
      const q=await client.query("SELECT u.id,c.password_hash FROM bb_users u JOIN bb_password_credentials c ON c.user_id=u.id WHERE u.username=$1 AND u.status='active'",[name]);
      const valid=await argon2.verify(q.rows[0]?.password_hash ?? await dummyHash,b.password);
      if(!valid || !q.rows[0]) {
        for(const [scope,key] of keys)await client.query(`INSERT INTO bb_password_login_limits(scope,key_hash,failures) VALUES($1,$2,1) ON CONFLICT(scope,key_hash) DO UPDATE SET failures=CASE WHEN bb_password_login_limits.window_started_at < now()-interval '15 minutes' THEN 1 ELSE bb_password_login_limits.failures+1 END,window_started_at=CASE WHEN bb_password_login_limits.window_started_at < now()-interval '15 minutes' THEN now() ELSE bb_password_login_limits.window_started_at END`,[scope,key]);
        return null;
      }
      for(const [scope,key] of keys)await client.query('DELETE FROM bb_password_login_limits WHERE scope=$1 AND key_hash=$2',[scope,key]);
      return newSession(client,q.rows[0].id as string);
    });
    if(!result)throw loginError();
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
