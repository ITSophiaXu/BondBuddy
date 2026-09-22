import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Billing } from '../lib/billing.mjs';
import { Billing as LegacyBilling } from '../lib/legacy-billing.mjs';
import { actualCredits,updateCoefficient,parseCoefficient,classifyTask,changedPeriods,estimateCredits,CREDIT_RULES } from '../lib/credit-pricing.mjs';
const snapshot={prices:{perMillion:{input:10,cached:1,output:30}},classification:{coefficient:5},reservation:1000};
const cost=n=>({credits:n,snapshot:{...snapshot,reservation:n}});
const completed=n=>({status:'complete',metering:{complete:true,events:[{id:randomUUID(),type:'model',verified:true,usage:{inputTokens:n*200,cachedInputTokens:0,outputTokens:0}}]}});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'bond-credits-'));let now=new Date('2026-09-01T00:00:00Z');const b=new Billing(join(dir,'billing.json'),{now:()=>now});await b.ensureAccount('alice',{created:true});return {b,dir,setNow:s=>now=new Date(s)};}
async function recharge(b,id='alice',amountCny=500){const o=await b.createOrder(id,{type:'recharge',amountCny,idempotencyKey:randomUUID()});await b.order(id,o.id,'sandbox-pay');return o;}
async function spend(b,id,n,key=randomUUID()){await b.reserve(key,id,cost(n));await b.settle(key,true,completed(n));return key;}
test('coefficient anchors, every migration pair and first-parse formats agree with proposal',()=>{
 assert.deepEqual([1,2,3,4].map(periods=>updateCoefficient({periods,source:'SH-P',target:'SH-P'})),[5,10,15,20]);
 for(const source of CREDIT_RULES.products)for(const target of CREDIT_RULES.products){const k=updateCoefficient({periods:2,source:source.id,target:target.id});assert(k>0&&k<=200);}
 assert.equal(updateCoefficient({periods:2,source:'SH-P',target:'SZ-P'}),11.5);
 assert.equal(updateCoefficient({periods:2,source:'SH-P',target:'MTN'}),17);
 assert.equal(updateCoefficient({history:'none',periods:4,target:'SH-P'}),70);
 assert.equal(parseCoefficient('F04'),2.6);assert.equal(parseCoefficient('F08','significant_repairable'),6);
});
test('new financial periods come from target minus history, repeated evidence does not multiply periods',()=>{
 const c={reportingWindow:{periods:[{end:'2024-12-31'},{end:'2025-12-31'},{end:'2026-06-30'}]}};
 const docs=[{role:'historical',records:[{text:'财务报表：2024年度、2025年度'}]},{role:'audit',records:[{text:'2023年度2024年度2025年度'}]}];
 assert.equal(changedPeriods(c,docs).count,1);assert.equal(changedPeriods(c,[...docs,...docs]).count,1);
});
test('actual cost uses cache rate once, deduplicates events and rounds only total',()=>{
 const event={id:'provider-request',verified:true,type:'model',usage:{inputTokens:100000,cachedInputTokens:50000,outputTokens:20000}};
 assert.equal(actualCredits(snapshot,[event,event]).credits,575);
 assert.equal(actualCredits(snapshot,[{...event,reused:true}]).credits,0);
 assert.throws(()=>actualCredits(snapshot,[{...event,verified:false}]),e=>e.code==='METERING_PENDING');
 assert.throws(()=>actualCredits(snapshot,[{...event,usage:{...event.usage,cachedInputTokens:100001}}]),e=>e.code==='METERING_PENDING');
});
test('registration grant is once per account and balances stay private',async()=>{
 const {b}=await fixture();await b.ensureAccount('alice',{created:true});assert.equal((await b.view('alice')).wallet.available,2000);
 await b.ensureAccount('bob',{created:true});await recharge(b);assert.equal((await b.view('bob')).wallet.available,2000);assert.equal((await b.view('bob')).orders.length,0);
});
test('equal balance starts; atomic concurrent reservations cannot overspend; actual cost refunds and caps',async()=>{
 const {b}=await fixture();const results=await Promise.allSettled(Array.from({length:5},(_,i)=>b.reserve('r'+i,'alice',cost(500))));assert.equal(results.filter(r=>r.status==='fulfilled').length,4);assert.equal((await b.view('alice')).wallet.available,0);
 const r=await b.settle('r0',true,completed(350));assert.equal(r.charged,350);assert.equal(r.released,150);
 const over=await b.settle('r1',true,completed(800));assert.equal(over.charged,500);assert.equal(over.overrun,300);
 await b.settle('r1',true,completed(800));assert.equal((await b.view('alice')).wallet.spent,850);
 await b.settle('r2',false,{status:'cancelled'});await b.settle('r3',false,{status:'failed'});assert.equal((await b.view('alice')).wallet.available,1150);
});
test('unknown usage freezes for reconciliation and never becomes estimated spending',async()=>{
 const {b}=await fixture();await b.reserve('unknown','alice',cost(500));assert.equal((await b.settle('unknown',true,{status:'complete'})).state,'pending_metering');assert.equal((await b.view('alice')).wallet.spent,0);
 await b.reconcile([{id:'unknown',...completed(200)}]);assert.equal((await b.view('alice')).wallet.spent,200);
 await b.reserve('lost','alice',cost(300));await b.reconcile([]);assert.equal((await b.view('alice')).wallet.frozen,0);
});
test('frozen rewards survive expiry and platform failures compensate expired credits',async()=>{
 const {b,setNow}=await fixture();await b.reserve('expiry','alice',cost(1000));setNow('2026-10-02T00:00:00Z');assert.equal((await b.view('alice')).wallet.available,0);
 await b.settle('expiry',false,{status:'failed'});assert.equal((await b.view('alice')).wallet.available,1000);
});
test('packs, payment replay and prorated partial refunds preserve paid lots',async()=>{
 const {b}=await fixture(),o=await recharge(b);assert.equal(o.amount,50000);assert.equal(o.credits,52500);await b.order('alice',o.id,'sandbox-pay');assert.equal((await b.view('alice')).wallet.paid,52500);
 const key=randomUUID(),refund=await b.refund('alice',o.id,{credits:42000,idempotencyKey:key});assert.equal(refund.amount,40000);assert.deepEqual(await b.refund('alice',o.id,{credits:42000,idempotencyKey:key}),refund);
 assert.equal((await b.view('alice')).wallet.paid,10500);await assert.rejects(b.refund('alice',o.id,{credits:10501,idempotencyKey:randomUUID()}));
 assert.equal((await b.view('alice')).wallet.lots.find(l=>l.source==='purchase').expiresAt,null);
 await assert.rejects(b.order('someone-else',o.id,'sandbox-pay'),e=>e.status===404);
});
test('daily reward is next-day only, idempotent and monthly capped at 400',async()=>{
 const {b,setNow}=await fixture();await recharge(b,'alice',2000);
 for(let d=1;d<=22;d++){setNow(`2026-09-${String(d).padStart(2,'0')}T01:00:00Z`);await spend(b,'alice',100);}
 setNow('2026-09-23T01:00:00Z');let v=await b.view('alice');assert.equal(v.activity.monthlyReward,400);v=await b.view('alice');assert.equal(v.activity.monthlyReward,400);
});
test('invitation activation and paid reward require use, observation and no refund',async()=>{
 const {b,setNow}=await fixture(),code=(await b.view('alice')).invitation.code;
 await b.ensureAccount('bob',{created:true,inviteCode:code});await spend(b,'bob',500);assert.equal((await b.view('alice')).wallet.available,3000);assert.equal((await b.view('bob')).wallet.available,2000);
 await recharge(b,'bob');await spend(b,'bob',3000);assert.equal((await b.view('alice')).invitation.pending,1);
 setNow('2026-09-16T01:00:00Z');assert.equal((await b.view('alice')).wallet.lots.filter(l=>l.source==='invite_paid').length,1);await b.view('alice');assert.equal((await b.view('alice')).wallet.lots.filter(l=>l.source==='invite_paid').length,1);
 await b.ensureAccount('carol',{created:true,inviteCode:code});const o=await recharge(b,'carol');await spend(b,'carol',4000);await b.refund('carol',o.id,{credits:1,idempotencyKey:randomUUID()});setNow('2026-10-02T00:00:00Z');assert.equal((await b.view('alice')).wallet.lots.filter(l=>l.source==='invite_paid').length,1);
});
test('legacy subscriptions and in-flight charges are preserved without 1:1 conversion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bond-legacy-')),path=join(dir,'billing.json'),now=()=>new Date('2026-09-01T00:00:00Z'),old=new LegacyBilling(path,{now});
 const o=await old.createOrder('primary',{plan:'personal',idempotencyKey:randomUUID()});await old.order('primary',o.id,'sandbox-pay');await old.reserve('old-running','primary',{qa:0,documents:0,points:1});
 const b=new Billing(path,{now});await b.reconcile([{id:'old-running',status:'complete'}]);assert.equal((await b.view()).seat.quota.legacy.available.points,3);
 await b.reserve('old-benefit','primary',{...cost(9000),legacyCost:{qa:0,documents:0,points:2}});await b.settle('old-benefit',true,completed(9000));assert.equal((await b.view()).wallet.available,2000);assert.equal((await b.view()).seat.quota.legacy.available.points,1);
 assert.equal(JSON.parse(await readFile(path+'.pre-credits-backup.json','utf8')).version,1);
});
