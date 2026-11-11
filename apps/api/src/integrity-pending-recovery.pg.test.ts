import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION,INTEGRITY_PRICE,INTEGRITY_SELECTABLE_SITES} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {transaction} from './data.js';
import {grantCredits,creditBalance} from './billing.js';

const database=await isolatedTestDatabase(undefined,'integrity-pending-recovery');

test('full HTTP old integrity intents receive durable non-acceptance, while accepted numeric and string receipts replay unchanged',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),project=randomUUID();
 const options={pool,paymentProviders:[],principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://integrity-recovery.test'};
 const app=createServer(options),historical=createServer({...options,historicalBillingFixture:true});
 const path=`/api/v1/projects/${project}/integrity/`,headers={origin:'http://integrity-recovery.test'},legacy={[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION};
 const post=(server:typeof app,suffix:string,payload:unknown,extra:Record<string,string>={})=>server.inject({method:'POST',url:path+suffix,payload:payload as any,headers:{...headers,...extra}});
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'syn_integrity_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic old integrity intent','generation')",[project,owner]);
  const draft={subjects:[{id:'issuer',kind:'company',name:'Synthetic company',identifier:'',role:'issuer',province:'',city:''}],site_ids:[INTEGRITY_SELECTABLE_SITES[0].id],notes:''};
  const saved=await post(app,'draft',{expected_revision:0,draft});assert.equal(saved.statusCode,200,saved.body);
  for(const numeric of [true,false]){
   const request={request_id:randomUUID(),expected_revision:1,expected_points:numeric?5000:'5000',price_version:INTEGRITY_PRICE.version};
   const rejected=await post(app,'runs',request,numeric?legacy:{});
   assert.equal(rejected.statusCode,409,rejected.body);assert.equal(rejected.json().code,'BILLING_REQUEST_REJECTED',numeric?'numeric wire refusal':'current wire missing scope');
   assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
   const rows=await pool.query("SELECT * FROM bb_billing_request_rejections WHERE owner_user_id=$1 AND kind='integrity' AND request_id=$2",[owner,request.request_id]);assert.equal(rows.rowCount,1);
   assert.equal(rows.rows[0].resource_id,project);
   const replay=await post(historical,'runs',{...request,expected_points:'5000'});
   assert.equal(replay.statusCode,409,replay.body);assert.equal(replay.json().code,'BILLING_REQUEST_REJECTED','even a historically accepting handler cannot revive a rejected key');
   const altered=await post(app,'runs',{...request,expected_points:numeric?5001:'5001'},numeric?legacy:{});
   assert.equal(altered.statusCode,409,altered.body);assert.equal(altered.json().code,'IDEMPOTENCY_CONFLICT');
   await assert.rejects(pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,1,$4,$5,'generation',$6,'queued')`,[randomUUID(),owner,project,'a'.repeat(64),'integrity:'+request.request_id,rows.rows[0].request_hash]),e=>(e as any).code==='23514'&&/rejected billing request/.test((e as Error).message),'the DB fences delayed old acceptance');
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,0);
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-old-integrity-funding',points:5000,expiresAt:null,actor:'synthetic-test',reason:'Synthetic isolated historical receipt; no real payment'}));
  const acceptedRequest={request_id:randomUUID(),expected_revision:1,expected_points:'5000',price_version:INTEGRITY_PRICE.version};
  const accepted=await post(historical,'runs',acceptedRequest);assert.equal(accepted.statusCode,200,accepted.body);const run=accepted.json().run_id;
  for(const numeric of [true,false]){
   const replay=await post(app,'runs',{...acceptedRequest,expected_points:numeric?5000:'5000'},numeric?legacy:{});
   assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().run_id,run);
   const altered=await post(app,'runs',{...acceptedRequest,expected_points:numeric?5001:'5001'},numeric?legacy:{});
   assert.equal(altered.statusCode,409,altered.body);assert.equal(altered.json().code,'IDEMPOTENCY_CONFLICT');
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,1);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:5000});
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_billing_request_rejections WHERE owner_user_id=$1 AND kind='integrity' AND request_id=$2",[owner,acceptedRequest.request_id])).rows[0].n,0);
 }finally{await app.close();await historical.close();await pool.end();}
});
