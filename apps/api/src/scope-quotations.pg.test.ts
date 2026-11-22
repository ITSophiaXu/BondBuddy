import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {transaction} from './data.js';
import {creditBalance} from './billing.js';
import {requestScope,publishScopeQuote,assertScopeQuote,workScopeHash} from './scope-quotations.js';
import {isolatedTestDatabase} from './test-database.js';

const database=await isolatedTestDatabase(undefined,'reviewed-scope');
test('synthetic scope quote: persistent pending, different same-task prices, immutable evidence and no browser price approval',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database});let actor='scope-owner';
 const app=createServer({pool,enableOutcomePricing:true,paymentProviders:[],principal:async()=>({userId:actor,csrfVerified:true}),allowedOrigin:'http://scope.test'});
 try{
  await pool.query("INSERT INTO bb_users(id,username) VALUES('scope-owner','synthetic_scope_owner'),('scope-other','synthetic_scope_other'); INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES('scope-project','scope-owner','Synthetic scope','update')");
  const first={periods:['2026-06'],sections:['financials']},second={periods:['2025-12','2026-06'],sections:['financials','covenants']};
  const request=(snapshot:unknown)=>transaction(pool,c=>requestScope(c,actor,'scope-project','authoring',workScopeHash(snapshot),snapshot));
  const a=await request(first),b=await request(second);assert.equal(a.quote_status,'pending_scope');assert.notEqual(a.scope_quote_id,b.scope_quote_id);
  assert.equal((await request(first)).scope_quote_id,a.scope_quote_id);
  assert.deepEqual(await creditBalance(pool,actor),{available:0,frozen:0});
  await assert.rejects(transaction(pool,c=>assertScopeQuote(c,a.scope_quote_id,actor,'scope-project','authoring',workScopeHash(first),0)),/报价/);
  const line=(key:string,amount:number)=>({key,label:'Synthetic affected scope',quantity:1,unit:'scope',unit_price_fen:amount,amount_fen:amount,evidence:['synthetic exact period/section reference']});
  await assert.rejects(pool.query("UPDATE bb_scope_quotations SET status='quoted',amount_fen=NULL,approved_by=NULL,reason='synthetic null bypass',published_at=now(),lines=$2 WHERE id=$1",[a.scope_quote_id,JSON.stringify([line('scope1',42731)])]));
  await assert.rejects(pool.query("UPDATE bb_scope_quotations SET status='quoted',amount_fen=42731,approved_by='synthetic',reason='synthetic null line',published_at=now(),lines=$2 WHERE id=$1",[a.scope_quote_id,JSON.stringify([{...line('scope1',42731),quantity:null,amount_fen:null}])]));
  const approval={id:a.scope_quote_id,expected_input_hash:workScopeHash(first),lines:[line('scope1',42731)],actor:'synthetic-reviewer',reason:'Synthetic planned work only'};
  await assert.rejects(publishScopeQuote(pool,{...approval,expected_input_hash:workScopeHash(second)}));
  const published=await publishScopeQuote(pool,approval);assert.equal(published.amount_fen,42731);assert.equal(published.quote_status,'ready');
  assert.deepEqual(await publishScopeQuote(pool,approval),published,'same publication is idempotent after JSONB key reordering');
  assert.equal((await publishScopeQuote(pool,{...approval,id:b.scope_quote_id,expected_input_hash:workScopeHash(second),lines:[line('scope2',83815)]})).amount_fen,83815);
  await assert.rejects(publishScopeQuote(pool,{...approval,lines:[line('scope1',1)]}));
  await assert.rejects(pool.query("UPDATE bb_scope_quotations SET amount_fen=1 WHERE id=$1",[a.scope_quote_id]),/immutable/);
  await assert.rejects(transaction(pool,c=>assertScopeQuote(c,a.scope_quote_id,'scope-other','scope-project','authoring',workScopeHash(first),42731)));
  await assert.rejects(transaction(pool,c=>assertScopeQuote(c,a.scope_quote_id,actor,'scope-project','review',workScopeHash(first),42731)));
  await assert.rejects(transaction(pool,c=>assertScopeQuote(c,a.scope_quote_id,actor,'scope-project','authoring',workScopeHash(second),42731)));
  assert.equal((await app.inject({url:'/api/v1/commerce/quotations'})).json().items.length,2);
  const forbidden=await app.inject({method:'POST',url:'/api/v1/commerce/quotations/'+a.scope_quote_id+'/publish',headers:{origin:'http://scope.test'},payload:approval});assert.equal(forbidden.statusCode,404);
  actor='scope-other';assert.equal((await app.inject({url:'/api/v1/commerce/quotations'})).json().items.length,0);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n),0);
 }finally{await app.close();await pool.end();}
});
