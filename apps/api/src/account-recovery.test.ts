import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { digest } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
const connection=await isolatedTestDatabase();
const origin='https://recovery.test';
const password='Synthetic-old-password-2026';
const replacement='Synthetic-recovered-password-2026';
const enabled={skip:!connection};
async function setup(supportContact:string|undefined='synthetic-support') {
  const pool=new Pool({connectionString:connection});
  const remoteAddress=`2001:db8:${randomBytes(4).toString('hex').match(/.{4}/g)!.join(':')}::1`;
  const app=createServer({pool,allowedOrigin:origin,auth:{termsVersion:'synthetic-recovery-v1',supportContact},enableSyntheticQueue:true});
  const publicPost=(url:string,payload:any)=>app.inject({method:'POST',url,headers:{origin},payload,remoteAddress});
  const credentials=(res:any)=>{
    const cookies=res.cookies as Array<{name:string;value:string}>;
    return {cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; '),'x-bb-csrf':cookies.find(c=>c.name==='bb_csrf')!.value,origin};
  };
  async function register(){const username=`r_${randomUUID().replaceAll('-','').slice(0,20)}`;const r=await publicPost('/api/v1/auth/register',{username,password,accepted_terms_version:'synthetic-recovery-v1'});assert.equal(r.statusCode,201,r.body);return {id:r.json().user_id,username,headers:credentials(r)};}
  const a=await register(),b=await register(),op=await register();
  await pool.query("INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'account_recovery','synthetic-test','synthetic_test')",[randomUUID(),op.id]);
  const send=(who:typeof a,method:string,url:string,payload?:any)=>app.inject({method:method as any,url,headers:who.headers,payload,remoteAddress});
  const bind=async()=>{
    const r=await send(a,'POST','/api/v1/account/recovery/bindings',{kind:'email',contact:'synthetic-original@example.test',current_password:password});assert.equal(r.statusCode,200,r.body);
    const id=r.json().binding_id;
    const code=await send(op,'POST',`/api/v1/admin/account-recovery/bindings/${id}/code`);assert.equal(code.statusCode,200,code.body);
    assert.equal((await send(a,'POST',`/api/v1/account/recovery/bindings/${id}/confirm`,{code:code.json().code})).statusCode,200);
    return id;
  };
  const ticket=async()=>{const r=await publicPost('/api/v1/auth/recovery/requests',{username:a.username});assert.equal(r.statusCode,200,r.body);return r.json().ticket_id as string;};
  const issue=async(id:string,binding:string)=>{const r=await send(op,'POST',`/api/v1/admin/account-recovery/tickets/${id}/issue`,{binding_id:binding,confirmed_original_channel:true});assert.equal(r.statusCode,200,r.body);return r.json().reset_path.split('/').at(-1) as string;};
  const login=(name=a.username,pw=password)=>publicPost('/api/v1/auth/login',{username:name,password:pw});
  return {pool,app,a,b,op,send,publicPost,bind,ticket,issue,login,credentials,close:async()=>{await app.close();await pool.end();}};
}

test('#9 real sessions: binding, manual grant and single-use reset preserve data/tasks and revoke all old sessions',enabled,async()=>{
  const s=await setup();try{
    const p=await s.send(s.a,'POST','/api/v1/projects',{name:'Synthetic recovery data',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(p.statusCode,201,p.body);
    const project=p.json().project_id;
    const input=await s.send(s.a,'POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});assert.equal(input.statusCode,201,input.body);
    const run=await s.send(s.a,'POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,input_revision:1,input_hash:input.json().input_hash,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});assert.equal(run.statusCode,202,run.body);
    const second=s.credentials(await s.login());
    const binding=await s.bind(),ticket=await s.ticket(),token=await s.issue(ticket,binding);
    assert.equal((await s.send(s.a,'GET','/api/v1/me')).statusCode,200,'request/issuance do not log out the user');
    const result=await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().sessions_revoked,2);
    assert.equal(result.headers['cache-control'],'no-store');
    assert.equal((await s.send(s.a,'GET','/api/v1/me')).statusCode,401);
    assert.equal((await s.app.inject({url:'/api/v1/me',headers:second})).statusCode,401);
    assert.equal((await s.app.inject({method:'POST',url:'/api/v1/auth/refresh',headers:second})).statusCode,401);
    assert.equal((await s.send(s.b,'GET','/api/v1/me')).statusCode,200);
    assert.equal((await s.login()).statusCode,401);
    const recovered=await s.login(s.a.username,replacement);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().user_id,s.a.id);
    const who={...s.a,headers:s.credentials(recovered)};
    assert.equal((await s.send(who,'GET',`/api/v1/projects/${project}`)).json().name,'Synthetic recovery data');
    assert.equal((await s.send(who,'GET',`/api/v1/runs/${run.json().run_id}`)).json().state,'queued');
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement})).statusCode,400);
    assert.equal((await s.send(s.op,'GET',`/api/v1/admin/account-recovery/tickets/${ticket}`)).json().status,'completed');
    const audit=JSON.stringify((await s.pool.query('SELECT event_type,payload FROM bb_outbox WHERE owner_user_id=$1',[s.a.id])).rows);
    for(const secret of [password,replacement,token,'synthetic-original@example.test'])assert.ok(!audit.includes(secret));
    assert.ok(audit.includes('recovery.password_reset'));
  }finally{await s.close();}
});

test('#9 unknown/unbound users share a generic replayable ticket; staff and foreign users cannot bypass prior binding',enabled,async()=>{
  const s=await setup();try{
    const known=await s.ticket();
    const unknown=await s.publicPost('/api/v1/auth/recovery/requests',{username:'no_'+randomUUID().replaceAll('-','').slice(0,20)});
    assert.deepEqual(Object.keys(unknown.json()).sort(),['status','ticket_id']);assert.equal(unknown.json().status,'received');
    assert.equal(await s.ticket(),known);
    assert.equal((await s.send(s.op,'GET',`/api/v1/admin/account-recovery/tickets/${known}`)).statusCode,404);
    const bad=await s.send(s.a,'POST','/api/v1/account/recovery/bindings',{kind:'email',contact:'wrong@example.test',current_password:'Wrong-password-2026'});assert.equal(bad.statusCode,403);
    const pending=await s.send(s.a,'POST','/api/v1/account/recovery/bindings',{kind:'support_chat',contact:'synthetic-original-chat',current_password:password});assert.equal(pending.statusCode,200,pending.body);const id=pending.json().binding_id;
    assert.equal((await s.send(s.b,'GET',`/api/v1/admin/account-recovery/bindings/${id}`)).statusCode,404);
    assert.equal((await s.send(s.a,'POST',`/api/v1/admin/account-recovery/bindings/${id}/code`)).statusCode,404);
    const code=(await s.send(s.op,'POST',`/api/v1/admin/account-recovery/bindings/${id}/code`)).json().code;
    assert.equal((await s.send(s.b,'POST',`/api/v1/account/recovery/bindings/${id}/confirm`,{code})).statusCode,400);
    assert.equal((await s.send(s.a,'POST',`/api/v1/account/recovery/bindings/${id}/confirm`,{code})).statusCode,200);
    assert.equal((await s.send(s.op,'POST',`/api/v1/admin/account-recovery/tickets/${known}/issue`,{binding_id:id,confirmed_original_channel:true})).statusCode,404,'cannot retroactively authorize an old unbound ticket');
    const current=await s.ticket();assert.notEqual(current,known);
    assert.equal((await s.send(s.op,'POST',`/api/v1/admin/account-recovery/tickets/${current}/issue`,{binding_id:id,confirmed_original_channel:false})).statusCode,422);
    assert.equal((await s.send(s.op,'POST',`/api/v1/admin/account-recovery/tickets/${current}/issue`,{binding_id:'foreign',confirmed_original_channel:true})).statusCode,409);
  }finally{await s.close();}
});

test('#9 expiry, reissue, purpose binding and brute-force budgets fail without locking normal login',enabled,async()=>{
  const s=await setup();try{
    const binding=await s.bind(),ticket=await s.ticket(),old=await s.issue(ticket,binding),token=await s.issue(ticket,binding);
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token:old,new_password:replacement})).statusCode,400);
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement,user_id:s.b.id})).statusCode,422);
    assert.equal((await s.app.inject({method:'POST',url:'/api/v1/auth/recovery/reset',headers:{origin:'https://foreign.test'},payload:{token,new_password:replacement}})).statusCode,403);
    await s.pool.query("UPDATE bb_recovery_tickets SET token_expires_at=now()-interval '1 second' WHERE id=$1",[ticket]);
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement})).statusCode,400);
    const invalidToken=randomBytes(32).toString('base64url');
    for(let i=0;i<6;i++){
      const result=await s.publicPost('/api/v1/auth/recovery/reset',{token:invalidToken,new_password:replacement});
      assert.equal(result.statusCode,i<5?400:429);
    }
    assert.equal((await s.login()).statusCode,200,'recovery failures never increment login failure limits');
  }finally{await s.close();}
});

test('#9 password change invalidates grants; closure erases recovery contacts',enabled,async()=>{
  const s=await setup();try{
    const binding=await s.bind(),ticket=await s.ticket(),token=await s.issue(ticket,binding);
    const changed=await s.send(s.a,'POST','/api/v1/account/password',{current_password:password,new_password:replacement});assert.equal(changed.statusCode,200,changed.body);
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:password})).statusCode,400);
    const state=await s.send(s.a,'GET','/api/v1/account/recovery');assert.equal(state.json().current.binding_id,binding);
    const closed=await s.send(s.a,'POST','/api/v1/account/closure',{password:replacement,confirm_username:s.a.username});assert.equal(closed.statusCode,200,closed.body);
    assert.ok((await s.pool.query('SELECT contact,state FROM bb_recovery_channels WHERE user_id=$1',[s.a.id])).rows.every(r=>r.contact===null&&r.state==='revoked'));
    assert.equal((await s.send(s.op,'GET',`/api/v1/admin/account-recovery/tickets/${ticket}`)).statusCode,404);
    assert.equal((await s.send(s.b,'GET','/api/v1/me')).statusCode,200);
    await s.pool.query('DELETE FROM bb_password_credentials WHERE user_id=$1',[s.b.id]);
    assert.equal((await s.send(s.b,'GET','/api/v1/account/recovery')).json().enabled,false,'a legacy identity without a password cannot enroll a recovery channel');
  }finally{await s.close();}
});

test('#9 reset outbox failure rolls back password, grant and session revocation',enabled,async()=>{
  const s=await setup();try{
    const binding=await s.bind(),ticket=await s.ticket(),token=await s.issue(ticket,binding);
    await s.pool.query("CREATE FUNCTION bb_recovery_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='recovery.password_reset' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$");
    await s.pool.query('CREATE TRIGGER bb_recovery_fail_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_recovery_fail_outbox()');
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement})).statusCode,500);
    assert.equal((await s.send(s.a,'GET','/api/v1/me')).statusCode,200);
    assert.equal((await s.login()).statusCode,200);
    assert.equal((await s.pool.query('SELECT state,token_hash FROM bb_recovery_tickets WHERE id=$1',[ticket])).rows[0].token_hash.trim(),digest(token));
    await s.pool.query('DROP TRIGGER bb_recovery_fail_outbox ON bb_outbox');await s.pool.query('DROP FUNCTION bb_recovery_fail_outbox()');
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement})).statusCode,200);
  }finally{await s.pool.query('DROP TRIGGER IF EXISTS bb_recovery_fail_outbox ON bb_outbox');await s.pool.query('DROP FUNCTION IF EXISTS bb_recovery_fail_outbox()');await s.close();}
});

test('#9 concurrent reset and an old-password login waiting on the same owner cannot leave a valid old session',enabled,async()=>{
  const s=await setup();const blocker=await s.pool.connect();try{
    const binding=await s.bind(),ticket=await s.ticket(),token=await s.issue(ticket,binding);
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM bb_users WHERE id=$1 FOR UPDATE',[s.a.id]);
    const reset=s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement});
    async function waiting(fragment:string){
      for(let i=0;i<100;i++){
        const rows=await s.pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()");
        if(rows.rows.some(row=>row.query.includes(fragment)))return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }throw new Error('Expected concurrent auth waiter');
    }
    await waiting("WHERE id=$1 AND status='active' FOR UPDATE");
    const login=s.login();await waiting("WHERE username=$1 AND status='active' FOR UPDATE");
    await blocker.query('COMMIT');
    assert.equal((await reset).statusCode,200);assert.equal((await login).statusCode,401,'a stale credential read must not cross the reset lock');
    const duplicate=await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:password});assert.equal(duplicate.statusCode,400);
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM bb_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',[s.a.id])).rows[0].n,0);
  }finally{await blocker.query('ROLLBACK');blocker.release();await s.close();}
});

test('#9 configured support and the exact active operator role are required; revocation also voids issued links',enabled,async()=>{
  const disabled=await setup('');try{assert.equal((await disabled.app.inject('/api/v1/auth/recovery/info')).json().enabled,false);assert.equal((await disabled.publicPost('/api/v1/auth/recovery/requests',{username:disabled.a.username})).statusCode,503);}finally{await disabled.close();}
  const s=await setup();try{
    const binding=await s.bind(),ticket=await s.ticket(),token=await s.issue(ticket,binding);
    await s.pool.query("INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'log_operator','synthetic-test','synthetic_test')",[randomUUID(),s.b.id]);
    assert.equal((await s.send(s.b,'GET',`/api/v1/admin/account-recovery/tickets/${ticket}`)).statusCode,404);
    await s.pool.query("UPDATE bb_operator_grants SET revoked_at=now() WHERE user_id=$1 AND role='account_recovery'",[s.op.id]);
    assert.equal((await s.send(s.op,'GET',`/api/v1/admin/account-recovery/tickets/${ticket}`)).statusCode,404);
    // A different live recovery operator keeps the feature enabled, but cannot validate the old issuer's grant.
    await s.pool.query("INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'account_recovery','synthetic-test','synthetic_test')",[randomUUID(),s.b.id]);
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement})).statusCode,400);
    assert.equal((await s.login()).statusCode,200);
  }finally{await s.close();}
});

test('#9 replacing a verified channel invalidates its old ticket and clears abandoned contact/code data',enabled,async()=>{
  const s=await setup();try{
    const first=await s.bind(),ticket=await s.ticket(),token=await s.issue(ticket,first);
    const pending=await s.send(s.a,'POST','/api/v1/account/recovery/bindings',{kind:'email',contact:'new-synthetic@example.test',current_password:password});
    assert.equal(pending.statusCode,200);const id=pending.json().binding_id;
    const firstCode=(await s.send(s.op,'POST',`/api/v1/admin/account-recovery/bindings/${id}/code`)).json().code;
    const code=(await s.send(s.op,'POST',`/api/v1/admin/account-recovery/bindings/${id}/code`)).json().code;
    assert.equal((await s.send(s.a,'POST',`/api/v1/account/recovery/bindings/${id}/confirm`,{code:firstCode})).statusCode,400);
    assert.equal((await s.send(s.a,'POST',`/api/v1/account/recovery/bindings/${id}/confirm`,{code})).statusCode,200);
    assert.equal((await s.publicPost('/api/v1/auth/recovery/reset',{token,new_password:replacement})).statusCode,400);
    assert.equal((await s.pool.query('SELECT contact FROM bb_recovery_channels WHERE id=$1',[first])).rows[0].contact,null);
    const abandoned=await s.send(s.a,'POST','/api/v1/account/recovery/bindings',{kind:'email',contact:'abandoned@example.test',current_password:password});
    await s.pool.query("UPDATE bb_recovery_channels SET expires_at=now()-interval '1 second' WHERE id=$1",[abandoned.json().binding_id]);
    const {purgeAccountRecovery}=await import('./recovery-lifecycle.js');await purgeAccountRecovery(s.pool,s.a.id);
    assert.equal((await s.pool.query('SELECT contact FROM bb_recovery_channels WHERE id=$1',[abandoned.json().binding_id])).rows[0].contact,null);
    assert.equal((await s.send(s.a,'GET','/api/v1/account/recovery')).json().current.binding_id,id);
  }finally{await s.close();}
});
