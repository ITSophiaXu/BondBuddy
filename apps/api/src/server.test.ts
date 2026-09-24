import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, digest } from './data.js';
import { createServer } from './server.js';

const origin='http://bondbuddy.test';
test('production seam rejects arbitrary client identity and reports honest capabilities',async()=>{
  const app=createServer({allowedOrigin:origin});try{
    const r=await app.inject({method:'POST',url:'/api/v1/projects',headers:{origin,'x-user-id':'synthetic-owner'},payload:{name:'Test',kind:'update',issuer_name:null,market:null,offering:null}});
    assert.equal(r.statusCode,401);
    const sms=await app.inject({method:'POST',url:'/api/v1/auth/sms/challenges',headers:{origin},payload:{phone:'+8613800000001',purpose:'login'}});
    assert.equal(sms.statusCode,404,'legacy SMS route is absent');
    const spec=(await app.inject('/openapi.json')).json();
    assert.match(spec.paths['/api/v1/runs/execute'].post['x-implementation-status'],/production-501/);
  }finally{await app.close();}
});

const connection=process.env.BB_TEST_DATABASE_URL;
const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('PostgreSQL 16 and Azurite owner isolation, snapshots, conflicts, outbox', {skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:connection});
  let active='synthetic-alice';
  const blobs=azureBlobs(blobConnection!);
  const app=createServer({pool,blobs,principal:async()=>({userId:active,csrfVerified:true}),allowedOrigin:origin,enableRunStaging:true});
  const send=async(method:string,url:string,payload?:unknown,extra:Record<string,string>={})=>await app.inject({method:method as any,url,headers:{origin,...extra},payload:payload as any});
  const create=async(name:string)=>send('POST','/api/v1/projects',{name,kind:'update',issuer_name:null,market:'nafmii',offering:'mtn'});
  try{
    await pool.query('TRUNCATE bb_artifact_download_grants,bb_outbox,bb_run_events,bb_artifact_versions,bb_word_delivery_evidence,bb_runs,bb_material_versions,bb_uploads,bb_input_revisions,bb_projects RESTART IDENTITY CASCADE');
    const a=await create('Synthetic Alice');assert.equal(a.statusCode,201,a.body);const project=a.json().project_id;
    const patch=await send('PATCH',`/api/v1/projects/${project}`,{name:'Synthetic Updated'}, {'if-match':'1'});assert.equal(patch.statusCode,200,patch.body);
    const stale=await send('PATCH',`/api/v1/projects/${project}`,{name:'Stale'},{'if-match':'1'});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'INPUT_REVISION_CONFLICT');
    const bytes=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');const sha=digest(bytes);
    const upload=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{filename:'synthetic.pdf',media_type:'application/pdf',byte_size:bytes.length,sha256:sha,role:'audit'});assert.equal(upload.statusCode,201,upload.body);
    const uploaded=await send('PUT',upload.json().upload_url,bytes,{'content-type':'application/octet-stream'});assert.equal(uploaded.statusCode,204,uploaded.body);
    const completeUrl=`/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`;
    const complete=await send('POST',completeUrl,{byte_size:bytes.length,sha256:sha});assert.equal(complete.statusCode,200,complete.body);
    const mat=complete.json().material_id;
    const retry=await send('POST',completeUrl,{byte_size:bytes.length,sha256:sha});assert.equal(retry.json().material_id,mat);
    const changedComplete=await send('POST',completeUrl,{byte_size:bytes.length,sha256:'a'.repeat(64)});assert.equal(changedComplete.statusCode,409);assert.equal(changedComplete.json().code,'IDEMPOTENCY_CONFLICT');
    const snapshot=await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:2,material_versions:[{material_id:mat,material_version:1}],requirement_message_ids:[]});assert.equal(snapshot.statusCode,201,snapshot.body);
    const input=snapshot.json();
    active='synthetic-bob';const b=await create('Synthetic Bob');assert.equal(b.statusCode,201);
    assert.equal((await send('GET',`/api/v1/projects/${project}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${mat}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${mat}/download`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${mat}/source-profile`)).statusCode,404);
    assert.equal((await send('DELETE',`/api/v1/projects/${project}/materials/${mat}`)).statusCode,404);
    assert.equal((await send('POST',`/api/v1/projects/${b.json().project_id}/input-revisions`,{draft_revision:1,material_versions:[{material_id:mat,material_version:1}],requirement_message_ids:[]})).statusCode,404);
    assert.equal((await send('GET','/api/v1/projects')).json().items.length,1);
    active='synthetic-alice';
    const change=await send('PATCH',`/api/v1/projects/${project}`,{name:'Changed after snapshot'},{'if-match':'2'});assert.equal(change.statusCode,200);
    const old=(await send('GET',`/api/v1/projects/${project}/input-revisions/${input.input_revision}`)).json();assert.equal(old.input_hash,input.input_hash);
    const q=await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[active,project]);assert.equal(q.rows[0].manifest.name,'Synthetic Updated');
    const req={execution_request_id:'synthetic-action-1',project_id:project,input_revision:input.input_revision,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace'};
    const run1=await send('POST','/api/v1/runs/execute',req);assert.equal(run1.statusCode,202,run1.body);assert.equal(run1.json().state,'paused');
    const run2=await send('POST','/api/v1/runs/execute',req);assert.equal(run2.json().run_id,run1.json().run_id);
    const collision=await send('POST','/api/v1/runs/execute',{...req,input_manifest_ref:'different'});assert.equal(collision.statusCode,409);assert.equal(collision.json().code,'IDEMPOTENCY_CONFLICT');
    const artifactId='synthetic-artifact',artifactKey=`users/synthetic-alice/artifacts/${artifactId}`;
    await pool.query("INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status) VALUES($1,1,$2,$3,$4,$5,$6,'pending','pending')",[artifactId,'synthetic-alice',run1.json().run_id,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',digest('unverified synthetic bytes'),artifactKey]);
    active='synthetic-bob';assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}`)).statusCode,404);assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}/download`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/runs/${run1.json().run_id}`)).statusCode,404);assert.equal((await send('GET',`/api/v1/runs/${run1.json().run_id}/events`)).statusCode,404);
    active='synthetic-alice';assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}`)).statusCode,404,'pending artifacts cannot receive download grants');assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}/download`)).statusCode,404);const events=await send('GET',`/api/v1/runs/${run1.json().run_id}/events`);assert.equal(events.json().items.length,1);
    const outbox=await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id='synthetic-alice' AND aggregate_type<>'observability'");assert.equal(outbox.rows[0].n,8);
    await pool.query("CREATE FUNCTION bb_fail_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='material.persisted' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER bb_fail_test_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_fail_test_outbox()');
    const upload2=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{filename:'retry.pdf',media_type:'application/pdf',byte_size:bytes.length,sha256:sha,role:'audit'});
    assert.equal((await send('PUT',upload2.json().upload_url,bytes,{'content-type':'application/octet-stream'})).statusCode,204);
    assert.equal((await send('POST',`/api/v1/projects/${project}/materials/uploads/${upload2.json().upload_id}/complete`,{byte_size:bytes.length,sha256:sha})).statusCode,500);
    const rolled=await pool.query('SELECT count(*)::int AS n FROM bb_material_versions WHERE upload_id=$1',[upload2.json().upload_id]);assert.equal(rolled.rows[0].n,0);
    await pool.query('DROP TRIGGER bb_fail_test_outbox ON bb_outbox');await pool.query('DROP FUNCTION bb_fail_test_outbox()');
    const recovered=await send('POST',`/api/v1/projects/${project}/materials/uploads/${upload2.json().upload_id}/complete`,{byte_size:bytes.length,sha256:sha});assert.equal(recovered.statusCode,200,recovered.body);
    assert.equal((await send('DELETE',`/api/v1/projects/${project}/materials/${mat}`)).statusCode,204);
    assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${mat}/download`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/input-revisions/${input.input_revision}`)).json().input_hash,input.input_hash);
  }finally{await pool.query('DROP TRIGGER IF EXISTS bb_fail_test_outbox ON bb_outbox');await pool.query('DROP FUNCTION IF EXISTS bb_fail_test_outbox()');await app.close();await pool.end();}
});

test('username/password sessions preserve owner resources across relogin', {skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:connection});
  const app=createServer({pool,blobs:azureBlobs(blobConnection!),allowedOrigin:origin,auth:{termsVersion:'synthetic-v1'},enableRunStaging:true});
  const jar=(response:any)=>Object.fromEntries((response.headers['set-cookie'] as string[]).map((v:string)=>v.split(';')[0].split('=')));
  const cookie=(c:Record<string,string>)=>Object.entries(c).map(([k,v])=>`${k}=${v}`).join('; ');
  const send=(method:string,url:string,payload?:unknown,c:Record<string,string>={},extra:Record<string,string>={})=>app.inject({method:method as any,url,headers:{origin,cookie:cookie(c),...(c.bb_csrf?{'x-bb-csrf':c.bb_csrf}:{}),...extra},payload:payload as any});
  const register=(username:string,password:string)=>send('POST','/api/v1/auth/register',{username,password,accepted_terms_version:'synthetic-v1'});
  const login=(username:string,password:string)=>send('POST','/api/v1/auth/login',{username,password});
  try{
    await pool.query('TRUNCATE bb_password_login_limits,bb_auth_sessions,bb_agreement_acceptances,bb_registration_events,bb_auth_challenges,bb_users,bb_artifact_download_grants,bb_outbox,bb_run_events,bb_artifact_versions,bb_word_delivery_evidence,bb_runs,bb_material_versions,bb_uploads,bb_input_revisions,bb_projects RESTART IDENTITY CASCADE');
    const pwd='synthetic password for Alice 123';
    assert.equal((await send('POST','/api/v1/auth/register',{username:'Alice_One',password:pwd,accepted_terms_version:'synthetic-v1'},{},{origin:'https://evil.test'})).statusCode,403);
    assert.equal((await register('alice_one','short')).statusCode,422);
    assert.equal((await send('POST','/api/v1/auth/register',{username:'alice_one',password:pwd,accepted_terms_version:'old-v0'})).statusCode,422);
    const first=await register('Alice_One',pwd);assert.equal(first.statusCode,201,first.body);const c1=jar(first);
    assert.equal((await register('alice_one',pwd)).statusCode,409);
    await pool.query("INSERT INTO bb_users(id,phone_e164) VALUES('synthetic-legacy-phone','+8613800000009')");
    assert.equal((await login('synthetic_legacy','wrong password 123')).statusCode,401,'legacy phone account has no password path');
    assert.equal((await pool.query("SELECT username FROM bb_users WHERE id='synthetic-legacy-phone'")).rows[0].username,null);
    const bob=await register('bob_two','synthetic password for Bob 123');assert.equal(bob.statusCode,201,bob.body);const c2=jar(bob);
    const unknown=await login('unknown_user','wrong password 123');const wrong=await login('ALICE_ONE','wrong password 123');
    assert.equal(unknown.statusCode,401);assert.equal(wrong.statusCode,401);assert.equal(unknown.json().message,wrong.json().message);assert.equal(unknown.json().code,wrong.json().code);
    for(let i=0;i<4;i++)assert.equal((await login('alice_one','wrong password 123')).statusCode,401);
    assert.equal((await login('alice_one',pwd)).statusCode,429);
    assert.equal((await login('bob_two','synthetic password for Bob 123')).statusCode,200,'shared source remains usable for another account');
    await pool.query("UPDATE bb_password_login_limits SET window_started_at=now()-interval '16 minutes' WHERE scope='account_source'");
    const good=await login('ALICE_ONE',pwd);assert.equal(good.statusCode,200,good.body);const c3=jar(good);
    for(const header of first.headers['set-cookie'] as string[]){assert.match(header,/Secure; SameSite=Strict/);if(!header.startsWith('bb_csrf='))assert.match(header,/HttpOnly/);}
    assert.equal((await send('POST','/api/v1/projects',{name:'Denied',kind:'update',issuer_name:null,market:null,offering:null},c3,{'x-bb-csrf':'wrong'})).statusCode,403);
    assert.equal((await send('POST','/api/v1/projects',{name:'Denied',kind:'update',issuer_name:null,market:null,offering:null},c3,{origin:'https://evil.test'})).statusCode,403);
    const created=await send('POST','/api/v1/projects',{name:'Synthetic owner project',kind:'update',issuer_name:null,market:null,offering:null},c3);assert.equal(created.statusCode,201,created.body);
    const project=created.json().project_id;
    const bytes=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');const sha=digest(bytes);
    const upload=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{filename:'synthetic.pdf',media_type:'application/pdf',byte_size:bytes.length,sha256:sha,role:'audit'},c3);assert.equal(upload.statusCode,201,upload.body);
    assert.equal((await send('PUT',upload.json().upload_url,bytes,c3,{'content-type':'application/octet-stream'})).statusCode,204);
    const complete=await send('POST',`/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`,{byte_size:bytes.length,sha256:sha},c3);assert.equal(complete.statusCode,200,complete.body);
    const mat=complete.json().material_id;
    const snapshot=await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[{material_id:mat,material_version:1}],requirement_message_ids:[]},c3);assert.equal(snapshot.statusCode,201,snapshot.body);
    const input=snapshot.json();
    const run=await send('POST','/api/v1/runs/execute',{execution_request_id:'synthetic-relogin-run',project_id:project,input_revision:input.input_revision,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace'},c3);assert.equal(run.statusCode,202,run.body);
    assert.equal((await send('GET',`/api/v1/projects/${project}`,undefined,c2)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${mat}`,undefined,c2)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/runs/${run.json().run_id}`,undefined,c2)).statusCode,404);
    const rotated=await send('POST','/api/v1/auth/refresh',undefined,c3);assert.equal(rotated.statusCode,200,rotated.body);const c4=jar(rotated);
    assert.equal((await send('GET',`/api/v1/projects/${project}`,undefined,c3)).statusCode,401);
    assert.equal((await send('POST','/api/v1/auth/logout',undefined,c4)).statusCode,204);
    assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${mat}`,undefined,c4)).statusCode,401);
    assert.equal((await send('POST','/api/v1/auth/refresh',undefined,c4)).statusCode,401);
    const reopened=await login('alice_one',pwd);assert.equal(reopened.statusCode,200,reopened.body);const c5=jar(reopened);
    assert.equal((await send('GET',`/api/v1/projects/${project}`,undefined,c5)).statusCode,200);
    const recovered=(await send('GET',`/api/v1/runs/${run.json().run_id}`,undefined,c5)).json();assert.equal(recovered.run_id,run.json().run_id);assert.equal(recovered.input_hash,input.input_hash);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_registration_events WHERE user_id=$1',[first.json().user_id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE event_type=$1 AND owner_user_id=$2',['user.registered',first.json().user_id])).rows[0].n,1);
    const stored=await pool.query('SELECT u.phone_e164,u.username,c.password_hash FROM bb_users u JOIN bb_password_credentials c ON c.user_id=u.id WHERE u.id=$1',[first.json().user_id]);
    assert.equal(stored.rows[0].phone_e164,null);assert.equal(stored.rows[0].username,'alice_one');assert.match(stored.rows[0].password_hash,/^\$argon2id\$/);
    assert.equal(JSON.stringify(stored.rows).includes(pwd),false);
    const dump=await pool.query('SELECT payload::text FROM bb_outbox WHERE owner_user_id=$1',[first.json().user_id]);assert.equal(JSON.stringify(dump.rows).includes(pwd),false);
    assert.equal(JSON.stringify(dump.rows).includes(c5.bb_session),false);
  }finally{await app.close();await pool.end();}
});
