import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {INTEGRITY_SITES,OUTCOME_PRICE_VERSION} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {transaction} from './data.js';
import {grantCredits,creditBalance} from './billing.js';
import {publishScopeQuote} from './scope-quotations.js';
import {isolatedTestDatabase} from './test-database.js';

const database=await isolatedTestDatabase(undefined,'integrity-scope');
test('synthetic integrity round: scope quote before execution, variable locked amount and failure release',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),owner='integrity-scope-owner';
 const app=createServer({pool,enableOutcomePricing:true,paymentProviders:[],principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://scope.test'});
 const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/v1/projects/integrity-scope-project/integrity/'+path,payload:payload as any,headers:{origin:'http://scope.test'}});
 try{
  await pool.query("INSERT INTO bb_users(id,username) VALUES('integrity-scope-owner','synthetic_integrity_scope'); INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES('integrity-scope-project','integrity-scope-owner','Synthetic integrity scope','update')");
  const draft={subjects:[{id:'subject-1',kind:'company',name:'Synthetic company',identifier:'',role:'issuer',province:'',city:''}],site_ids:[INTEGRITY_SITES[0].id],notes:''};
  const saved=await send('draft',{expected_revision:0,draft});assert.equal(saved.statusCode,200,saved.body);
  const pending=await send('quote',{expected_revision:1});assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().quote_status,'pending_scope');
  const request={request_id:'synthetic-execution',expected_revision:1,expected_points:0,price_version:OUTCOME_PRICE_VERSION,scope_quote_id:pending.json().scope_quote_id};
  assert.equal((await send('runs',request)).statusCode,409);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n),0);
  const row=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[request.scope_quote_id])).rows[0];
  await publishScopeQuote(pool,{id:row.id,expected_input_hash:row.input_hash.trim(),lines:[{key:'query-scope',label:'Synthetic selected subjects and sites',quantity:1,unit:'scope',unit_price_fen:5321,amount_fen:5321,evidence:['synthetic subject/site snapshot']}],actor:'synthetic-reviewer',reason:'Synthetic approved scope, not a market price'});
  const ready=await send('quote',{expected_revision:1});assert.equal(ready.json().points,5321);assert.equal(ready.json().quote_status,'ready');
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-only',points:5321,expiresAt:null,actor:'synthetic-test',reason:'synthetic-only, no real payment'}));
  const started=await send('runs',{...request,expected_points:5321});assert.equal(started.statusCode,200,started.body);const run=started.json().run_id;
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:5321});
  const again=await send('runs',{...request,expected_points:5321});assert.equal(again.json().run_id,run);
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run]);assert.deepEqual(await creditBalance(pool,owner),{available:5321,frozen:0});
 }finally{await app.close();await pool.end();}
});
