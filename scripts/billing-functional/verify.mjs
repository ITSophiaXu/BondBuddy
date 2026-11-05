import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {request as httpRequest} from 'node:http';
import {baseURL,apiURL,runtime,terms,config,pgBase} from './config.mjs';

// Real HTTP through the same Vite proxy as the browser. Never uses billing_tester.
function client(){
  const cookies=new Map();
  return async(method,path,body,options={})=>{
    const headers={origin:baseURL,cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??'',...options.headers};
    if(body!==undefined)headers['content-type']='application/json';
    const response=await fetch(baseURL+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    if(options.expected!==undefined)assert.equal(response.status,options.expected,typeof data==='string'?data:JSON.stringify(data));
    else assert.ok(response.ok,JSON.stringify({status:response.status,data}));return {status:response.status,data};
  };
}
// Read only the account and immutable resource IDs created by this verification.
// Other accounts may be used concurrently; their balances are not a test oracle.
export async function verifyIsolatedAccountEvidence(db,{owner,username,orders,succeededRun,failedRun}){
  assert.match(username,/^billing_qa_[a-f0-9]{8}$/);
  assert.ok(owner&&succeededRun&&failedRun&&succeededRun!==failedRun);
  assert.equal(orders.length,3);assert.equal(new Set(orders.map(order=>order.id)).size,3);
  const account=(await db.query('SELECT id,username FROM bb_users WHERE id=$1 AND username=$2',[owner,username])).rows;
  assert.deepEqual(account,[{id:owner,username}]);
  const payments=(await db.query('SELECT id,owner_user_id,state,amount_fen,points FROM bb_recharge_orders WHERE id=ANY($1::text[])',[orders.map(order=>order.id)])).rows;
  assert.equal(payments.length,3);
  for(const expected of orders){const payment=payments.find(row=>row.id===expected.id);assert.ok(payment);assert.equal(payment.owner_user_id,owner);assert.equal(payment.state,'paid');assert.equal(BigInt(payment.amount_fen),BigInt(expected.amountFen));assert.equal(BigInt(payment.points),BigInt(expected.points));}
  const tasks=(await db.query(`SELECT r.id,r.owner_user_id,r.state,h.owner_user_id AS reservation_owner,h.state AS charge_state,h.points,h.charged_points,
    COALESCE(a.allocated,0)::text AS allocated,COALESCE(a.charged,0)::text AS allocated_charge,COALESCE(a.foreign_lots,0)::int AS foreign_lots
    FROM bb_runs r JOIN bb_credit_reservations h ON h.run_id=r.id
    LEFT JOIN LATERAL (SELECT sum(x.points) allocated,sum(COALESCE(x.charged_points,0)) charged,
      count(*) FILTER(WHERE l.owner_user_id IS DISTINCT FROM r.owner_user_id) foreign_lots
      FROM bb_credit_allocations x JOIN bb_credit_lots l ON l.id=x.lot_id WHERE x.reservation_id=h.id) a ON true
    WHERE r.id=ANY($1::text[])`,[[succeededRun,failedRun]])).rows;
  assert.equal(tasks.length,2);
  for(const [id,state,chargeState,charged] of [[succeededRun,'succeeded','settled',27195n],[failedRun,'failed','released',0n]]){
    const task=tasks.find(row=>row.id===id);assert.ok(task);assert.equal(task.owner_user_id,owner);assert.equal(task.reservation_owner,owner);
    assert.equal(task.state,state);assert.equal(task.charge_state,chargeState);assert.equal(BigInt(task.points),27195n);assert.equal(BigInt(task.charged_points),charged);
    assert.equal(BigInt(task.allocated),27195n);assert.equal(BigInt(task.allocated_charge),charged);assert.equal(task.foreign_lots,0);
  }
  const artifacts=(await db.query('SELECT count(*)::int n FROM bb_review_artifacts WHERE run_id=$1 AND owner_user_id=$2',[succeededRun,owner])).rows[0];
  assert.equal(artifacts.n,3);
  return ['random account matches authenticated registration','three paid orders belong to the random account',
    'both task reservations and credit allocations belong to the random account','three synthetic Word artifacts belong to the random account'];
}

export async function runVerification(){
const startedAt=new Date().toISOString(),user='billing_qa_'+randomUUID().slice(0,8),send=client(),checks=[];
const check=(name,work)=>{work();checks.push(name);};
const post=async(path,body={})=>(await send('POST',path,body)).data;
const state=()=>post('/__billing-test/api/state');
const amount=(s,available,held)=>{assert.equal(BigInt(s.account.available_points),BigInt(available));assert.equal(BigInt(s.account.task_held_points),BigInt(held));};
const prepare=async()=>{const id=randomUUID(),s=await post('/__billing-test/api/review/prepare',{id});return{id,state:s};};
try{
  const denied=await new Promise((resolve,reject)=>{const request=httpRequest(apiURL+'/__billing-test/status',{headers:{host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});check('untrusted Host denied',()=>assert.equal(denied,403));
  await send('POST','/__billing-test/api/state',{}, {expected:401});checks.push('anonymous simulation denied');
  const registered=await post('/api/v1/auth/register',{username:user,password:'Synthetic-QA-2026!',accepted_terms_version:terms}),owner=registered.user_id;assert.ok(owner);
  await send('POST','/__billing-test/api/state',{}, {headers:{'x-bb-csrf':''},expected:403});checks.push('missing CSRF denied');
  await send('POST','/__billing-test/api/state',{}, {headers:{origin:'http://untrusted.example'},expected:403});checks.push('wrong Origin denied');
  amount(await state(),0,0);checks.push('random test account starts at zero');
  const first=await prepare();check('full review quote has automatic current price',()=>{assert.equal(first.state.tasks[0].quote.auto_charge,true);assert.equal(BigInt(first.state.tasks[0].quote.points),27195n);});
  await send('POST','/__billing-test/api/review/start',{id:first.id},{expected:402});amount(await state(),0,0);checks.push('zero balance rejects start without reservation');
  const subscription=await post('/api/v1/subscriptions',{request_id:randomUUID(),plan_id:'light',provider:'wechat'});
  check('subscription creates actual pending 199 yuan order',()=>{assert.equal(subscription.order.state,'pending');assert.equal(BigInt(subscription.order.amount_fen),19900n);});
  await post('/__billing-test/api/payment/outcome',{id:subscription.order.order_id,outcome:'paid',delivery:'query'});
  await post('/api/v1/commerce/topups/'+subscription.order.order_id+'/refresh');amount(await state(),21000,0);
  await post('/api/v1/commerce/topups/'+subscription.order.order_id+'/refresh');amount(await state(),21000,0);checks.push('subscription refresh grants exactly once');
  const topup=await post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'10000',provider:'wechat'});await post('/__billing-test/api/payment/outcome',{id:topup.order_id,outcome:'paid',delivery:'query'});await post('/api/v1/commerce/topups/'+topup.order_id+'/refresh');amount(await state(),31000,0);checks.push('100 yuan topup adds 10000 permanent points');
  let current=await post('/__billing-test/api/review/start',{id:first.id});amount(current,3805,27195);const runId=current.tasks.find(row=>row.id===first.id).run_id;assert.ok(runId);checks.push('start holds 27195 through real product submission');
  const foreign=client();await foreign('POST','/api/v1/auth/register',{username:'billing_qa_'+randomUUID().slice(0,8),password:'Synthetic-QA-2026!',accepted_terms_version:terms});
  await foreign('POST','/__billing-test/api/review/finish',{id:first.id,outcome:'succeeded'},{expected:404});checks.push('foreign account cannot complete task');
  current=await post('/__billing-test/api/review/finish',{id:first.id,outcome:'succeeded'});amount(current,3805,0);
  check('synthetic delivered Word produces real settled charge',()=>{const task=current.tasks.find(row=>row.id===first.id);assert.equal(task.state,'succeeded');assert.equal(task.charge_state,'settled');assert.equal(BigInt(task.charged_points),27195n);});
  current=await post('/__billing-test/api/review/start',{id:first.id});amount(current,3805,0);check('replay returns same run without double charge',()=>assert.equal(current.tasks.find(row=>row.id===first.id).run_id,runId));
  const secondTopup=await post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'30000',provider:'wechat'});await post('/__billing-test/api/payment/outcome',{id:secondTopup.order_id,outcome:'paid',delivery:'query'});await post('/api/v1/commerce/topups/'+secondTopup.order_id+'/refresh');amount(await state(),33805,0);
  const second=await prepare();current=await post('/__billing-test/api/review/start',{id:second.id});amount(current,6610,27195);
  current=await post('/__billing-test/api/review/finish',{id:second.id,outcome:'failed'});amount(current,33805,0);check('failed task releases real reservation',()=>assert.equal(current.tasks.find(row=>row.id===second.id).state,'failed'));
  const pool=new Pool({connectionString:pgBase+config().database});try{
    checks.push(...await verifyIsolatedAccountEvidence(pool,{owner,username:user,orders:[
      {id:subscription.order.order_id,amountFen:'19900',points:'21000'},{id:topup.order_id,amountFen:'10000',points:'10000'},
      {id:secondTopup.order_id,amountFen:'30000',points:'30000'}],succeededRun:runId,failedRun:current.tasks.find(row=>row.id===second.id).run_id}));
  }finally{await pool.end();}
  const proof={synthetic:true,realHttp:true,realPostgres:true,modelCallsPerformed:0,realPaymentCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),username:user,checks,passed:checks.length,failed:0};
  writeFileSync(join(runtime,'last-verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){writeFileSync(join(runtime,'last-verification.json'),JSON.stringify({synthetic:true,startedAt,finishedAt:new Date().toISOString(),username:user,checks,failed:1,error:String(error)},null,2)+'\n');throw error;}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await runVerification();
