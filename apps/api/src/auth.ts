import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AGREEMENT_SUMMARY_PATH, AGREEMENT_TITLE, CLOSURE_RETAINED_RECORDS, RUN_STATES, schemas } from '@bondbuddy/contracts';
import { date, digest, missing, Problem, transaction, uid, unavailable } from './data.js';

export type AuthConfig = { pool: Pool; allowedOrigin?: string; termsVersion?: string; supportContact?: string };
const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummyHash = argon2.hash(randomBytes(32), passwordOptions);
const loginError = () => new Problem(401,'UNAUTHENTICATED','Invalid username or password');
// Re-authentication inside a live session must not look like session expiry to the browser.
const passwordError = () => new Problem(403,'PASSWORD_INVALID','Current password is incorrect');
const terminalRunStates = ['succeeded','failed','cancelled','rejected'];
const activeRunStates = RUN_STATES.filter(state => !terminalRunStates.includes(state));
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
// Shared by login and in-session re-authentication so both count toward the same account and account/source limits.
async function checkPassword(client: PoolClient, name: string, password: string, source: string) {
  const accountKey=limitKey(`account:${name}`), pairKey=limitKey(`pair:${name}:${source}`);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`login:${name}`]);
  const keys=[['account',accountKey,10],['account_source',pairKey,5]] as const;
  for(const [scope,key,maximum] of keys) {
    const limit=await client.query('SELECT failures,window_started_at FROM bb_password_login_limits WHERE scope=$1 AND key_hash=$2',[scope,key]);
    if(limit.rows[0] && Date.now()-new Date(limit.rows[0].window_started_at).getTime()<15*60_000 && limit.rows[0].failures>=maximum)
      throw new Problem(429,'RATE_LIMITED','Please wait before trying again');
  }
  const q=await client.query("SELECT u.id,c.password_hash FROM bb_users u JOIN bb_password_credentials c ON c.user_id=u.id WHERE u.username=$1 AND u.status='active'",[name]);
  const valid=await argon2.verify(q.rows[0]?.password_hash ?? await dummyHash,password);
  if(!valid || !q.rows[0]) {
    for(const [scope,key] of keys)await client.query(`INSERT INTO bb_password_login_limits(scope,key_hash,failures) VALUES($1,$2,1) ON CONFLICT(scope,key_hash) DO UPDATE SET failures=CASE WHEN bb_password_login_limits.window_started_at < now()-interval '15 minutes' THEN 1 ELSE bb_password_login_limits.failures+1 END,window_started_at=CASE WHEN bb_password_login_limits.window_started_at < now()-interval '15 minutes' THEN now() ELSE bb_password_login_limits.window_started_at END`,[scope,key]);
    return null;
  }
  for(const [scope,key] of keys)await client.query('DELETE FROM bb_password_login_limits WHERE scope=$1 AND key_hash=$2',[scope,key]);
  return q.rows[0].id as string;
}
const maskPhone = (phone: string | null) => phone ? `${phone.slice(0,-8)}****${phone.slice(-4)}` : null;
const outbox = (client: PoolClient, userId: string, type: string, payload: Record<string,unknown>) =>
  client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),userId,'user',userId,type,payload]);
async function closureState(client: Pool | PoolClient, userId: string) {
  const runs=await client.query('SELECT id,project_id,state FROM bb_runs WHERE owner_user_id=$1 AND state=ANY($2) ORDER BY id LIMIT 100',[userId,activeRunStates]);
  const counts=await client.query(`SELECT
    (SELECT count(*)::int FROM bb_projects WHERE owner_user_id=$1 AND deleted_at IS NULL) AS projects,
    (SELECT count(*)::int FROM bb_material_versions WHERE owner_user_id=$1 AND deleted_at IS NULL) AS material_versions,
    (SELECT count(*)::int FROM bb_artifact_versions WHERE owner_user_id=$1 AND delivery_status='available') AS available_artifacts`,[userId]);
  return {active_runs:runs.rows.map(r=>({run_id:r.id as string,project_id:r.project_id as string,state:r.state as string})),...counts.rows[0] as {projects:number;material_versions:number;available_artifacts:number}};
}
function issueCookies(reply: FastifyReply, access: string, refresh: string, csrfToken: string, refreshExpiry: Date) {
  const refreshAge=Math.max(0,Math.floor((refreshExpiry.getTime()-Date.now())/1000));
  reply.header('set-cookie',[cookie('bb_session',access,accessMinutes*60),cookie('bb_refresh',refresh,refreshAge),cookie('bb_csrf',csrfToken,refreshAge,false)]);
  reply.header('cache-control','no-store');
}
export async function principal(request: FastifyRequest, config: AuthConfig) {
  const token=cookies(request).bb_session;
  if(!token) return null;
  const q=await config.pool.query("SELECT s.id,s.user_id,s.csrf_hash FROM bb_auth_sessions s JOIN bb_users u ON u.id=s.user_id WHERE s.access_hash=$1 AND s.access_expires_at>now() AND s.refresh_expires_at>now() AND s.revoked_at IS NULL AND u.status='active'",[digest(token)]);
  const row=q.rows[0]; if(!row)return null;
  let csrfVerified=false;
  if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
    try { csrf(request,row.csrf_hash); csrfVerified=true; } catch { /* owner checks and reports the denial */ }
  }
  return {userId:row.user_id as string,csrfVerified,sessionId:row.id as string};
}
async function session(request: FastifyRequest, config: AuthConfig, mutation = false) {
  const p=await principal(request,config);if(!p)throw new Problem(401,'UNAUTHENTICATED','Session required');
  if(mutation && (!p.csrfVerified || !config.allowedOrigin || request.headers.origin!==config.allowedOrigin)) throw new Problem(403,'CSRF_DENIED','CSRF or Origin check failed');
  return p;
}
export function installAuth(app: FastifyInstance, config: AuthConfig) {
  const db=config.pool;
  async function newSession(client: import('pg').PoolClient, userId: string) {
    const access=randomToken(),refresh=randomToken(),csrfToken=randomToken();
    const accessExpiry=new Date(Date.now()+accessMinutes*60_000),refreshExpiry=new Date(Date.now()+refreshDays*86_400_000);
    await client.query('INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),userId,digest(access),digest(refresh),digest(csrfToken),accessExpiry,refreshExpiry]);
    return {userId,access,refresh,csrfToken,accessExpiry,refreshExpiry};
  }
  // Public: the register form must show and submit exactly this version. No version means registration is closed.
  app.get('/api/v1/auth/agreement',{schema:{response:{200:schemas.AgreementResponse}}},async(_request,reply)=>{
    if(!config.termsVersion)throw new Problem(503,'CAPABILITY_NOT_READY','Registration agreement is not configured');
    return reply.header('cache-control','public, max-age=60').send({terms_version:config.termsVersion,title:AGREEMENT_TITLE,summary_url_or_path:AGREEMENT_SUMMARY_PATH,support_contact:config.supportContact || null});
  });
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
    const result=await transaction(db,async client=>{
      const userId=await checkPassword(client,name,b.password,source);
      return userId ? newSession(client,userId) : null;
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
      await client.query('UPDATE bb_auth_sessions SET access_hash=$2,refresh_hash=$3,csrf_hash=$4,access_expires_at=$5,last_refreshed_at=now() WHERE id=$1',[s.id,digest(access),digest(refresh),digest(csrfToken),accessExpiry]);
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
      await client.query("UPDATE bb_auth_sessions SET revoked_at=now(),revoked_reason='logout' WHERE id=$1",[q.rows[0].id]);
    });
    return reply.code(204).header('set-cookie',clearCookies()).header('cache-control','no-store').send();
  });
  app.get('/api/v1/me',async request=>{
    const p=await principal(request,config);if(!p)throw new Problem(401,'UNAUTHENTICATED','Session required');
    return {user_id:p.userId,session_status:'active'};
  });
  app.get('/api/v1/account',async(request,reply)=>{
    const p=await session(request,config);
    const q=await db.query(`SELECT u.id,u.username,u.phone_e164,u.created_at,c.updated_at AS password_updated_at,
      (SELECT a.terms_version FROM bb_agreement_acceptances a WHERE a.user_id=u.id ORDER BY a.accepted_at DESC LIMIT 1) AS accepted_terms_version
      FROM bb_users u LEFT JOIN bb_password_credentials c ON c.user_id=u.id WHERE u.id=$1`,[p.userId]);
    const u=q.rows[0];
    reply.header('cache-control','no-store');
    return {user_id:u.id,username:u.username,phone_masked:maskPhone(u.phone_e164),status:'active',created_at:date(u.created_at),accepted_terms_version:u.accepted_terms_version ?? null,current_terms_version:config.termsVersion ?? null,password_updated_at:u.password_updated_at ? date(u.password_updated_at) : null,self_service_recovery:'unavailable',support_contact:config.supportContact ?? null};
  });
  app.get('/api/v1/account/sessions',async(request,reply)=>{
    const p=await session(request,config);
    const q=await db.query('SELECT id,created_at,last_refreshed_at,refresh_expires_at FROM bb_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND refresh_expires_at>now() ORDER BY created_at DESC,id LIMIT 100',[p.userId]);
    reply.header('cache-control','no-store');
    return {items:q.rows.map(s=>({session_id:s.id,current:s.id===p.sessionId,created_at:date(s.created_at),last_refreshed_at:s.last_refreshed_at ? date(s.last_refreshed_at) : null,refresh_expires_at:date(s.refresh_expires_at)}))};
  });
  app.delete('/api/v1/account/sessions/:session_id',async(request,reply)=>{
    const p=await session(request,config,true),target=(request.params as {session_id:string}).session_id;
    await transaction(db,async client=>{
      const q=await client.query('SELECT revoked_at FROM bb_auth_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[target,p.userId]);
      if(!q.rows[0])throw missing(); // Unknown and foreign sessions share 404.
      if(q.rows[0].revoked_at)return;
      await client.query("UPDATE bb_auth_sessions SET revoked_at=now(),revoked_reason='user_revoked' WHERE id=$1",[target]);
      await outbox(client,p.userId,'session.revoked',{user_id:p.userId,session_id:target,reason:'user_revoked'});
    });
    if(target===p.sessionId)reply.header('set-cookie',clearCookies());
    return reply.code(204).header('cache-control','no-store').send();
  });
  app.post('/api/v1/account/sessions/revoke-others',async request=>{
    const p=await session(request,config,true);
    return transaction(db,async client=>{
      const q=await client.query("UPDATE bb_auth_sessions SET revoked_at=now(),revoked_reason='user_revoked' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",[p.userId,p.sessionId]);
      if(q.rowCount)await outbox(client,p.userId,'session.revoked',{user_id:p.userId,reason:'user_revoked',sessions:q.rowCount});
      return {revoked_sessions:q.rowCount ?? 0};
    });
  });
  app.post('/api/v1/account/password',{schema:{body:schemas.PasswordChangeRequest}},async request=>{
    const p=await session(request,config,true);json(request);
    const b=request.body as {current_password:string;new_password:string};
    if(Buffer.byteLength(b.current_password,'utf8')>512)throw passwordError();
    if(!passwordValid(b.new_password))throw new Problem(422,'VALIDATION_FAILED','Password must be 12–128 characters without control characters');
    const hash=await argon2.hash(b.new_password,passwordOptions);
    const result=await transaction(db,async client=>{
      const u=await client.query("SELECT username FROM bb_users WHERE id=$1 AND status='active' FOR UPDATE",[p.userId]);
      // Legacy phone identities have no password to prove, so there is no path from a new credential to their data.
      if(!u.rows[0]?.username || await checkPassword(client,u.rows[0].username,b.current_password,request.ip)!==p.userId)return null;
      await client.query('UPDATE bb_password_credentials SET password_hash=$2,updated_at=now() WHERE user_id=$1',[p.userId,hash]);
      const revoked=await client.query("UPDATE bb_auth_sessions SET revoked_at=now(),revoked_reason='password_changed' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",[p.userId,p.sessionId]);
      await outbox(client,p.userId,'user.password_changed',{user_id:p.userId,revoked_sessions:revoked.rowCount ?? 0});
      return {revoked_sessions:revoked.rowCount ?? 0};
    });
    if(!result)throw passwordError();
    return result;
  });
  app.get('/api/v1/account/closure',async(request,reply)=>{
    const p=await session(request,config);
    const state=await closureState(db,p.userId);
    reply.header('cache-control','no-store');
    return {can_close:state.active_runs.length===0,...state,balance_status:'not_applicable_m1',retained_records:[...CLOSURE_RETAINED_RECORDS],local_exports:'not_affected'};
  });
  app.post('/api/v1/account/closure',{schema:{body:schemas.AccountClosureRequest}},async(request,reply)=>{
    const p=await session(request,config,true);json(request);
    const b=request.body as {password:string;confirm_username:string};
    if(Buffer.byteLength(b.password,'utf8')>512)throw passwordError();
    const result=await transaction(db,async client=>{
      // Holding the user row blocks the closed-owner insert triggers until this transaction commits.
      const u=await client.query("SELECT username FROM bb_users WHERE id=$1 AND status='active' FOR UPDATE",[p.userId]);
      const name=u.rows[0]?.username as string|undefined;
      if(!name)return null;
      if(b.confirm_username.toLowerCase()!==name)throw new Problem(422,'VALIDATION_FAILED','Username confirmation does not match');
      if(await checkPassword(client,name,b.password,request.ip)!==p.userId)return null;
      const state=await closureState(client,p.userId);
      if(state.active_runs.length)throw new Problem(409,'ACCOUNT_CLOSURE_BLOCKED','Cancel or finish active runs before closing the account');
      // Material soft deletion creates storage tombstones (0006); the lifecycle job purges bytes that no snapshot pins.
      const materials=await client.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND deleted_at IS NULL',[p.userId]);
      const projects=await client.query('UPDATE bb_projects SET deleted_at=now(),updated_at=now() WHERE owner_user_id=$1 AND deleted_at IS NULL',[p.userId]);
      const artifacts=await client.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE owner_user_id=$1 AND delivery_status<>'revoked'",[p.userId]);
      await client.query('DELETE FROM bb_artifact_download_grants WHERE owner_user_id=$1',[p.userId]);
      const sessions=await client.query("UPDATE bb_auth_sessions SET revoked_at=now(),revoked_reason='account_closed' WHERE user_id=$1 AND revoked_at IS NULL",[p.userId]);
      await client.query('DELETE FROM bb_password_credentials WHERE user_id=$1',[p.userId]);
      const closed=await client.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1 RETURNING closed_at",[p.userId]);
      const closureId=uid(),counts={projects_deleted:projects.rowCount ?? 0,material_versions_deleted:materials.rowCount ?? 0,artifacts_revoked:artifacts.rowCount ?? 0,sessions_revoked:sessions.rowCount ?? 0};
      await client.query("INSERT INTO bb_account_closures(id,user_id,closed_at,projects_deleted,material_versions_deleted,artifacts_revoked,sessions_revoked,balance_status) VALUES($1,$2,$3,$4,$5,$6,$7,'not_applicable_m1')",[closureId,p.userId,closed.rows[0].closed_at,counts.projects_deleted,counts.material_versions_deleted,counts.artifacts_revoked,counts.sessions_revoked]);
      await outbox(client,p.userId,'user.closed',{user_id:p.userId,closure_id:closureId,...counts});
      return {closure_id:closureId,status:'closed',closed_at:date(closed.rows[0].closed_at),...counts,cloud_content:'access_removed_purge_scheduled',balance_status:'not_applicable_m1',retained_records:[...CLOSURE_RETAINED_RECORDS],local_exports:'not_affected'};
    });
    if(!result)throw passwordError();
    return reply.header('set-cookie',clearCookies()).header('cache-control','no-store').send(result);
  });
}
