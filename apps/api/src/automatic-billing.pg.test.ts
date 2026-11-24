import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {AUTOMATIC_PRICE_VERSION,emptyUpdateDetails,reportingWindow} from '@bondbuddy/contracts';
import {configureAutomaticBilling} from './automatic-billing-context.js';
import {creditBalance,grantCredits,quoteCredits,reserveCredits} from './billing.js';
import {digest,transaction} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {isolatedTestDatabase} from './test-database.js';
import {createServer} from './server.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';

const database=await isolatedTestDatabase(undefined,'automatic-billing');
async function fixture(pool:Pool){
  const owner=randomUUID(),project=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_auto_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic auto project','generation')",[project,owner]);
  // Billing-only saved-input fixture: owned, declared synthetic reference under
  // the current mandatory-source rule. No parser or model work is performed.
  const upload=randomUUID(),material=randomUUID(),bytes=makeSyntheticDocxFixture({text:'Synthetic reference issuer prospectus'}),sha=digest(bytes);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-reference.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'reference',$6,now()+interval '1 hour','completed')`,[upload,owner,project,bytes.length,sha,'synthetic/'+upload]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'reference','synthetic-reference.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$5,$6,$7,'persisted')`,[material,owner,project,upload,bytes.length,sha,'synthetic/'+material]);
  const pin={material_id:material,material_version:1,sha256:sha};
  const manifest={draft_revision:1,issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[{...pin,role:'reference'}],update_details:{...emptyUpdateDetails(),reporting_cutoff:'2026-09-30'},authoring:{version:'unified_v1',source_prospectuses:[{...pin,issuer_name:'Synthetic reference issuer',relation:'similar_business',market:'sse',offering:'private',reporting_periods:reportingWindow('sse','private','2025-12-31'),status:'user_asserted'}],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}};
  const hash=inputManifestHash(manifest);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,$5,'[]')",[project,owner,hash,manifest,JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[project]);
  return{owner,project,hash,manifest};
}
async function run(pool:Pool,f:Awaited<ReturnType<typeof fixture>>){
  return(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *",[randomUUID(),f.owner,f.project,f.hash])).rows[0];
}
async function relockSameInput(pool:Pool,f:Awaited<ReturnType<typeof fixture>>){
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,2,$2,1,$3,$4,$5,'[]')",[f.project,f.owner,f.hash,f.manifest,JSON.stringify(f.manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1',[f.project]);
}
test('automatic authoring reuses an exact scope across input revisions with distinct executable quotes', {skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool),first=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote;
    await relockSameInput(pool,f);
    const second=(await quoteCredits(pool,f.owner,f.project,2,f.hash,true)).quote;
    const repeated=(await quoteCredits(pool,f.owner,f.project,2,f.hash,true)).quote;
    assert.equal(second.scope_quote_id,first.scope_quote_id);
    assert.notEqual(second.quote_id,first.quote_id);
    assert.equal(second.quote_id,repeated.quote_id);
    assert.equal(second.input_revision,2);
    assert.equal(second.points,first.points);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_quotes WHERE owner_user_id=$1 AND scope_quote_id=$2',[f.owner,first.scope_quote_id])).rows[0].n,2);
    await transaction(pool,c=>grantCredits(c,{owner:f.owner,source:'purchase',key:randomUUID(),points:200000,expiresAt:null,actor:'synthetic',reason:'same input relock'}));
    const current=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,2,$4,$1,'generation',$4,'queued') RETURNING *",[randomUUID(),f.owner,f.project,f.hash])).rows[0];
    const reserve=(quoteId:string)=>transaction(pool,async c=>reserveCredits(c,f.owner,current,quoteId,{revision:2,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true));
    await assert.rejects(reserve(first.quote_id),{code:'QUOTE_CHANGED'});
    await reserve(second.quote_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[current.id])).rows[0].n,1);
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,3,$2,1,$3,$4,$5,'[]')",[f.project,f.owner,f.hash,f.manifest,JSON.stringify(f.manifest.materials)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=3 WHERE id=$1',[f.project]);
    const third=(await quoteCredits(pool,f.owner,f.project,3,f.hash,true)).quote;
    assert.equal(third.scope_quote_id,first.scope_quote_id);
    const later=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,3,$4,$1,'generation',$4,'queued') RETURNING *",[randomUUID(),f.owner,f.project,f.hash])).rows[0];
    await assert.rejects(transaction(pool,async c=>reserveCredits(c,f.owner,later,third.quote_id,{revision:3,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true)),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_authoring_scope_reservations WHERE owner_user_id=$1 AND scope_quote_id=$2',[f.owner,first.scope_quote_id])).rows[0].n,1);
  }finally{await pool.end();}
});
test('automatic authoring produces an executable locked quote without operator pricing; shortages have no hold', {skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool),q=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote;
    assert.equal(q.quote_status,'ready');assert.equal(q.auto_charge,true);assert.equal(q.points,86799);assert.equal(q.price_version,AUTOMATIC_PRICE_VERSION);
    const r=await run(pool,f);
    await assert.rejects(transaction(pool,async c=>reserveCredits(c,f.owner,r,q.quote_id,{revision:1,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true)),{code:'CREDITS_INSUFFICIENT'});
    assert.deepEqual(await creditBalance(pool,f.owner),{available:0,frozen:0});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[f.owner])).rows[0].n,0);
  }finally{await pool.end();}
});
test('two competing executions cannot consume the same automatic scope twice', {skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool);await transaction(pool,c=>grantCredits(c,{owner:f.owner,source:'purchase',key:randomUUID(),points:200000,expiresAt:null,actor:'synthetic',reason:'test only'}));
    const q=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote,first=await run(pool,f),second=await run(pool,f);
    const results=await Promise.allSettled([first,second].map(r=>transaction(pool,async c=>reserveCredits(c,f.owner,r,q.quote_id,{revision:1,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true))));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,results.filter(r=>r.status==='rejected').map(r=>String(r.reason)+(r.reason?.where??'')).join('\n'));
    assert.deepEqual(await creditBalance(pool,f.owner),{available:113201,frozen:86799});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_automatic_scope_runs WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
    const snapshot=(await pool.query('SELECT automatic_price FROM bb_scope_quotations WHERE id=$1',[q.scope_quote_id])).rows[0].automatic_price;
    await assert.rejects(pool.query('UPDATE bb_scope_quotations SET automatic_price=$2 WHERE id=$1',[q.scope_quote_id,{...snapshot,points:1}]),{code:'23514'});
  }finally{await pool.end();}
});
test('HTTP exposes automatic price metadata, rejects client amounts and preserves owner isolation', {skip:!database},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),origin='https://synthetic.invalid';
  const app=createServer({pool,enableSubscriptionBilling:true,allowedOrigin:origin,paymentProviders:[],principal:async()=>({userId:f.owner,csrfVerified:true})});
  try{
    const url=`/api/v1/projects/${f.project}/credit-quote`,body={input_revision:1,input_hash:f.hash};
    const response=await app.inject({method:'POST',url,headers:{origin},payload:body});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().quote.auto_charge,true);
    const injected=await app.inject({method:'POST',url,headers:{origin},payload:{...body,points:1}});assert.equal(injected.statusCode,422);
    const foreign=await app.inject({method:'POST',url:`/api/v1/projects/${randomUUID()}/credit-quote`,headers:{origin},payload:body});assert.equal(foreign.statusCode,404);
  }finally{await app.close();await pool.end();}
});

test('HTTP charge readback preserves the exact original scope terms after a replacement quote', {skip:!database},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),origin='https://synthetic.invalid';let actor=f.owner;
  const app=createServer({pool,enableSubscriptionBilling:true,allowedOrigin:origin,paymentProviders:[],principal:async()=>({userId:actor,csrfVerified:true})});
  try{
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${f.project}/credit-quote`,headers:{origin},payload:{input_revision:1,input_hash:f.hash}});
    assert.equal(response.statusCode,200,response.body);const original=response.json().quote;
    assert.equal(typeof original.scope_expires_at,'string');
    await transaction(pool,c=>grantCredits(c,{owner:f.owner,source:'purchase',key:randomUUID(),points:100000,expiresAt:null,actor:'synthetic',reason:'charge readback fixture'}));
    const attempt=await run(pool,f);
    await transaction(pool,async c=>reserveCredits(c,f.owner,attempt,original.quote_id,{revision:1,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true));
    const url=`/api/v1/runs/${attempt.id}/credit-charge`;
    const assertReadback=async(state:string)=>{
      const before=(await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id',[f.owner])).rows,balance=await creditBalance(pool,f.owner);
      const receipt=await app.inject({method:'GET',url});assert.equal(receipt.statusCode,200,receipt.body);
      assert.equal(receipt.json().state,state);assert.deepEqual(receipt.json().quote,original);
      assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id',[f.owner])).rows,before);
      assert.deepEqual(await creditBalance(pool,f.owner),balance);
    };
    await assertReadback('held');
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[attempt.id]);
    await pool.query("UPDATE bb_scope_quotations SET status='expired',closed_at=now(),closure_reason='Synthetic expired-scope boundary' WHERE id=$1",[original.scope_quote_id]);
    const replacement=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote;
    assert.notEqual(replacement.scope_quote_id,original.scope_quote_id);assert.notEqual(replacement.scope_expires_at,original.scope_expires_at);
    await assertReadback('released');
    actor=randomUUID();assert.equal((await app.inject({method:'GET',url})).statusCode,404);
  }finally{await app.close();await pool.end();}
});

for(const expired of [false,true])test(`failed and released authoring can retry with a new immutable quote; closed=${expired}`,{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool);await transaction(pool,c=>grantCredits(c,{owner:f.owner,source:'purchase',key:randomUUID(),points:100000,expiresAt:null,actor:'synthetic',reason:'retry fixture'}));
    const original=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote,attempt=await run(pool,f);
    const reserve=(r:any,q:string)=>transaction(pool,async c=>reserveCredits(c,f.owner,r,q,{revision:1,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true));
    await reserve(attempt,original.quote_id);
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[attempt.id]);
    assert.deepEqual(await creditBalance(pool,f.owner),{available:100000,frozen:0});
    if(expired)await pool.query("UPDATE bb_scope_quotations SET status='expired',closed_at=now(),closure_reason='Synthetic expired-scope boundary' WHERE id=$1",[original.scope_quote_id]);
    const retry=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote;
    assert.equal(retry.points,original.points);assert.notEqual(retry.quote_id,original.quote_id);assert.notEqual(retry.scope_quote_id,original.scope_quote_id);
    await reserve(await run(pool,f),retry.quote_id);
    assert.deepEqual(await creditBalance(pool,f.owner),{available:13201,frozen:86799});
  }finally{await pool.end();}
});
