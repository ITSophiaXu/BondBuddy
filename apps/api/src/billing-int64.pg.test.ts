import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {Type} from '@sinclair/typebox';
import {BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION,INITIAL_FIXED_PRICES,int64} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {creditBalanceExact,lockCreditAccount,reserveCreditLots,publishPrices,grantCredits} from './billing.js';
import {installBillingWire} from './billing-wire.js';
import {subscriptionAccount} from './subscriptions.js';
import {transaction,uid,digest,Problem} from './data.js';

const database=await isolatedTestDatabase(undefined,'billing-int64-wire');
test('synthetic PG HTTP tasks preserve large balances, exact string writes, idempotency and terminal release',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),app=Fastify(),owner=uid(),foreign=uid(),lot=uid(),max=9007199254740993n,version='int64-'+uid();
 const quoteByProject=new Map<string,string>(),hash='b'.repeat(64);
 const actor=async(r:any)=>typeof r.headers['x-synthetic-owner']==='string'?r.headers['x-synthetic-owner']:owner;
 installBillingWire(app,{db:()=>pool,owner:actor});app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status??e.statusCode??500).send({code:e.code}));
 app.get('/api/v1/credits/balance',{schema:{response:{200:Type.Object({available:Type.Integer(),frozen:Type.Integer()})}}},async r=>creditBalanceExact(pool,await actor(r)));
 app.get('/api/v1/subscriptions/account',async r=>subscriptionAccount(pool,await actor(r)));
 // This is an explicit synthetic task-admission seam; it exercises real persisted
 // request identities, source allocations and terminal SQL hooks, without a model call.
 app.post('/api/v1/projects/:project_id/qa/runs',{schema:{body:Type.Object({request_id:Type.String(),expected_points:Type.Integer({minimum:1})},{additionalProperties:false})}},async r=>{
  const user=await actor(r),project=(r.params as any).project_id,b=r.body as {request_id:string;expected_points:number};
  return transaction(pool,async c=>{
   await lockCreditAccount(c,user);const requestHash=digest(JSON.stringify({project,...b}));
   const old=(await c.query('SELECT id,request_hash FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,'qa-answer:'+b.request_id])).rows[0];
   if(old){if(old.request_hash.trim()!==requestHash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Original task changed');return{run_id:old.id};}
   if(!(await c.query('SELECT 1 FROM bb_projects WHERE id=$1 AND owner_user_id=$2',[project,user])).rowCount)throw new Problem(404,'NOT_FOUND','Unknown project');
   if((await creditBalanceExact(c,user)).available<int64(b.expected_points))throw new Problem(402,'CREDITS_INSUFFICIENT','Insufficient');
   const run=uid(),reservation=uid();
   await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'generation',$6,'queued')",[run,user,project,hash,'qa-answer:'+b.request_id,requestHash]);
   await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,$5,'on_delivery')",[reservation,user,run,quoteByProject.get(project),String(b.expected_points)]);
   await reserveCreditLots(c,user,reservation,BigInt(b.expected_points));
   await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$3,'reserve',$4,$5,$6,'synthetic','int64_test')",[uid(),user,'reserve:'+reservation,String(b.expected_points),reservation,run]);
   await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run,reservation]);return{run_id:run};
  });
 });
 try{
  for(const id of [owner,foreign])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'int64_'+id.replaceAll('-','').slice(0,24)]);
  await publishPrices(pool,{id:version,prices:INITIAL_FIXED_PRICES,effectiveAt:new Date(Date.now()-1000).toISOString(),actor:'synthetic',reason:'Isolated int64 test'});
  await transaction(pool,async c=>{await lockCreditAccount(c,owner);await c.query("INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining) VALUES($1,$2,'existing_grant',$1,$3,$3)",[lot,owner,max.toString()]);await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason) VALUES($1,$2,$1,'grant',$3,$4,'synthetic','int64_test')",[uid(),owner,max.toString(),lot]);});
  for(let i=0;i<2;i++){const p=uid(),q=uid();quoteByProject.set(p,q);await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Int64 synthetic task','generation')",[p,owner]);await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[p,owner,hash]);await pool.query("INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason) VALUES($1,$2,$3,1,$4,$5,'annual',2,'synthetic exact allocation')",[q,owner,p,hash,version]);}
  const [p1,p2]=quoteByProject.keys(),url='/api/v1/projects/'+p1+'/qa/runs',body={request_id:'first',expected_points:'2'};
  assert.deepEqual((await app.inject('/api/v1/credits/balance')).json(),{available:max.toString(),frozen:'0'});
  const account=await app.inject('/api/v1/subscriptions/account');assert.equal(account.statusCode,200);assert.equal(account.json().other_available_points,max.toString());
  const invalid=await app.inject({method:'POST',url,payload:{...body,expected_points:2}});assert.equal(invalid.statusCode,422);
  const results=await Promise.all([app.inject({method:'POST',url,payload:body}),app.inject({method:'POST',url:'/api/v1/projects/'+p2+'/qa/runs',payload:{request_id:'second',expected_points:'2'}})]);
  for(const result of results)assert.equal(result.statusCode,200,result.body);
  assert.deepEqual((await app.inject('/api/v1/credits/balance')).json(),{available:(max-4n).toString(),frozen:'4'});
  assert.equal((await app.inject({method:'POST',url,payload:body})).json().run_id,results[0].json().run_id);
  assert.equal((await app.inject({method:'POST',url,headers:{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION},payload:{request_id:'first',expected_points:2}})).json().run_id,results[0].json().run_id);
  assert.equal((await app.inject({method:'POST',url,headers:{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION},payload:{request_id:'first',expected_points:1}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url,headers:{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION,'x-synthetic-owner':foreign},payload:{request_id:'first',expected_points:2}})).statusCode,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_allocations WHERE lot_id=$1',[lot])).rows[0].n,2);
  for(const result of results)await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[result.json().run_id]);
  assert.deepEqual((await app.inject('/api/v1/credits/balance')).json(),{available:max.toString(),frozen:'0'});
  const overflow=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[overflow,'int64_'+overflow.replaceAll('-','').slice(0,24)]);
  const largeGrant={owner:overflow,source:'existing_grant' as const,key:'max-exact-grant',points:'9223372036854775807',expiresAt:null,actor:'synthetic',reason:'verified legacy right'};
  const largeLot=await transaction(pool,c=>grantCredits(c,largeGrant));
  assert.equal(await transaction(pool,c=>grantCredits(c,largeGrant)),largeLot);
  assert.equal((await creditBalanceExact(pool,overflow)).available,9223372036854775807n);
  await assert.rejects(transaction(pool,c=>grantCredits(c,{owner:overflow,source:'existing_grant',key:'overflow',points:1,expiresAt:null,actor:'synthetic',reason:'overflow test'})),/int64/);
 }finally{await app.close();await pool.end();}
});
