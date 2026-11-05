import test from 'node:test';
import assert from 'node:assert/strict';
import {canReopenSandboxCheckout,prepareSandboxCheckout,withSandboxSession,sandboxOrderLifetimeMs} from './alipay-sandbox-order.mjs';

const instant=Date.parse('2026-11-05T04:00:00Z');
const provider={merchantId:'sandbox_test_merchant'};
const order=()=>({id:'bb_sandbox_original',merchant_id:provider.merchantId,currency:'CNY',amount_fen:1,expires_at:new Date(instant-1000).toISOString()});
const options={provider,now:()=>instant};
const observeState=state=>async value=>{value.state=state;value.receipt={state};};

test('checkout reuses the same live order and immutable expiry',async()=>{
  const value={};const observe=()=>assert.fail('A new live order does not require querying');
  assert.equal(await prepareSandboxCheckout(value,{...options,observe}),true);
  const first=value.order;
  assert.equal(first.amount_fen,1);assert.equal(Date.parse(first.expires_at),instant+sandboxOrderLifetimeMs);
  assert.equal(await prepareSandboxCheckout(value,{...options,observe,now:()=>instant+60000}),true);
  assert.equal(value.order,first);assert.equal(Date.parse(value.order.expires_at),instant+sandboxOrderLifetimeMs);
});

test('expired checkout queries the original order and never silently replaces it',async()=>{
  const original=order(),value={order:original,state:'pending'};let queried;
  assert.equal(await prepareSandboxCheckout(value,{...options,observe:async current=>{queried=current.order;await observeState('expired')(current);}}),false);
  assert.equal(queried,original);assert.equal(value.order,original);assert.equal(value.state,'expired');
  assert.equal(canReopenSandboxCheckout(value,instant),false);
});

test('replacement requires a fresh confirmed expired result, not a local deadline or cached receipt',async()=>{
  for(const state of ['pending','paid','unknown','refunded']){
    const original=order(),value={order:original,state:'expired',receipt:{state:'expired'}};
    assert.equal(await prepareSandboxCheckout(value,{...options,observe:observeState(state),replaceOrderId:original.id}),false);
    assert.equal(value.order,original);assert.equal(value.history,undefined);
  }
  const original=order(),value={order:original,state:'expired',receipt:{state:'expired'}};
  await assert.rejects(()=>prepareSandboxCheckout(value,{...options,replaceOrderId:original.id,observe:async()=>{throw Error('Network failed');}}),/Network failed/);
  assert.equal(value.order,original);
});

test('explicit replacement keeps old evidence and gives the new order a fresh thirty-minute expiry',async()=>{
  const original=order(),value={order:original,state:'unknown'};
  assert.equal(await prepareSandboxCheckout(value,{...options,observe:observeState('expired'),replaceOrderId:original.id}),true);
  assert.notEqual(value.order.id,original.id);assert.equal(value.state,'pending');
  assert.equal(Date.parse(value.order.expires_at),instant+sandboxOrderLifetimeMs);
  assert.deepEqual(value.history,[{order:original,receipt:{state:'expired'}}]);
  assert.equal(value.receipt,undefined);
  assert.equal(await prepareSandboxCheckout(value,{...options,observe:()=>assert.fail('Stale replacement must not query a new order'),replaceOrderId:original.id}),false);
});

test('double clicking replacement produces only one new order',async()=>{
  const original=order(),value={order:original,state:'expired'};let queries=0;
  const operation=()=>withSandboxSession(value,()=>prepareSandboxCheckout(value,{...options,replaceOrderId:original.id,observe:async current=>{
    queries++;await Promise.resolve();await observeState('expired')(current);
  }}));
  assert.deepEqual(await Promise.all([operation(),operation()]),[true,false]);
  assert.equal(queries,1);assert.equal(value.history.length,1);
});

test('a concurrent successful payment query prevents reopening the cashier',async()=>{
  const value={order:{...order(),expires_at:new Date(instant+600000).toISOString()},state:'pending'};
  const query=withSandboxSession(value,async()=>{await Promise.resolve();await observeState('paid')(value);});
  const checkout=withSandboxSession(value,()=>prepareSandboxCheckout(value,{...options,observe:()=>assert.fail('Paid order cannot be reopened')}));
  await query;assert.equal(await checkout,false);assert.equal(value.state,'paid');
});

test('a failed session action releases the next query',async()=>{
  const value={};
  const first=withSandboxSession(value,async()=>{throw Error('network error');});
  const second=withSandboxSession(value,async()=>42);
  await assert.rejects(first,/network error/);assert.equal(await second,42);
});
