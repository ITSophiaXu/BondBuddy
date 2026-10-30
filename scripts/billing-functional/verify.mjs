import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
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
const startedAt=new Date().toISOString(),user='billing_qa_'+randomUUID().slice(0,8),send=client(),checks=[];
const check=(name,work)=>{work();checks.push(name);};
const post=async(path,body={})=>(await send('POST',path,body)).data;
const state=()=>post('/__billing-test/api/state');
const amount=(s,available,held)=>{assert.equal(BigInt(s.account.available_points),BigInt(available));assert.equal(BigInt(s.account.task_held_points),BigInt(held));};
const prepare=async()=>{const id=randomUUID(),s=await post('/__billing-test/api/review/prepare',{id});return{id,state:s};};
try{
  const denied=await new Promise((resolve,reject)=>{const request=httpRequest(apiURL+'/__billing-test/status',{headers:{host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});check('untrusted Host denied',()=>assert.equal(denied,403));
  await send('POST','/__billing-test/api/state',{}, {expected:401});checks.push('anonymous simulation denied');
  await post('/api/v1/auth/register',{username:user,password:'Synthetic-QA-2026!',accepted_terms_version:terms});
  await send('POST','/__billing-test/api/state',{}, {headers:{'x-bb-csrf':''},expected:403});checks.push('missing CSRF denied');
  await send('POST','/__billing-test/api/state',{}, {headers:{origin:'http://untrusted.example'},expected:403});checks.push('wrong Origin denied');
  amount(await state(),0,0);checks.push('random test account starts at zero');
  const first=await prepare();check('full review quote has automatic current price',()=>{assert.equal(first.state.tasks[0].quote.auto_charge,true);assert.equal(BigInt(first.state.tasks[0].quote.points),27195n);});
  await send('POST','/__billing-test/api/review/start',{id:first.id},{expected:402});amount(await state(),0,0);checks.push('zero balance rejects start without reservation');
  const subscription=await post('/api/v1/subscriptions',{request_id:randomUUID(),plan_id:'light',provider:'wechat'});
  check('subscription creates actual pending 199 yuan order',()=>{assert.equal(subscription.order.state,'pending');assert.equal(BigInt(subscription.order.amount_fen),19900n);});
  await post('/api/v1/commerce/topups/'+subscription.order.order_id+'/refresh');amount(await state(),21000,0);
  await post('/api/v1/commerce/topups/'+subscription.order.order_id+'/refresh');amount(await state(),21000,0);checks.push('subscription refresh grants exactly once');
  const topup=await post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'10000',provider:'wechat'});await post('/api/v1/commerce/topups/'+topup.order_id+'/refresh');amount(await state(),31000,0);checks.push('100 yuan topup adds 10000 permanent points');
  let current=await post('/__billing-test/api/review/start',{id:first.id});amount(current,3805,27195);const runId=current.tasks.find(row=>row.id===first.id).run_id;assert.ok(runId);checks.push('start holds 27195 through real product submission');
  const foreign=client();await foreign('POST','/api/v1/auth/register',{username:'billing_qa_'+randomUUID().slice(0,8),password:'Synthetic-QA-2026!',accepted_terms_version:terms});
  await foreign('POST','/__billing-test/api/review/finish',{id:first.id,outcome:'succeeded'},{expected:404});checks.push('foreign account cannot complete task');
  current=await post('/__billing-test/api/review/finish',{id:first.id,outcome:'succeeded'});amount(current,3805,0);
  check('synthetic delivered Word produces real settled charge',()=>{const task=current.tasks.find(row=>row.id===first.id);assert.equal(task.state,'succeeded');assert.equal(task.charge_state,'settled');assert.equal(BigInt(task.charged_points),27195n);});
  current=await post('/__billing-test/api/review/start',{id:first.id});amount(current,3805,0);check('replay returns same run without double charge',()=>assert.equal(current.tasks.find(row=>row.id===first.id).run_id,runId));
  const secondTopup=await post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'30000',provider:'wechat'});await post('/api/v1/commerce/topups/'+secondTopup.order_id+'/refresh');amount(await state(),33805,0);
  const second=await prepare();current=await post('/__billing-test/api/review/start',{id:second.id});amount(current,6610,27195);
  current=await post('/__billing-test/api/review/finish',{id:second.id,outcome:'failed'});amount(current,33805,0);check('failed task releases real reservation',()=>assert.equal(current.tasks.find(row=>row.id===second.id).state,'failed'));
  const pool=new Pool({connectionString:pgBase+config().database});try{
    const demo=(await pool.query("SELECT u.id,COALESCE(sum(l.remaining-l.frozen) FILTER(WHERE l.expires_at IS NULL OR l.expires_at>now()),0)::text AS available FROM bb_users u LEFT JOIN bb_credit_lots l ON l.owner_user_id=u.id WHERE u.username='billing_tester' GROUP BY u.id")).rows[0];
    check('billing_tester remains at zero',()=>assert.equal(demo.available,'0'));
    const artifacts=(await pool.query('SELECT count(*)::int n FROM bb_review_artifacts WHERE run_id=$1',[runId])).rows[0];check('three synthetic Word artifacts recorded',()=>assert.equal(artifacts.n,3));
  }finally{await pool.end();}
  const proof={synthetic:true,realHttp:true,realPostgres:true,modelCallsPerformed:0,realPaymentCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),username:user,checks,passed:checks.length,failed:0};
  writeFileSync(join(runtime,'last-verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){writeFileSync(join(runtime,'last-verification.json'),JSON.stringify({synthetic:true,startedAt,finishedAt:new Date().toISOString(),username:user,checks,failed:1,error:String(error)},null,2)+'\n');throw error;}
