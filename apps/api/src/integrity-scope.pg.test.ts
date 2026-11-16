import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {AUTOMATIC_PRICE_VERSION,PREVIOUS_AUTOMATIC_PRICE_VERSION,integrityRoundPoints,INTEGRITY_SELECTABLE_SITES,integritySelectableSitesForSubjects,OUTCOME_PRICE_VERSION} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {transaction} from './data.js';
import {grantCredits,creditBalance} from './billing.js';
import {publishScopeQuote,requestScope,workScopeHash,markScopeUnavailable,requoteScopeQuotation} from './scope-quotations.js';
import {configureAutomaticBilling} from './automatic-billing-context.js';
import {isolatedTestDatabase} from './test-database.js';
import {applyVerifiedPayment,type PaymentProvider} from './payments.js';

const database=await isolatedTestDatabase(undefined,'integrity-scope');

test('integrity workspace and quotation both honor the active paid v3 subscription',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),owner='integrity-v3-protected-owner',project='integrity-v3-protected-project',subscription='integrity-v3-subscription',order='integrity-v3-order';
 const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-integrity-v3',acknowledgement:{code:'SUCCESS'},create:async()=>({checkoutUrl:'weixin://synthetic-integrity-v3'}),query:async()=>{throw Error('Synthetic receipt only');},verifyCallback:async()=>{throw Error('No external callback');}};
 const app=createServer({pool,enableSubscriptionBilling:true,paymentProviders:[provider],principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://scope.test'}),base=`/api/v1/projects/${project}/integrity`;
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_integrity_v3']);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic v3 protection','generation')",[project,owner]);
  const initial=await app.inject(base);assert.equal(initial.statusCode,200,initial.body);assert.equal(initial.json().price.price_version,AUTOMATIC_PRICE_VERSION);
  await transaction(pool,async c=>{
   await c.query("INSERT INTO bb_subscriptions(id,owner_user_id,plan_id,provider,merchant_id,task_price_version) VALUES($1,$2,'light','wechat',$3,$4)",[subscription,owner,provider.merchantId,PREVIOUS_AUTOMATIC_PRICE_VERSION]);
   await c.query("INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind) VALUES($1,$2,'synthetic-integrity-protection-order',$3,'wechat','subscription_light','bb-subscriptions-20261029-v1',19900,21000,'CNY',$4,now()+interval '30 minutes','subscription')",[order,owner,'a'.repeat(64),provider.merchantId]);
   await c.query("INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,automatic) VALUES('integrity-v3-period',$1,$2,1,$3,'light','bb-subscriptions-20261029-v1',19900,21000,$4,false)",[owner,subscription,order,PREVIOUS_AUTOMATIC_PRICE_VERSION]);
  });
  await applyVerifiedPayment(pool,provider,{orderId:order,merchantId:provider.merchantId,amountFen:19900,currency:'CNY',transactionId:'synthetic-integrity-protection-payment',state:'paid',payerCash:{amountFen:19900,currency:'CNY'}});
  const workspace=await app.inject(base);assert.equal(workspace.statusCode,200,workspace.body);assert.equal(workspace.json().price.price_version,PREVIOUS_AUTOMATIC_PRICE_VERSION);
  const draft={subjects:[{id:'issuer',kind:'company',name:'Synthetic protected issuer',identifier:'',role:'issuer',province:'',city:''}],site_ids:['pbc'],notes:''};
  const saved=await app.inject({method:'POST',url:base+'/draft',headers:{origin:'http://scope.test'},payload:{expected_revision:0,draft}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().price.price_version,PREVIOUS_AUTOMATIC_PRICE_VERSION);
  const quote=await app.inject({method:'POST',url:base+'/quote',headers:{origin:'http://scope.test'},payload:{expected_revision:1,round_id:'protected-v3-round'}});assert.equal(quote.statusCode,200,quote.body);assert.equal(quote.json().price_version,PREVIOUS_AUTOMATIC_PRICE_VERSION);assert.equal(quote.json().points,'22738');
 }finally{await app.close();await pool.end();}
});

test('retired integrity quotation cannot create an unexecutable v4 requote without a new round',{skip:!database},async()=>{
 const pool=new Pool({connectionString:database}),owner='integrity-old-requote-owner',project='integrity-old-requote-project';
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_old_requote']);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic old quotation','generation')",[project,owner]);
  configureAutomaticBilling(pool,false);
  const snapshot={draft:{subjects:[{id:'issuer',kind:'company',name:'Synthetic company',identifier:'',role:'issuer',province:'',city:''}],site_ids:['tax'],notes:''}};
  const q=await transaction(pool,c=>requestScope(c,owner,project,'integrity_round',workScopeHash(snapshot),snapshot));
  await markScopeUnavailable(pool,{id:q.scope_quote_id,expected_input_hash:workScopeHash(snapshot),actor:'synthetic',reason:'Synthetic retired quotation'});
  configureAutomaticBilling(pool,true);
  await assert.rejects(requoteScopeQuotation(pool,owner,q.scope_quote_id,{request_id:'new-requote'}),{code:'SCOPE_UNSUPPORTED'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_scope_quotations WHERE owner_user_id=$1',[owner])).rows[0].n,1);
 }finally{await pool.end();}
});
test('synthetic integrity round: scope quote before execution, variable locked amount and failure release',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),owner='integrity-scope-owner';
 const app=createServer({pool,historicalBillingFixture:true,enableOutcomePricing:true,paymentProviders:[],principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://scope.test'});
 const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/v1/projects/integrity-scope-project/integrity/'+path,payload:payload as any,headers:{origin:'http://scope.test'}});
 try{
  await pool.query("INSERT INTO bb_users(id,username) VALUES('integrity-scope-owner','synthetic_integrity_scope'); INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES('integrity-scope-project','integrity-scope-owner','Synthetic integrity scope','update')");
  const draft={subjects:[{id:'subject-1',kind:'company',name:'Synthetic company',identifier:'',role:'issuer',province:'',city:''}],site_ids:[INTEGRITY_SELECTABLE_SITES[0].id],notes:''};
  const saved=await send('draft',{expected_revision:0,draft});assert.equal(saved.statusCode,200,saved.body);
  const pending=await send('quote',{expected_revision:1,round_id:'synthetic-round'});assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().quote_status,'pending_scope');
  const request={request_id:'synthetic-execution',round_id:'synthetic-round',expected_revision:1,expected_points:'0',price_version:OUTCOME_PRICE_VERSION,scope_quote_id:pending.json().scope_quote_id};
  assert.equal((await send('runs',{...request,request_id:'synthetic-pending'})).statusCode,409);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n),0);
  const row=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[request.scope_quote_id])).rows[0];
  await publishScopeQuote(pool,{id:row.id,expected_input_hash:row.input_hash.trim(),lines:[{key:'query-scope',label:'Synthetic selected subjects and sites',quantity:1,unit:'scope',unit_price_fen:5321,amount_fen:5321,evidence:['synthetic subject/site snapshot']}],actor:'synthetic-reviewer',reason:'Synthetic approved scope, not a market price'});
  const ready=await send('quote',{expected_revision:1,round_id:'synthetic-round'});assert.equal(ready.json().points,'5321');assert.equal(ready.json().quote_status,'ready');
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-only',points:5321,expiresAt:null,actor:'synthetic-test',reason:'synthetic-only, no real payment'}));
  const started=await send('runs',{...request,expected_points:'5321'});assert.equal(started.statusCode,200,started.body);const run=started.json().run_id;
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:5321});
  const again=await send('runs',{...request,expected_points:'5321'});assert.equal(again.json().run_id,run);
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run]);assert.deepEqual(await creditBalance(pool,owner),{available:5321,frozen:0});
 }finally{await app.close();await pool.end();}
});

test('automatic integrity pricing preserves all selected websites in one idempotent round',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),owner='integrity-all-sites-owner',project='integrity-all-sites-project';
 const app=createServer({pool,enableSubscriptionBilling:true,paymentProviders:[],principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://scope.test'});
 const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:`/api/v1/projects/${project}/integrity/${path}`,payload:payload as any,headers:{origin:'http://scope.test'}});
 const subjects=[{id:'issuer',kind:'company',name:'Synthetic full-scope issuer',identifier:'',role:'issuer',province:'河北',city:'沧州'}];
 const sites=integritySelectableSitesForSubjects(subjects).map(site=>site.id),points=integrityRoundPoints(sites.length);
 const draft={subjects,site_ids:sites,notes:''};
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_integrity_all_sites']);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic all-site integrity','generation')",[project,owner]);
  assert.ok(sites.length>2);
  const quotes=[];
  for(const [index,count] of [1,2,sites.length].entries()){
   const selected={...draft,site_ids:sites.slice(0,count)};
   const saved=await send('draft',{expected_revision:index,draft:selected});assert.equal(saved.statusCode,200,saved.body);
   assert.deepEqual(saved.json().draft.site_ids,selected.site_ids);
   const response=await send('quote',{expected_revision:index+1,round_id:'all-sites-round'});assert.equal(response.statusCode,200,response.body);
   const quote=response.json();quotes.push(quote);
   assert.equal(quote.quote_status,'ready');assert.equal(quote.auto_charge,true);assert.equal(quote.points,String(integrityRoundPoints(count)));
   assert.equal(quote.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(quote.scope_lines.length,2);
   const row=(await pool.query('SELECT snapshot FROM bb_scope_quotations WHERE id=$1',[quote.scope_quote_id])).rows[0];
   assert.deepEqual(row.snapshot.draft,selected);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,0);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  const quote=quotes.at(-1),request={request_id:'synthetic-all-sites-start',round_id:'all-sites-round',expected_revision:3,expected_points:String(points),price_version:quote.price_version,scope_quote_id:quote.scope_quote_id};
  const stale=await send('runs',{...request,request_id:'synthetic-stale-start',scope_quote_id:quotes[0].scope_quote_id});
  assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().code,'BILLING_REQUEST_REJECTED');
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-all-sites-funding',points,expiresAt:null,actor:'synthetic-test',reason:'Isolated test only; no real payment'}));
  const started=await send('runs',request);assert.equal(started.statusCode,200,started.body);const run=started.json().run_id;
  const replay=await send('runs',request);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().run_id,run);
  const rounds=await pool.query('SELECT manifest FROM bb_integrity_runs WHERE project_id=$1',[project]);
  assert.equal(rounds.rowCount,1);assert.deepEqual(rounds.rows[0].manifest.draft,draft);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,1);
  const reservations=await pool.query('SELECT points FROM bb_credit_reservations WHERE owner_user_id=$1',[owner]);
  assert.equal(reservations.rowCount,1);assert.equal(Number(reservations.rows[0].points),points);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:points});
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run]);
  assert.deepEqual(await creditBalance(pool,owner),{available:points,frozen:0});
 }finally{await app.close();await pool.end();}
});
