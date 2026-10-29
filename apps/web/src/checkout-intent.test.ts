import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutIntentKey,checkoutPending,readCheckoutIntent,submitCheckoutIntent,observeCheckoutOrder,type CheckoutChoice,type CheckoutIntent,type CheckoutOrder} from './checkout-intent.js';

function fixture(){
  const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
  const pending=new Map<string,Promise<unknown>>();
  const lock=<T>(name:string,work:()=>Promise<T>)=>{const next=(pending.get(name)??Promise.resolve()).catch(()=>{}).then(work);pending.set(name,next);return next;};
  return{rows,storage,lock};
}
const choice:CheckoutChoice={kind:'topup',provider:'wechat',amount_fen:1218,project_id:'project-one'};
const order:CheckoutOrder={order_id:'original-order',provider:'wechat',amount_fen:1218,points:1218,state:'pending'};

test('unknown checkout retains its original key and body across reload, time and general errors',async()=>{
  const env=fixture(),requests:CheckoutIntent[]=[];
  await assert.rejects(submitCheckoutIntent('owner',choice,undefined,async intent=>{requests.push(intent);throw {status:503};},env));
  const original=readCheckoutIntent('owner',env.storage)!;assert.equal(checkoutPending(original),true);
  // The business order may have expired locally; its unknown channel outcome is not cleared.
  env.storage.setItem(checkoutIntentKey('owner'),JSON.stringify({...original,created_at:1}));
  await assert.rejects(submitCheckoutIntent('owner',undefined,undefined,async intent=>{requests.push(intent);throw {status:409};},env));
  const saved=await submitCheckoutIntent('owner',undefined,undefined,async intent=>{requests.push(intent);return order;},env);
  assert.deepEqual(requests.map(r=>r.request_id),[original.request_id,original.request_id,original.request_id]);
  assert.deepEqual(requests.map(r=>r.choice),[choice,choice,choice]);assert.equal(saved.order!.order_id,order.order_id);
  assert.equal(readCheckoutIntent('another-owner',env.storage),undefined);
});

test('concurrent tabs reuse one intent; a changed plan, provider or amount never reuses its key',async()=>{
  const env=fixture(),requests:CheckoutIntent[]=[];
  const submit=async(intent:CheckoutIntent)=>{requests.push(intent);return order;};
  const [one,two]=await Promise.all([submitCheckoutIntent('owner',choice,undefined,submit,env),submitCheckoutIntent('owner',choice,undefined,submit,env)]);
  assert.equal(one.request_id,two.request_id);assert.equal(requests[1].order?.order_id,order.order_id);
  for(const changed of [{...choice,amount_fen:49900},{...choice,provider:'alipay' as const},{kind:'subscription' as const,plan_id:'professional' as const,provider:'wechat' as const}])
    await assert.rejects(submitCheckoutIntent('owner',changed,undefined,submit,env),/已有原付款待核对/);
  assert.equal(requests.length,2);assert.equal(readCheckoutIntent('owner',env.storage)!.request_id,one.request_id);
});

test('subscription renewal recovery keeps the original subscription endpoint and plan',async()=>{
  const env=fixture(),renewal:CheckoutChoice={kind:'subscription',subscription_id:'subscription-one',plan_id:'professional',provider:'wechat'};
  await assert.rejects(submitCheckoutIntent('owner',renewal,undefined,async()=>{throw Error('lost');},env));
  const old=readCheckoutIntent('owner',env.storage)!;
  await assert.rejects(submitCheckoutIntent('owner',{...renewal,subscription_id:undefined},undefined,async()=>order,env),/已有原付款待核对/);
  const result=await submitCheckoutIntent('owner',undefined,undefined,async intent=>{assert.deepEqual(intent.choice,renewal);return{...order,amount_fen:49900,points:55000};},env);
  assert.equal(result.request_id,old.request_id);
});

test('an accepted subscription order keeps its historical amount and points across catalog changes',async()=>{
  const env=fixture(),subscription:CheckoutChoice={kind:'subscription',plan_id:'light',provider:'wechat'};
  const historical={...order,amount_fen:18900,points:20500};
  const original=await submitCheckoutIntent('owner',subscription,undefined,async()=>historical,env);
  assert.equal(readCheckoutIntent('owner',env.storage)!.order!.amount_fen,18900);
  const paid=await observeCheckoutOrder('owner',{...historical,state:'paid'},env);
  assert.equal(paid!.request_id,original.request_id);assert.equal(paid!.order!.points,20500);
  await assert.rejects(observeCheckoutOrder('owner',{...historical,state:'paid',amount_fen:19900,points:21000},env));
  assert.equal(readCheckoutIntent('owner',env.storage)!.order!.amount_fen,18900);
});

test('recovery from another task keeps the first payment task context',async()=>{
  const env=fixture(),context={project_id:'project-one',return_to:'#qa?project=project-one',resume_request:'waiting-one'};
  await assert.rejects(submitCheckoutIntent('owner',choice,undefined,async()=>{throw Error('lost');},env,context));
  const result=await submitCheckoutIntent('owner',choice,undefined,async()=>order,env,{project_id:'project-two',return_to:'#qa?project=project-two',resume_request:'waiting-two'});
  assert.deepEqual(result.context,context);
});

test('only a matching server-confirmed terminal order permits a new explicitly observed purchase',async()=>{
  const env=fixture(),saved=await submitCheckoutIntent('owner',choice,undefined,async()=>order,env);
  await observeCheckoutOrder('owner',{...order,order_id:'other-order',state:'paid'},env);
  assert.equal(checkoutPending(readCheckoutIntent('owner',env.storage)),true);
  await assert.rejects(observeCheckoutOrder('owner',{...order,amount_fen:1,state:'paid'},env));
  await observeCheckoutOrder('owner',{...order,state:'paid'},env);assert.equal(checkoutPending(readCheckoutIntent('owner',env.storage)),false);
  const stale=await submitCheckoutIntent('owner',choice,undefined,async intent=>{assert.equal(intent.request_id,saved.request_id);return{...order,state:'paid'};},env);
  assert.equal(stale.request_id,saved.request_id);
  const newer=await submitCheckoutIntent('owner',{...choice,amount_fen:5000},saved.request_id,async intent=>{
    assert.notEqual(intent.request_id,saved.request_id);return{...order,order_id:'new-order',amount_fen:5000,points:5000};
  },env);
  await observeCheckoutOrder('owner',{...order,state:'paid'},env);assert.equal(readCheckoutIntent('owner',env.storage)!.request_id,newer.request_id);
});

test('corrupted or lossy storage and mismatched acknowledgements do not permit another payment',async()=>{
  const env=fixture();let calls=0;
  await assert.rejects(submitCheckoutIntent('owner',choice,undefined,async()=>{calls++;return order;},{...env,storage:{...env.storage,setItem:()=>{}}}));assert.equal(calls,0);
  env.storage.setItem(checkoutIntentKey('owner'),'{broken');await assert.rejects(submitCheckoutIntent('owner',choice,undefined,async()=>{calls++;return order;},env));assert.equal(calls,0);
  env.rows.clear();await assert.rejects(submitCheckoutIntent('owner',choice,undefined,async()=>({...order,points:1219}),env));
  assert.equal(checkoutPending(readCheckoutIntent('owner',env.storage)),true);assert.equal(readCheckoutIntent('owner',env.storage)!.order,undefined);
});
