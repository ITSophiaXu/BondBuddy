import test from 'node:test';
import assert from 'node:assert/strict';
import {AUTOMATIC_PRICE_VERSION} from '@bondbuddy/contracts';
import {automaticTaskPath,billingTaskReturnTo,cancelBillingTask,configureBillingTaskRecovery,observeAutomaticQuotes,createBillingTask,readBillingTask,resumeBillingTask,runRecoverableBillingRequest} from './billing-task-recovery.js';

function memory(){const rows=new Map<string,string>();return {rows,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};}
const endpoint='/projects/p1/qa/runs',body={request_id:'answer-one',expected_revision:7,price_version:AUTOMATIC_PRICE_VERSION,expected_points:1218,scope_quote_id:'q1'},route='#qa?project=p1';
function waiting(store:ReturnType<typeof memory>,id:string){const key=[...store.rows.keys()].find(k=>k.endsWith(id))!,value=JSON.parse(store.getItem(key)!);store.setItem(key,JSON.stringify({...value,state:'needs_funds'}));}

test('task recovery rejects a different owner, tampered input, expired intent and arbitrary routes',async()=>{
  const store=memory(),now=Date.now(),task=await createBillingTask('owner',endpoint,body,{},route,store,now);
  assert.equal((await readBillingTask('owner',task.id,store,now))?.requestId,'answer-one');
  assert.equal(await readBillingTask('other',task.id,store,now),undefined);
  assert.equal(await readBillingTask('owner',task.id,store,now+24*3600*1000),undefined);
  const key=[...store.rows.keys()][0],copy=JSON.parse(store.getItem(key)!);copy.body.expected_revision=8;store.setItem(key,JSON.stringify(copy));
  assert.equal(await readBillingTask('owner',task.id,store),undefined);
  for(const path of ['/commerce/topups','/subscriptions','/auth/logout','/projects/p1/qa/runs?override=1','https://other/runs/execute'])assert.equal(automaticTaskPath(path),false);
  await assert.rejects(createBillingTask('owner',endpoint,body,{},'https://other',store));
});

test('payment resumes only the named original task with identical request and clears its receipt once',async()=>{
  const store=memory(),one=await createBillingTask('owner',endpoint,body,{'X-Capability':'v1'},route,store),two=await createBillingTask('owner',endpoint,{...body,request_id:'answer-two'}, {},route,store);
  waiting(store,one.id);waiting(store,two.id);
  const returnTo=await billingTaskReturnTo('owner',one.id,store);assert.ok(returnTo?.includes('resume_request='+one.id));
  let calls=0;const submit=async(path:string,snapshot:Record<string,unknown>,headers:Record<string,string>)=>{calls++;assert.equal(path,endpoint);assert.deepEqual(snapshot,body);assert.deepEqual(headers,{'X-Capability':'v1'});return {run_id:'same-run'};};
  assert.equal(await resumeBillingTask('owner',one.id,'#qa?project=other',submit,store),undefined);
  assert.deepEqual(await resumeBillingTask('owner',one.id,returnTo!,submit,store),{run_id:'same-run'});
  assert.equal(await resumeBillingTask('owner',one.id,returnTo!,submit,store),undefined);assert.equal(calls,1);
  assert.equal((await readBillingTask('owner',two.id,store))?.state,'needs_funds');
  await cancelBillingTask('owner',two.id,store);assert.equal(await billingTaskReturnTo('owner',two.id,store),undefined);
});

test('402 is recoverable, unknown results do not automatically restart, and old pricing is untouched',async()=>{
  const store=memory();Object.assign(globalThis,{localStorage:store,location:{hash:route}});configureBillingTaskRecovery(()=>'owner');
  const insufficient={status:402,code:'CREDITS_INSUFFICIENT'};
  await assert.rejects(runRecoverableBillingRequest('POST',endpoint,body,{},async()=>{throw insufficient;}),e=>e===insufficient);
  const task=JSON.parse([...store.rows.values()][0]);assert.equal(task.state,'needs_funds');assert.ok(await billingTaskReturnTo('owner',task.id,store));
  await cancelBillingTask('owner',task.id,store);
  await assert.rejects(runRecoverableBillingRequest('POST',endpoint,body,{},async()=>{throw new Error('connection lost');}));
  const unknown=JSON.parse([...store.rows.values()][0]);assert.equal(unknown.state,'unknown');assert.ok(await billingTaskReturnTo('owner',unknown.id,store));
  store.rows.clear();let calls=0;await runRecoverableBillingRequest('POST',endpoint,{...body,price_version:'legacy'}, {},async()=>{calls++;return {};});
  assert.equal(calls,1);assert.equal(store.rows.size,0);configureBillingTaskRecovery(()=>undefined);
});

test('a changed body cannot reuse a pending original request key',async()=>{
  const store=memory();await createBillingTask('owner',endpoint,body,{},route,store);
  await assert.rejects(createBillingTask('owner',endpoint,{...body,expected_revision:8},{},route,store));
});


test('reload after resuming or an unknown response replays the original request once, including concurrent returns',async()=>{
 for(const state of ['resuming','unknown'] as const){
  const store=memory(),task=await createBillingTask('owner',endpoint,body,{},route,store),key=[...store.rows.keys()][0];
  store.setItem(key,JSON.stringify({...task,state}));assert.ok(await billingTaskReturnTo('owner',task.id,store));let calls=0;
  const submit=async(path:string,request:Record<string,unknown>)=>{calls++;assert.equal(path,endpoint);assert.deepEqual(request,body);await Promise.resolve();return 'original-run';};
  const result=await Promise.all([resumeBillingTask('owner',task.id,route,submit,store),resumeBillingTask('owner',task.id,route,submit,store)]);
  assert.deepEqual(result,['original-run','original-run']);assert.equal(calls,1);assert.equal(await readBillingTask('owner',task.id,store),undefined);
 }
});


test('quote-only requests retain a hashed points requirement without changing the execution body',async()=>{
 const store=memory();Object.assign(globalThis,{localStorage:store,location:{hash:'#/projects/p1'}});configureBillingTaskRecovery(()=>'owner');
 observeAutomaticQuotes({quote:{quote_id:'quote-only',price_version:AUTOMATIC_PRICE_VERSION,points:20341}});
 const request={execution_request_id:'authoring-one',project_id:'p1',input_revision:3,quote_id:'quote-only'};
 await assert.rejects(runRecoverableBillingRequest('POST','/runs/execute',request,{},async()=>{throw {status:402,code:'CREDITS_INSUFFICIENT'};}));
 const key=[...store.rows.keys()][0],task=JSON.parse(store.getItem(key)!);assert.equal(task.requiredPoints,20341);assert.deepEqual(task.body,request);assert.equal(task.body.expected_points,undefined);
 task.requiredPoints=1;store.setItem(key,JSON.stringify(task));assert.equal(await readBillingTask('owner',task.id,store),undefined);configureBillingTaskRecovery(()=>undefined);
});

test('silent storage loss prevents the initial task submission',async()=>{
 const store=memory(),lossy={...store,setItem:()=>{}};
 await assert.rejects(createBillingTask('owner',endpoint,body,{},route,lossy),/任务尚未提交/);
});
