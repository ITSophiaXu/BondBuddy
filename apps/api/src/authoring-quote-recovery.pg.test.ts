import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {emptyUpdateDetails} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {uploadSyntheticReference,uploadSyntheticAudit} from './test-authoring-source.js';
import {isolatedTestDatabase} from './test-database.js';
import {grantCredits,creditBalance} from './billing.js';
import {transaction,type PrivateBlobs} from './data.js';

const connection=await isolatedTestDatabase(undefined,'authoring-quote-recovery-http');

test('issue 1583: real upload and repeated input saves recover an executable quote without duplicate reservations', {skip:!connection,timeout:120000},async t=>{
  const pool=new Pool({connectionString:connection}),owner=randomUUID(),origin='http://bondbuddy.test';
  let actor=owner;
  const stored=new Map<string,Buffer>();
  const blobs:PrivateBlobs={
    put:async(k,b)=>{stored.set(k,Buffer.from(b));},
    get:async k=>{const b=stored.get(k);assert.ok(b);return b;},
    getIfExists:async k=>stored.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=stored.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},
    exists:async k=>stored.has(k),delete:async k=>{stored.delete(k);}
  };
  // Synthetic material bytes and no model worker; all uploads, saves, quotes,
  // execution requests and cancellation go through the real HTTP handlers.
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true}),
    enableSyntheticQueue:true,enablePaidAuthoring:true,enableSubscriptionBilling:true});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin}});
  const save=async(f:{project:string;body:any})=>{
    const current=await send('GET',`/api/v1/projects/${f.project}`);assert.equal(current.statusCode,200,current.body);
    const r=await send('POST',`/api/v1/projects/${f.project}/input-revisions`,{...f.body,draft_revision:current.json().draft_revision});
    assert.equal(r.statusCode,201,r.body);return r.json();
  };
  const setup=async(label:string)=>{
    const created=await send('POST','/api/v1/projects',{kind:'update',name:'Synthetic quote recovery '+label,
      issuer_name:'Synthetic issuer',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
    assert.equal(created.statusCode,201,created.body);
    const project=created.json().project_id,body=await uploadSyntheticReference(app,project);
    body.material_versions.push(await uploadSyntheticAudit(app,project));
    const f={project,body};return {...f,input:await save(f)};
  };
  const quote=(input:any)=>send('POST',`/api/v1/projects/${input.project_id}/credit-quote`,{
    input_revision:input.input_revision,input_hash:input.input_hash
  });
  const request=(input:any,quoteId:string)=>({execution_request_id:randomUUID(),project_id:input.project_id,
    input_revision:input.input_revision,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:input.input_hash,
    storage_origin:'cloud',workspace_id:input.project_id,quote_id:quoteId});
  const count=async(table:string,project:string)=>Number((await pool.query(`SELECT count(*) n FROM ${table} WHERE owner_user_id=$1 AND project_id=$2`,[owner,project])).rows[0].n);
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_qr_'+owner.slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:1000000,expiresAt:null,
      actor:'synthetic-test',reason:'local authoring quote recovery only'}));
    const a=await setup('A'),qa=await quote(a.input);assert.equal(qa.statusCode,200,qa.body);
    const startA=await send('POST','/api/v1/runs/execute',request(a.input,qa.json().quote.quote_id));
    assert.equal(startA.statusCode,202,startA.body);
    const b=await setup('B'),qb=await quote(b.input);assert.equal(qb.statusCode,200,qb.body);
    const original=qb.json().quote;
    const originalRow=(await pool.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND id=$2',[owner,original.quote_id])).rows[0];
    const backToA=await quote(a.input);assert.equal(backToA.statusCode,200,backToA.body);
    assert.equal(backToA.json().quote.quote_id,qa.json().quote.quote_id);
    const cancelA=await send('POST',`/api/v1/runs/${startA.json().run_id}/cancel`,{reason:'synthetic control complete'});
    assert.equal(cancelA.statusCode,200,cancelA.body);
    const balance=await creditBalance(pool,owner);
    let latest=b.input,accepted=original;
    const statuses:number[]=[];
    for(const revision of [2,3,4]){
      latest=await save(b);assert.equal(latest.input_revision,revision);assert.equal(latest.input_hash,b.input.input_hash);
      const replies=await Promise.all([quote(latest),quote(latest)]);
      for(const r of replies){
        statuses.push(r.statusCode);assert.equal(r.statusCode,200,r.body);
        assert.equal(r.json().quote.input_revision,revision);assert.equal(r.json().quote.input_hash,b.input.input_hash);
        assert.equal(r.json().quote.scope_quote_id,original.scope_quote_id);assert.equal(r.json().quote.points,original.points);
      }
      assert.equal(replies[0].json().quote.quote_id,replies[1].json().quote.quote_id);
      accepted=replies[0].json().quote;assert.notEqual(accepted.quote_id,original.quote_id);
    }
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND id=$2',[owner,original.quote_id])).rows[0],originalRow);
    assert.deepEqual(await creditBalance(pool,owner),balance,'quoting alone cannot reserve or charge credits');
    assert.equal(await count('bb_material_versions',b.project),2);
    const stale=await send('POST','/api/v1/runs/execute',request(latest,original.quote_id));
    assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().code,'QUOTE_CHANGED');
    assert.equal(await count('bb_runs',b.project),0,'an old quote cannot create a new-revision run');
    actor=randomUUID();
    assert.equal((await quote(latest)).statusCode,404,'another user cannot read or create this quote');
    actor=owner;
    const execution=request(latest,accepted.quote_id);
    const started=await Promise.all([send('POST','/api/v1/runs/execute',execution),send('POST','/api/v1/runs/execute',execution)]);
    started.forEach(r=>assert.equal(r.statusCode,202,r.body));
    const runId=started[0].json().run_id;
    assert.equal(started[1].json().run_id,runId,'a repeated start must return the same run');
    assert.equal(await count('bb_runs',b.project),1);
    const reservations=(await pool.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows;
    assert.equal(reservations.length,1);assert.equal(reservations[0].quote_id,accepted.quote_id);
    assert.equal(Number(reservations[0].points),Number(accepted.points));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_authoring_scope_reservations WHERE owner_user_id=$1 AND scope_quote_id=$2',[owner,accepted.scope_quote_id])).rows[0].n,1);
    assert.deepEqual(await creditBalance(pool,owner),{available:balance.available-Number(accepted.points),frozen:Number(accepted.points)});
    const charge=await send('GET',`/api/v1/runs/${runId}/credit-charge`);assert.equal(charge.statusCode,200,charge.body);
    assert.equal(charge.json().quote.input_revision,4);assert.equal(charge.json().quote.quote_id,accepted.quote_id);
    t.diagnostic(JSON.stringify({quotes:statuses,execute:started.map(r=>r.statusCode),runs:1,reservations:1,
      original_quote_unchanged:true,materials:2,old_quote_status:stale.statusCode,model_calls:0}));
    const cancelled=await send('POST',`/api/v1/runs/${runId}/cancel`,{reason:'synthetic validation cleanup'});
    assert.equal(cancelled.statusCode,200,cancelled.body);assert.deepEqual(await creditBalance(pool,owner),balance);
  }finally{await app.close();await pool.end();}
});
