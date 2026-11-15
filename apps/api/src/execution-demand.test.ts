import test from 'node:test';
import assert from 'node:assert/strict';
import {workpaperDemandKey,type ExecutionBatchDemand} from './execution-demand.js';
const fixture=(method='grouped_batch_v1'):ExecutionBatchDemand=>({items:Array.from({length:250},(_,i)=>({item_id:'item-'+i,attempt:1,manifest:{input:{workpaper:{execution:method,entry:{id:'item-'+i,kind:'file',sheet:'目录',folder:'整册',code:'entry-'+i,title:'项目'+i}}}}})),sourceReady:false,wholePlanReady:false,itemPlans:new Set(),groupReceipts:new Map(),progressive_plan:null,progressive_phase:null,state:'running',max_parallel:4});
test('250 shared source waiters expose one author, grouped source receipt exposes 32 independent authors',()=>{
 const b=fixture();assert.equal(b.items.filter(i=>workpaperDemandKey('b',i.item_id,b).key).length,1);
 b.sourceReady=true;assert.equal(b.items.filter(i=>workpaperDemandKey('b',i.item_id,b).key).length,32);
 const keys=b.items.map(i=>workpaperDemandKey('b',i.item_id,b).key).filter(Boolean);assert.equal(new Set(keys).size,32);
});
test('whole shared plan remains one author; caches and explicit retries become independent without altering membership',()=>{
 const b=fixture('shared_batch_v1');b.sourceReady=true;assert.equal(b.items.filter(i=>workpaperDemandKey('b',i.item_id,b).key).length,1);
 b.wholePlanReady=true;assert.equal(b.items.filter(i=>workpaperDemandKey('b',i.item_id,b).key).length,250);
 const g=fixture();g.sourceReady=true;g.items[1]!.attempt=2;g.itemPlans.add('item-2');assert.ok(workpaperDemandKey('b','item-1',g).key?.startsWith('item:'));assert.ok(workpaperDemandKey('b','item-2',g).key?.startsWith('render:'));
});
test('ordinary independent files are not collapsed into a shared whole-plan demand',()=>{
 const b=fixture('ordinary');assert.equal(new Set(b.items.map(i=>workpaperDemandKey('b',i.item_id,b).key)).size,250);
});
