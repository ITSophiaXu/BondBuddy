import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../lib/platform.mjs';
import { Billing, taskCost } from '../lib/billing.mjs';
async function fixture(){const dir=join(ROOT,'qa','artifacts','billing-'+randomUUID());await mkdir(dir,{recursive:true});let now=new Date('2026-01-31T08:00:00Z');const b=new Billing(join(dir,'billing.json'),{now:()=>now});return {b,setNow:value=>now=new Date(value)};}
async function purchase(b,plan='personal'){const o=await b.createOrder('primary',{plan,idempotencyKey:randomUUID()});await b.order('primary',o.id,'sandbox-pay');return o;}

test('insufficient Q&A or attachment quota never suggests that buying points fixes it',async()=>{
  const {b}=await fixture();await purchase(b);
  for(const cost of [{qa:1001,documents:0,points:0},{qa:1,documents:41,points:0}])await assert.rejects(b.reserve(randomUUID(),'primary',cost),e=>e.code==='QUOTA_EXHAUSTED'&&e.message.includes('加购点数不增加问答次数或对话文件上传份数'));
  await assert.rejects(b.reserve(randomUUID(),'primary',{qa:0,documents:0,points:5}),e=>e.message.includes('可加购点数后继续'));
});
test('purchase needs only a plan; exact price, independent account quotas and idempotent payment',async()=>{
  const {b}=await fixture(),o=await purchase(b,'professional');assert.equal(o.amount,99900);assert(!JSON.stringify(o).includes('email'));assert(!JSON.stringify(o).includes('name'));
  await b.order('primary',o.id,'sandbox-pay');const v=await b.view();assert(!v.seats);assert.deepEqual(v.seat.quota.limit,{qa:2000,documents:80,points:12});
  await b.reserve('first','primary',taskCost('update'));await b.settle('first',true);assert.equal((await b.view()).seat.quota.available.points,8);
  await b.ensureAccount('second');assert.equal((await b.view('second')).seat.quota.available.points,0);assert.equal((await b.view('second')).orders.length,0);
});
test('concurrent reservations cannot overspend, failures release, retry charges once',async()=>{
  const {b}=await fixture();await purchase(b);
  const result=await Promise.allSettled(Array.from({length:6},(_,i)=>b.reserve('job'+i,'primary',taskCost('review'))));assert.equal(result.filter(r=>r.status==='fulfilled').length,4);
  assert.equal((await b.view()).seat.quota.available.points,0);await b.settle('job0',false);assert.equal((await b.view()).seat.quota.available.points,1);
  await b.reserve('job0','primary',taskCost('review'));await b.settle('job0',true);await b.settle('job0',true);assert.equal((await b.view()).seat.quota.used.points,1);
});
test('expiry, month-end clamp, upgrade preserving usage, add-on expiry and no rollover',async()=>{
  const {b,setNow}=await fixture();await purchase(b);assert.equal((await b.view()).seat.quota.endsAt,'2026-02-28T08:00:00.000Z');
  await b.reserve('j','primary',taskCost('review'));await b.settle('j',true);
  setNow('2026-02-14T08:00:00Z');const upgrade=await b.createOrder('primary',{type:'upgrade',idempotencyKey:randomUUID()});assert.equal(upgrade.amount,25000);await b.order('primary',upgrade.id,'sandbox-pay');assert.equal((await b.view()).seat.quota.available.points,11);
  const addon=await b.createOrder('primary',{type:'addon',quantity:2,idempotencyKey:randomUUID()});assert.equal(addon.amount,59800);await b.order('primary',addon.id,'sandbox-pay');assert.equal((await b.view()).seat.quota.available.points,19);
  setNow('2026-02-28T08:00:00Z');assert.equal((await b.view()).seat.quota.active,false);await assert.rejects(b.reserve('expired','primary',taskCost('review')),e=>e.code==='BILLING_REQUIRED');
  await purchase(b);assert.equal((await b.view()).seat.quota.available.points,4);assert.equal((await b.view()).seat.quota.used.points,0);
});
test('pending, cancelled, expired and stale orders cannot grant entitlements',async()=>{
  const {b,setNow}=await fixture(),input={plan:'personal',idempotencyKey:randomUUID()};const o=await b.createOrder('primary',input);assert.equal((await b.view()).seat.quota.active,false);assert.equal((await b.createOrder('primary',input)).id,o.id);
  const stale=await b.createOrder('primary',{...input,idempotencyKey:randomUUID()});await b.order('primary',o.id,'sandbox-pay');await assert.rejects(b.order('primary',stale.id,'sandbox-pay'),e=>e.code==='STALE_ORDER');
  const addon=await b.createOrder('primary',{type:'addon',quantity:1,idempotencyKey:randomUUID()});await b.order('primary',addon.id,'cancel');await assert.rejects(b.order('primary',addon.id,'sandbox-pay'),e=>e.code==='ORDER_CLOSED');
  const expired=await b.createOrder('primary',{type:'addon',quantity:1,idempotencyKey:randomUUID()});setNow('2026-01-31T09:00:00Z');await assert.rejects(b.order('primary',expired.id,'sandbox-pay'),e=>e.code==='ORDER_CLOSED');assert.equal((await b.order('primary',expired.id)).status,'expired');
});
test('document units and Q&A are reserved, cross-cycle completion never consumes renewed allowance',async()=>{
  const {b,setNow}=await fixture();await purchase(b);await b.reserve('draft','primary',taskCost('generate',3));let q=(await b.view()).seat.quota;assert.equal(q.available.qa,999);assert.equal(q.available.documents,37);assert.equal(q.available.points,4);
  setNow('2026-03-01T08:00:00Z');await purchase(b);await b.settle('draft',true);q=(await b.view()).seat.quota;assert.equal(q.used.qa,0);assert.equal(q.used.documents,0);
});
test('restart recovery releases abandoned reservations and settles completed results once',async()=>{
  const {b}=await fixture();await purchase(b);await b.reserve('done','primary',taskCost('review'));await b.reserve('lost','primary',taskCost('review'));await b.reconcile([{id:'done',status:'complete'}]);await b.reconcile([{id:'done',status:'complete'}]);assert.equal((await b.view()).seat.quota.available.points,3);
});
