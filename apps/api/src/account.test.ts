import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';

const origin='http://bondbuddy.test';
const connection=process.env.BB_TEST_DATABASE_URL;

test('account routes require a session and appear as implemented in OpenAPI',async()=>{
  const app=createServer({allowedOrigin:origin});try{
    assert.equal((await app.inject({method:'GET',url:'/api/v1/account'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/account/closure',headers:{origin},payload:{password:'x',confirm_username:'abc'}})).statusCode,401);
    const spec=(await app.inject('/openapi.json')).json();
    assert.match(spec.paths['/api/v1/account/closure'].post['x-implementation-status'],/implemented/);
    assert.equal(spec.paths['/api/v1/account/sessions/{session_id}'].delete.parameters.some((p:{name:string})=>p.name==='X-BB-CSRF'),true);
  }finally{await app.close();}
});

test('password change, session revocation and closure keep accounts isolated', {skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});
  const app=createServer({pool,allowedOrigin:origin,auth:{termsVersion:'synthetic-v1',supportContact:'synthetic-support'}});
  const jar=(response:any)=>Object.fromEntries((response.headers['set-cookie'] as string[]).map((v:string)=>v.split(';')[0].split('=')));
  const cookie=(c:Record<string,string>)=>Object.entries(c).map(([k,v])=>`${k}=${v}`).join('; ');
  const send=(method:string,url:string,payload?:unknown,c:Record<string,string>={},extra:Record<string,string>={})=>app.inject({method:method as any,url,headers:{origin,cookie:cookie(c),...(c.bb_csrf?{'x-bb-csrf':c.bb_csrf}:{}),...extra},payload:payload as any});
  const register=(username:string,password:string)=>send('POST','/api/v1/auth/register',{username,password,accepted_terms_version:'synthetic-v1'});
  const login=(username:string,password:string)=>send('POST','/api/v1/auth/login',{username,password});
  try{
    await pool.query('TRUNCATE bb_account_closures,bb_password_login_limits,bb_auth_sessions,bb_agreement_acceptances,bb_registration_events,bb_auth_challenges,bb_password_credentials,bb_users,bb_artifact_download_grants,bb_outbox,bb_run_events,bb_artifact_versions,bb_runs,bb_storage_tombstones,bb_material_versions,bb_uploads,bb_input_revisions,bb_projects RESTART IDENTITY CASCADE');
    const alicePwd='synthetic password for Alice 123',aliceNew='synthetic new password Alice 456',bobPwd='synthetic password for Bob 123';
    const a1=await register('alice_acct',alicePwd);assert.equal(a1.statusCode,201,a1.body);const ca1=jar(a1),alice=a1.json().user_id;
    const a2=await login('alice_acct',alicePwd);assert.equal(a2.statusCode,200,a2.body);const ca2=jar(a2);
    const b1=await register('bob_acct',bobPwd);assert.equal(b1.statusCode,201,b1.body);const cb1=jar(b1);

    const account=await send('GET','/api/v1/account',undefined,ca1);assert.equal(account.statusCode,200,account.body);
    assert.deepEqual({...account.json(),created_at:null,password_updated_at:null},{user_id:alice,username:'alice_acct',phone_masked:null,status:'active',created_at:null,accepted_terms_version:'synthetic-v1',current_terms_version:'synthetic-v1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:'synthetic-support'});
    await pool.query("INSERT INTO bb_users(id,phone_e164) VALUES('synthetic-legacy-phone','+8613800000009')");
    await pool.query("INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at) VALUES('synthetic-legacy-session','synthetic-legacy-phone',$1,$2,$3,now()+interval '15 minutes',now()+interval '1 day')",['1'.repeat(64),'2'.repeat(64),'3'.repeat(64)]);

    // Sessions: list only own, mark current, and foreign/unknown IDs share 404.
    const list=(await send('GET','/api/v1/account/sessions',undefined,ca1)).json().items;
    assert.equal(list.length,2);assert.equal(list.filter((s:any)=>s.current).length,1);
    const other=list.find((s:any)=>!s.current).session_id;
    const bobSessions=(await send('GET','/api/v1/account/sessions',undefined,cb1)).json().items;
    assert.equal(bobSessions.length,1);assert.equal(bobSessions.some((s:any)=>s.session_id===other),false);
    assert.equal((await send('DELETE',`/api/v1/account/sessions/${other}`,undefined,cb1)).statusCode,404,'Bob cannot revoke Alice session');
    assert.equal((await send('DELETE','/api/v1/account/sessions/synthetic-legacy-session',undefined,cb1)).statusCode,404);
    assert.equal((await send('DELETE',`/api/v1/account/sessions/${other}`,undefined,ca1,{'x-bb-csrf':'wrong'})).statusCode,403);
    assert.equal((await send('GET','/api/v1/me',undefined,ca2)).statusCode,200,'failed revocation leaves session active');
    assert.equal((await send('DELETE',`/api/v1/account/sessions/${other}`,undefined,ca1)).statusCode,204);
    assert.equal((await send('GET','/api/v1/me',undefined,ca2)).statusCode,401,'revoked session access token stops immediately');
    assert.equal((await send('POST','/api/v1/auth/refresh',undefined,ca2)).statusCode,401,'revoked session cannot refresh');
    assert.equal((await send('DELETE',`/api/v1/account/sessions/${other}`,undefined,ca1)).statusCode,204,'repeat revoke is idempotent');
    assert.equal((await send('GET','/api/v1/me',undefined,cb1)).statusCode,200,'other account unaffected');

    // Revoke others keeps the current session.
    const a3=jar(await login('alice_acct',alicePwd)),a4=jar(await login('alice_acct',alicePwd));
    const others=await send('POST','/api/v1/account/sessions/revoke-others',undefined,a3);assert.equal(others.statusCode,200,others.body);assert.equal(others.json().revoked_sessions,2);
    assert.equal((await send('GET','/api/v1/me',undefined,a4)).statusCode,401);assert.equal((await send('GET','/api/v1/me',undefined,ca1)).statusCode,401);
    assert.equal((await send('GET','/api/v1/me',undefined,a3)).statusCode,200);

    // Password change needs the current password; a wrong one is not treated as session expiry.
    const a5=jar(await login('alice_acct',alicePwd));
    const wrong=await send('POST','/api/v1/account/password',{current_password:'not the password 1',new_password:aliceNew},a3);
    assert.equal(wrong.statusCode,403);assert.equal(wrong.json().code,'PASSWORD_INVALID');
    assert.equal((await send('POST','/api/v1/account/password',{current_password:alicePwd,new_password:'short'},a3)).statusCode,422);
    assert.equal((await send('POST','/api/v1/account/password',{current_password:bobPwd,new_password:aliceNew},a3)).statusCode,403,'another account password cannot authorize');
    const changed=await send('POST','/api/v1/account/password',{current_password:alicePwd,new_password:aliceNew},a3);assert.equal(changed.statusCode,200,changed.body);
    assert.equal(changed.json().revoked_sessions,1);
    assert.equal((await send('GET','/api/v1/me',undefined,a5)).statusCode,401);assert.equal((await send('GET','/api/v1/me',undefined,a3)).statusCode,200);
    assert.equal((await login('alice_acct',alicePwd)).statusCode,401);
    assert.notEqual((await send('GET','/api/v1/account',undefined,a3)).json().password_updated_at,null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type=$2',[alice,'user.password_changed'])).rows[0].n,1);
    // Re-authentication failures count toward the login limiter for that account.
    for(let i=0;i<2;i++)assert.equal((await send('POST','/api/v1/account/password',{current_password:'not the password 1',new_password:aliceNew},a3)).statusCode,403);
    assert.equal((await pool.query('SELECT max(failures)::int n FROM bb_password_login_limits')).rows[0].n,2);
    await pool.query('TRUNCATE bb_password_login_limits');

    // Closure: preview blockers, refuse while a run is active, then close and retain required records.
    const p=await send('POST','/api/v1/projects',{name:'Synthetic closure project',kind:'update',issuer_name:null,market:null,offering:null},a3);assert.equal(p.statusCode,201,p.body);const project=p.json().project_id;
    const bp=await send('POST','/api/v1/projects',{name:'Synthetic Bob project',kind:'update',issuer_name:null,market:null,offering:null},cb1);assert.equal(bp.statusCode,201);
    const key=`users/${alice}/projects/${project}/uploads/synthetic-up`;
    await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at) VALUES('synthetic-up',$1,$2,'s.pdf','application/pdf',10,$3,'audit',$4,now())",[alice,project,'d'.repeat(64),key]);
    await pool.query("UPDATE bb_uploads SET state='received' WHERE id='synthetic-up'");await pool.query("UPDATE bb_uploads SET state='completed' WHERE id='synthetic-up'");
    await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES('synthetic-mat',1,$1,$2,'synthetic-up','audit','s.pdf','application/pdf',10,$3,$4,'persisted')",[alice,project,'d'.repeat(64),key]);
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,alice,'e'.repeat(64)]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES('synthetic-run',$1,$2,1,$3,'synthetic-key','update',$4,'paused')",[alice,project,'e'.repeat(64),'f'.repeat(64)]);
    await pool.query("INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status) VALUES('synthetic-art',1,$1,'synthetic-run','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$2,$3,'passed','available')",[alice,'0'.repeat(64),`users/${alice}/artifacts/synthetic-art`]);
    const preview=await send('GET','/api/v1/account/closure',undefined,a3);assert.equal(preview.statusCode,200,preview.body);
    assert.equal(preview.json().can_close,false);assert.deepEqual(preview.json().active_runs,[{run_id:'synthetic-run',project_id:project,state:'paused'}]);
    assert.equal(preview.json().local_exports,'not_affected');assert.equal(preview.json().balance_status,'not_applicable_m1');
    assert.equal((await send('GET','/api/v1/account/closure',undefined,cb1)).json().active_runs.length,0,'preview is owner-scoped');
    assert.equal((await send('POST','/api/v1/account/closure',{password:aliceNew,confirm_username:'bob_acct'},a3)).statusCode,422);
    assert.equal((await send('POST','/api/v1/account/closure',{password:'not the password 1',confirm_username:'alice_acct'},a3)).statusCode,403);
    const blocked=await send('POST','/api/v1/account/closure',{password:aliceNew,confirm_username:'ALICE_ACCT'},a3);
    assert.equal(blocked.statusCode,409);assert.equal(blocked.json().code,'ACCOUNT_CLOSURE_BLOCKED');
    assert.equal((await send('GET',`/api/v1/projects/${project}`,undefined,a3)).statusCode,200,'blocked closure changes nothing');
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id='synthetic-run'");
    const a6=jar(await login('alice_acct',aliceNew));
    const closed=await send('POST','/api/v1/account/closure',{password:aliceNew,confirm_username:'alice_acct'},a3);assert.equal(closed.statusCode,200,closed.body);
    const c=closed.json();
    assert.deepEqual([c.status,c.projects_deleted,c.material_versions_deleted,c.artifacts_revoked,c.sessions_revoked,c.local_exports,c.cloud_content],['closed',1,1,1,2,'not_affected','access_removed_purge_scheduled']);
    assert.ok((closed.headers['set-cookie'] as string[]).some(h=>h.startsWith('bb_session=;')));
    for(const s of [a3,a6])assert.equal((await send('GET','/api/v1/me',undefined,s)).statusCode,401);
    assert.equal((await login('alice_acct',aliceNew)).statusCode,401,'closed account cannot log in');
    assert.equal((await register('alice_acct','synthetic takeover password 1')).statusCode,409,'closed username is not reusable');
    assert.equal((await register('Alice_Acct','synthetic takeover password 1')).statusCode,409);
    const tomb=await pool.query("SELECT state FROM bb_storage_tombstones WHERE owner_user_id=$1 AND material_id='synthetic-mat'",[alice]);assert.equal(tomb.rows[0].state,'pending');
    assert.equal((await pool.query("SELECT delivery_status FROM bb_artifact_versions WHERE id='synthetic-art'")).rows[0].delivery_status,'revoked');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_password_credentials WHERE user_id=$1',[alice])).rows[0].n,0);
    // Required records stay: identity row, agreement, registration event, run history and closure record.
    assert.equal((await pool.query('SELECT status FROM bb_users WHERE id=$1',[alice])).rows[0].status,'closed');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_agreement_acceptances WHERE user_id=$1',[alice])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_registration_events WHERE user_id=$1',[alice])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_runs WHERE id='synthetic-run'")).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_account_closures WHERE user_id=$1',[alice])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type=$2',[alice,'user.closed'])).rows[0].n,1);
    await assert.rejects(pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES('synthetic-late',$1,'late','update')",[alice]),/account is closed/);
    // Bob is untouched.
    assert.equal((await send('GET',`/api/v1/projects/${bp.json().project_id}`,undefined,cb1)).statusCode,200);
    const dump=JSON.stringify((await pool.query('SELECT payload FROM bb_outbox WHERE owner_user_id=$1',[alice])).rows);
    for(const secret of [alicePwd,aliceNew,a3.bb_session])assert.equal(dump.includes(secret),false);
  }finally{await app.close();await pool.end();}
});
