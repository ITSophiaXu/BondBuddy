import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
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
async function fixture(pool:Pool,existingOwner?:string){
  const owner=existingOwner??randomUUID(),project=randomUUID();
  if(!existingOwner)await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_auto_'+owner.slice(0,8)]);
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

async function resaveUnchangedInput(pool:Pool,f:Awaited<ReturnType<typeof fixture>>,revision:number){
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    SELECT project_id,$2,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids
    FROM bb_input_revisions WHERE project_id=$1 AND revision=1`,[f.project,revision]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=$2 WHERE id=$1',[f.project,revision]);
}

test('issue 1583: repeated and concurrent quotes return one immutable quote for the same revision',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),origin='https://synthetic.invalid';
  const app=createServer({pool,enableSubscriptionBilling:true,allowedOrigin:origin,paymentProviders:[],principal:async()=>({userId:f.owner,csrfVerified:true})});
  try{
    const responses=await Promise.all(Array.from({length:6},()=>app.inject({method:'POST',url:`/api/v1/projects/${f.project}/credit-quote`,headers:{origin},payload:{input_revision:1,input_hash:f.hash}})));
    responses.forEach(r=>assert.equal(r.statusCode,200,r.body));
    assert.equal(new Set(responses.map(r=>r.json().quote.quote_id)).size,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_quotes WHERE project_id=$1',[f.project])).rows[0].n,1);
    assert.deepEqual(await creditBalance(pool,f.owner),{available:0,frozen:0});
  }finally{await app.close();await pool.end();}
});

test('issue 1583: switch projects and resume an interrupted quotation after identical input revisions',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database}),a=await fixture(pool),b=await fixture(pool,a.owner),origin='https://synthetic.invalid';
  const app=createServer({pool,enableSubscriptionBilling:true,allowedOrigin:origin,paymentProviders:[],principal:async()=>({userId:a.owner,csrfVerified:true})});
  const quote=async(f:typeof a,revision:number)=>{
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${f.project}/credit-quote`,headers:{origin},payload:{input_revision:revision,input_hash:f.hash}});
    assert.equal(response.statusCode,200,response.body);return response.json().quote;
  };
  try{
    await transaction(pool,c=>grantCredits(c,{owner:a.owner,source:'purchase',key:randomUUID(),points:300000,expiresAt:null,actor:'synthetic',reason:'issue 1583 fixture'}));
    const qa=await quote(a,1),original=await quote(b,1);
    const before=(await pool.query('SELECT * FROM bb_credit_quotes WHERE id=$1',[original.quote_id])).rows[0];
    assert.equal((await quote(a,1)).quote_id,qa.quote_id);
    let latest=original;
    for(const revision of [2,3,4]){
      await resaveUnchangedInput(pool,b,revision);latest=await quote(b,revision);
      assert.equal(latest.input_revision,revision);assert.equal(latest.input_hash,b.hash);
      assert.equal(latest.scope_quote_id,original.scope_quote_id);assert.equal(latest.points,original.points);
      assert.notEqual(latest.quote_id,original.quote_id);assert.equal((await quote(b,revision)).quote_id,latest.quote_id);
    }
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_quotes WHERE id=$1',[original.quote_id])).rows[0],before);
    assert.deepEqual(await creditBalance(pool,a.owner),{available:300000,frozen:0});
    const r=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,4,$4,$1,'generation',$4,'queued') RETURNING *",[randomUUID(),b.owner,b.project,b.hash])).rows[0];
    const reserve=(quoteId:string)=>transaction(pool,async c=>reserveCredits(c,b.owner,r,quoteId,{revision:4,manifest:b.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[b.project])).rows[0],undefined,true));
    await assert.rejects(reserve(original.quote_id),{code:'QUOTE_CHANGED'});
    await reserve(latest.quote_id);
    assert.deepEqual(await creditBalance(pool,a.owner),{available:300000-Number(latest.points),frozen:Number(latest.points)});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[a.owner])).rows[0].n,1);
    assert.equal((await quote(a,1)).quote_id,qa.quote_id);
    // Another exact input revision cannot turn the same scope into a second purchase.
    await resaveUnchangedInput(pool,b,5);const next=await quote(b,5);
    const second=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,5,$4,$1,'generation',$4,'queued') RETURNING *",[randomUUID(),b.owner,b.project,b.hash])).rows[0];
    await assert.rejects(transaction(pool,async c=>reserveCredits(c,b.owner,second,next.quote_id,{revision:5,manifest:b.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[b.project])).rows[0],undefined,true)),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[a.owner])).rows[0].n,1);
  }finally{await app.close();await pool.end();}
});

test('issue 1583: an unmatched insert conflict returns recoverable HTTP 409 instead of 500',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),origin='https://synthetic.invalid';
  const app=createServer({pool,enableSubscriptionBilling:true,allowedOrigin:origin,paymentProviders:[],principal:async()=>({userId:f.owner,csrfVerified:true})});
  try{
    await quoteCredits(pool,f.owner,f.project,1,f.hash,true);
    // Reproduce a rolling upgrade / old uniqueness constraint for this fixture only.
    await pool.query(`CREATE UNIQUE INDEX bb_test_1583_old_identity ON bb_credit_quotes(owner_user_id,scope_quote_id) WHERE project_id='${f.project}' AND scope_quote_id IS NOT NULL`);
    await resaveUnchangedInput(pool,f,2);
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${f.project}/credit-quote`,headers:{origin},payload:{input_revision:2,input_hash:f.hash}});
    assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'QUOTE_CHANGED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_quotes WHERE project_id=$1',[f.project])).rows[0].n,1);
    assert.deepEqual(await creditBalance(pool,f.owner),{available:0,frozen:0});
  }finally{await pool.query('DROP INDEX IF EXISTS bb_test_1583_old_identity');await app.close();await pool.end();}
});
test('issue 1583: migration preserves existing quotes, reservations, inputs and ledger entries',{skip:!database},async()=>{
 const connection=await isolatedTestDatabase(undefined,'issue1583-upgrade');
 const pool=new Pool({connectionString:connection});configureAutomaticBilling(pool,true);
 try{
  // Recreate the deployed schema in this private clone, before any fixture data.
  await pool.query(`DROP TRIGGER bb_authoring_scope_reservation_claim ON bb_credit_reservations;
   DROP TABLE bb_authoring_scope_reservations; DROP FUNCTION bb_authoring_scope_reservation_guard();
   DROP INDEX bb_scope_authoring_quote_identity; DROP INDEX bb_scope_review_quote_identity;
   CREATE UNIQUE INDEX bb_scope_credit_quote_identity ON bb_credit_quotes(owner_user_id,scope_quote_id) WHERE scope_quote_id IS NOT NULL;`);
  const f=await fixture(pool);await transaction(pool,c=>grantCredits(c,{owner:f.owner,source:'purchase',key:randomUUID(),points:200000,expiresAt:null,actor:'synthetic',reason:'migration fixture'}));
  const original=(await quoteCredits(pool,f.owner,f.project,1,f.hash,true)).quote,r=await run(pool,f);
  await transaction(pool,async c=>reserveCredits(c,f.owner,r,original.quote_id,{revision:1,manifest:f.manifest},(await c.query('SELECT * FROM bb_projects WHERE id=$1',[f.project])).rows[0],undefined,true));
  const snapshot=async()=>Object.fromEntries(await Promise.all(['bb_credit_quotes','bb_credit_reservations','bb_input_revisions','bb_scope_quotations','bb_credit_events','bb_credit_lots'].map(async table=>[table,(await pool.query(`SELECT row_to_json(t) value FROM ${table} t WHERE owner_user_id=$1 ORDER BY row_to_json(t)::text`,[f.owner])).rows])));
  const before=await snapshot(),balance=await creditBalance(pool,f.owner);
  await transaction(pool,async c=>{await c.query(readFileSync(new URL('../../../db/migrations/0192_authoring_scope_quote_input_revision.sql',import.meta.url),'utf8'));});
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await creditBalance(pool,f.owner),balance);
  const claims=(await pool.query('SELECT * FROM bb_authoring_scope_reservations WHERE owner_user_id=$1',[f.owner])).rows;
  assert.equal(claims.length,1);assert.equal(claims[0].scope_quote_id,original.scope_quote_id);assert.equal(claims[0].reservation_id,r.reservation_id);
  await assert.rejects(pool.query('DELETE FROM bb_authoring_scope_reservations WHERE owner_user_id=$1',[f.owner]),{code:'23514'});
 }finally{await pool.end();}
});